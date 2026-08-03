import { z } from "zod";
import { getModel, DEFAULT_BASE_URLS, type Provider } from "@/lib/registry";
import {
  runAgentLoop,
  type AgentTools,
  type ChatMessage,
  type Db,
  type Model,
  type QueuedReport,
} from "@/lib/agent/loop";
import {
  artifactCarrierPayload,
  insertPendingArtifact,
  settleReport,
} from "@/lib/artifacts/db";
import { createRunDb } from "@/lib/agent/run-db";
import { mapStartRunError } from "@/lib/agent/start-run-error";
import { DEEP_RESEARCH_SYSTEM } from "@/lib/agent/prompt";
import { createSourceRegistry, type SourceRegistry } from "@/lib/agent/sources";
import { createOpenAiCompatModel } from "@/lib/agent/models/openai-compat";
import { createAnthropicModel } from "@/lib/agent/models/anthropic";
import { webSearch } from "@/lib/agent/tools/web-search";
import { fetchPage } from "@/lib/agent/tools/fetch-page";
import { isAllowedBaseUrl } from "@/lib/keys/base-url";
import { filterForwardedCookies } from "@/lib/net/forward-cookie";

// Re-export the DI chunk type the 02-04 seam test imports from this module.
export type { ModelChunk } from "@/lib/agent/loop";

/**
 * POST /api/agent/run — the single-turn streaming research run route (Phase 2).
 *
 * Runtime + budget: nodejs (node:crypto AES-GCM, the openai SDK, and the 300s
 * maxDuration all require the Node runtime — never edge). maxDuration=300 is set
 * ONLY on this route (Fluid Compute), giving the loop headroom under the 240s
 * self-budget the agent loop (02-05) will enforce.
 *
 * SEAM CONTRACT (consumed by 02-05): the think→act→observe tool loop replaces the
 * single `model.run(...)` iteration inside `runTurn`, reusing the injected `send`
 * + `db`. `deriveChatTitle`, `createSseSender`, and `runTurn` are exported as
 * pure / dependency-injected units so the whole run lifecycle is unit-testable
 * (tests/title.test.ts, tests/sse.test.ts) without a live provider or DB.
 *
 * MONEY CORRECTNESS: the ONLY credit-debit path is the `start_run` SECURITY
 * DEFINER RPC (service-role, explicit p_user_id). Every precondition that can
 * fail runs BEFORE the debit; any throw after the debit but before the first
 * model call refunds via `refund_run` (idempotent). A client disconnect never
 * refunds and never aborts the loop (Pitfall 3 / D-25 / CHAT-08).
 *
 * SECRET HYGIENE: the decrypted key and any raw provider error body never appear
 * in an SSE frame or client-facing response; provider errors are mapped to human
 * copy and the detail is `console.error`-logged server-side only (KEY-03).
 *
 * Heavy deps (openai, @vercel/functions, the supabase clients, crypto) are
 * dynamic-`import()`ed INSIDE `POST` so this module imports cleanly under Vitest
 * (mirrors the render-pdf lazy-import discipline; env.ts returns undefined under
 * the runner, so a top-level supabase/crypto import would otherwise be brittle).
 */

export const runtime = "nodejs";
export const maxDuration = 300;

// ============================ SSE headers ============================
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

// ============================ Title (CHAT-02) ============================
const MAX_TITLE = 60;

/**
 * Truncation-only chat title — NO model/LLM call (CHAT-02 forbids an LLM title).
 * Collapses whitespace to single spaces, trims, caps at 60 chars with a trailing
 * ellipsis, and returns a stable non-empty fallback for empty input.
 */
export function deriveChatTitle(firstMessage: string): string {
  const normalized = (firstMessage ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "New chat";
  if (normalized.length <= MAX_TITLE) return normalized;
  return normalized.slice(0, MAX_TITLE - 1).trimEnd() + "…";
}

// ============================ SSE sender (Pitfall 3) ============================
export interface SseSender {
  send(event: string, data: unknown): void;
  ping(): void;
  readonly alive: boolean;
}

/**
 * Guarded SSE writer. Every enqueue is wrapped so a client-gone `controller`
 * (tab close / refresh / a throwing enqueue) flips `alive` to false and turns all
 * further sends into no-ops WITHOUT throwing — so the server-side loop keeps
 * persisting to Postgres regardless of the stream's health (CHAT-08).
 */
export function createSseSender(controller: {
  enqueue(chunk: Uint8Array): void;
}): SseSender {
  const enc = new TextEncoder();
  let alive = true;
  const guarded = (text: string): void => {
    if (!alive) return;
    try {
      controller.enqueue(enc.encode(text));
    } catch {
      alive = false; // client gone — never rethrow (Pitfall 3)
    }
  };
  return {
    send(event, data) {
      guarded(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    ping() {
      guarded(": ping\n\n");
    },
    get alive() {
      return alive;
    },
  };
}

// ============================ runTurn seam ============================
// The run-lifecycle DI types (Db / Model / ChatMessage / ModelChunk / UsageEventRow)
// now live in lib/agent/loop.ts — the single source of truth the loop and this
// route share. runTurn keeps its exported shape (tests/sse.test.ts) but delegates
// to runAgentLoop.
export interface RunTurnOpts {
  send: (event: string, data: unknown) => void;
  db: Db;
  model: Model;
  chatId: string;
  runId: string;
  userId: string;
  modelId: string;
  assistantMsgId: string;
  history: ChatMessage[];
  /** Per-run source registry (D-35) — instantiated once per POST, threaded
   *  into the loop so [n] numbering lives server-side for the whole run. */
  sources?: SourceRegistry;
  /** Mutable queued-report slot (D-44) — a create_pdf_report call records
   *  intent here; the deferred settle reads it after the run is terminal. */
  report?: { queued?: QueuedReport };
}

/** The default tool surface: real SerpAPI search + SSRF-guarded page fetch. */
const DEFAULT_TOOLS: AgentTools = {
  web_search: (query) => webSearch(query),
  fetch_page: (url) => fetchPage(url),
};

/**
 * The 02-04 seam, preserved: `runTurn` now DELEGATES to the think→act→observe
 * loop (02-05), reusing the SAME injected `send` / `db` / `model` and adding the
 * default tools + real clock. A model that requests no tools (the sse.test fake)
 * takes the single-final-answer path inside the loop — token/usage/done + one
 * persisted assistant message — so tests/sse.test.ts + tests/title.test.ts stay
 * green. A `send` that no-ops because the client is gone never alters persistence
 * or control flow (CHAT-08).
 */
export async function runTurn(opts: RunTurnOpts): Promise<void> {
  await runAgentLoop({ ...opts, tools: DEFAULT_TOOLS });
}

// ============================ Provider-history hygiene (D-57 / D-59) ============================
/**
 * Pure filter applied to persisted message rows before they are replayed into
 * provider history. Exported so tests/history-filter.test.ts and
 * tests/anthropic-model.test.ts can pin the cache-breakpoint POSITIONS against
 * the REAL filter output (AI-SPEC New Risk #2), not a hand-built literal.
 *
 * Both predicates stay adjacent in ONE loop (never a server-side .neq()) so
 * the two reasons for dropping a row read together (Pitfall 3).
 */
export function filterProviderHistory(
  rows: Array<{ role: string; content: string | null }>,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const r of rows) {
    // D-57 (E1): persisted role='tool' rows are display-only status lines —
    // JSON content, no tool_call_id. Strict providers 400 on them.
    if (r.role === "tool") continue;
    // D-59 (E1b): a run killed between the assistant-row insert and the
    // terminal write leaves content='' (or null), which Anthropic rejects as
    // an empty text block (also documented as un-cacheable).
    if ((r.content ?? "").trim().length === 0) continue;
    out.push({ role: r.role, content: r.content as string });
  }
  // Note: filtering tool rows can leave two consecutive same-role user
  // messages — that is fine; Anthropic combines them into one turn.
  return out;
}

// ============================ Self-fetch origin (Correction C3) ============================
/**
 * Resolve the origin for the deferred render self-fetch.
 *
 * TWO constraints pull against each other here.
 *
 * (1) Correction C3: the origin MUST come from the INCOMING request — never
 *     VERCEL_URL (documented incompatible with Standard Deployment Protection)
 *     and never VERCEL_PROJECT_PRODUCTION_URL (would point a preview's render at
 *     production). `x-forwarded-host` is what Vercel's edge sets to the host the
 *     client actually requested (RESEARCH Pattern 3).
 *
 * (2) Review CR-04: the POST to that origin carries the caller's Cookie header,
 *     including the live Supabase session token. Deriving the destination of a
 *     credential from an unvalidated, client-settable header is the classic
 *     host-header-injection shape.
 *
 * Both are satisfied by keeping the request as the SOURCE of the host but
 * requiring the result to be VOUCHED FOR before a credential can ride on it.
 * The env vars below are used only as allowlist entries, never as the origin, so
 * C3 still holds: a preview never resolves to production, and Deployment
 * Protection still sees the host the client used.
 *
 * Anything unrecognised falls back to `new URL(req.url).origin` — the origin the
 * function itself was invoked on, which is not attacker-chosen.
 */
function isLocalHostname(hostPort: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(hostPort);
}

export function originOf(req: Request): string {
  const h = req.headers;
  const self = new URL(req.url);
  const fallback = self.origin;

  const candidate = (h.get("x-forwarded-host") ?? h.get("host") ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (!candidate) return fallback; // vercel dev without x-forwarded-*

  const local = isLocalHostname(candidate);
  const allowed =
    // The host this function was actually invoked on (covers `vercel dev`,
    // `next dev`, and any case where host == the real deployment host).
    candidate === self.host.toLowerCase() ||
    local ||
    // Vercel deployment + branch/preview hosts.
    /^[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app(:\d+)?$/.test(candidate) ||
    // Explicitly configured hosts, when present.
    [
      process.env.NEXT_PUBLIC_SITE_HOST,
      process.env.VERCEL_BRANCH_URL,
      process.env.VERCEL_URL,
      process.env.VERCEL_PROJECT_PRODUCTION_URL,
    ]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.trim().toLowerCase())
      .includes(candidate);

  if (!allowed) {
    // Not fatal: the render still happens, just against our own origin.
    console.error("[agent/run] refused an un-vouched forwarded host for the render self-fetch");
    return fallback;
  }

  // Never downgrade a session cookie onto plaintext http off-box. Local dev is
  // the only place http is allowed.
  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  if (local) return `${proto === "https" ? "https" : "http"}://${candidate}`;
  return `https://${candidate}`;
}

// ============================ Request body ============================
const bodySchema = z.object({
  chatId: z.string().uuid().nullable(),
  message: z.string().trim().min(1),
  modelId: z.string().min(1),
  // Saturation fallback: an EXPLICIT opt-in to switch this existing chat's model
  // (only honored when true — a normal send keeps the "no mid-chat switch" rule).
  switchModel: z.boolean().optional(),
});

/** One-shot SSE response that emits a single error + done, then closes. */
function sseErrorResponse(
  code: string,
  message: string,
  createdChatId?: string,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const s = createSseSender(controller);
      if (createdChatId) s.send("chat_created", { chatId: createdChatId });
      s.send("error", { code, message });
      s.send("done", { runId: null, status: "failed" });
      try {
        controller.close();
      } catch {
        /* client gone */
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

export async function POST(req: Request): Promise<Response> {
  // Heavy deps loaded per-request so the module imports cleanly under Vitest.
  const [{ createClient }, { createServiceClient }, { decryptKey }, { waitUntil }] =
    await Promise.all([
      import("@/lib/supabase/server"),
      import("@/lib/supabase/service"),
      import("@/lib/crypto"),
      import("@vercel/functions"),
    ]);

  // Deferred-render capture (Correction C3): BOTH values are read at request
  // time, before the stream starts — waitUntil runs after the response closes
  // and re-reading a consumed request is unsafe. The forwarded cookie does
  // double duty: it satisfies Vercel deployment protection AND carries the
  // Supabase session the render route's auth check (D-40) needs. It is only ever
  // sent to an origin `originOf` vouched for — see CR-04 there.
  //
  // Residual #2 (T-03-12-02): and it is NARROWED to just those two families
  // before it leaves — `_vercel_jwt` plus every `sb-`-prefixed cookie (the
  // Supabase set is CHUNKED, hence a prefix). Third-party cookies no longer
  // cross the trust boundary alongside the full report body. See
  // lib/net/forward-cookie.ts for why this is superset-preserving by
  // construction and therefore cannot break authenticated rendering.
  const renderOrigin = originOf(req);
  const forwardCookie = filterForwardedCookies(req.headers.get("cookie"));

  // (a) Identity — user-scoped client, IDENTITY ONLY (never the debit path).
  const supabase = await createClient();
  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{
      data: { claims?: { sub?: string } } | null;
    }>;
  };
  let userId: string | undefined;
  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    userId = data?.claims?.sub;
  } else {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
  }
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // (b) Validate the body.
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const message = parsed.message;

  // (c) Service-role client — ALL run-lifecycle DB work flows through it.
  const svc = createServiceClient();

  // Resolve the chat + effective model WITHOUT writing anything yet.
  let chatId = parsed.chatId;
  let modelId = parsed.modelId;
  let createdNewChat = false;

  if (chatId) {
    const { data: chat, error } = await svc
      .from("chats")
      .select("id, model_id")
      .eq("id", chatId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      console.error("[agent/run] chat read failed:", error);
      return sseErrorResponse("db_error", "Could not open that chat.");
    }
    if (!chat) return sseErrorResponse("not_found", "Chat not found.");
    // Default: no mid-chat model switch (use the stored model). ONLY an explicit
    // saturation switch (switchModel:true) honors the client-supplied modelId; an
    // invalid target still falls through to the registry validation below.
    modelId = parsed.switchModel ? parsed.modelId : chat.model_id;
  }

  // (b2) Validate the effective model against the registry (T-04-07). The
  // Phase-2 anthropic rejection is GONE (D-48): claude-* models now run through
  // the anthropic-native wrapper picked by the model factory below.
  const spec = getModel(modelId);
  if (!spec || spec.selectable === false) {
    return sseErrorResponse(
      "bad_model",
      "That model is not available for research runs.",
    );
  }
  const provider: Provider = spec.provider;

  // Persist the switch so a plain retry no longer re-hits the saturated model.
  // Chat metadata only (RLS-scoped by user_id) — NOT a ledger/RPC change.
  if (chatId && parsed.switchModel) {
    await svc
      .from("chats")
      .update({ model_id: modelId })
      .eq("id", chatId)
      .eq("user_id", userId);
  }

  // (d) PRECONDITIONS — all BEFORE the debit (no orphan, no debit on failure).
  // (i) key row — ciphertext columns require the service-role client (REVOKE'd).
  const { data: keyRow, error: keyErr } = await svc
    .from("user_api_keys")
    .select("base_url, iv, ct, tag")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (keyErr) {
    console.error("[agent/run] key read failed:", keyErr);
    return sseErrorResponse("db_error", "Could not read your saved keys.");
  }
  if (!keyRow) {
    return sseErrorResponse(
      "no_key",
      `Add a ${provider} key in Settings before running a research chat.`,
    );
  }
  // (ii) decrypt — run handler ONLY.
  let apiKey: string;
  try {
    apiKey = decryptKey(keyRow.ct, keyRow.iv, keyRow.tag);
  } catch (err) {
    console.error("[agent/run] key decrypt failed:", err);
    return sseErrorResponse(
      "key_error",
      "Could not read your saved API key. Re-save it in Settings.",
    );
  }
  // (iii) re-gate the STORED base_url. /api/keys validates on the way in, but
  // rows written before that gate existed are untrusted (review CR-03) — and
  // this is the line that hands a base URL the decrypted key. Runs BEFORE the
  // debit, so a refused row costs the user nothing.
  if (!isAllowedBaseUrl(keyRow.base_url)) {
    console.error("[agent/run] refused a stored base_url that is not a public http(s) address");
    return sseErrorResponse(
      "key_error",
      "The base URL saved with your key is not allowed. Re-save it in Settings.",
    );
  }
  const baseURL = keyRow.base_url || DEFAULT_BASE_URLS[provider];

  // (iii) history for an existing chat (new chat starts empty).
  const history: ChatMessage[] = [];
  if (chatId) {
    const { data: rows, error } = await svc
      .from("messages")
      .select("role, content")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: true });
    if (error) {
      console.error("[agent/run] history read failed:", error);
      return sseErrorResponse("db_error", "Could not load the conversation.");
    }
    // D-57/D-59 hygiene: tool rows and empty rows never replay into provider
    // history (turn 2 of a chat that used tools would 400 on strict providers).
    history.push(
      ...filterProviderHistory(
        (rows ?? []) as Array<{ role: string; content: string | null }>,
      ),
    );
  }

  // (e) Create the chat row IF new — required before start_run (runs.chat_id FK).
  if (!chatId) {
    const { data: newChat, error } = await svc
      .from("chats")
      .insert({ user_id: userId, model_id: modelId, title: deriveChatTitle(message) })
      .select("id")
      .single();
    if (error || !newChat) {
      console.error("[agent/run] chat create failed:", error);
      return sseErrorResponse("db_error", "Could not start a new chat.");
    }
    chatId = newChat.id as string;
    createdNewChat = true;
  }

  // (f) DEBIT — the ONLY debit path (PAY-05). Service-role, explicit p_user_id.
  const { data: runId, error: debitErr } = await svc.rpc("start_run", {
    p_user_id: userId,
    p_chat_id: chatId,
    p_model_id: modelId,
  });
  if (debitErr || !runId) {
    // Two refusals are classified, and BOTH are decided in Postgres:
    //   P0001 = insufficient_credits (the balance gate, since Phase 2)
    //   P0002 = run_in_flight        (GC-01, migration 0007)
    // The in-flight rule now lives in `public.start_run` and in the
    // `runs_one_running_per_chat` partial unique index, so a replayed curl, a
    // second tab, or any future caller is refused identically. That demotes
    // `lib/chat/run-guard.ts` to the UX layer it always documented itself as
    // being — it stops the browser ASKING, Postgres decides.
    //
    // Only `debitErr?.code` crosses into the mapper, deliberately: the mapper's
    // parameter is a bare string so no Postgres message, detail, hint, or
    // constraint name can reach an SSE frame (a constraint name can echo a
    // user-supplied value). Anything unclassified falls through to the generic
    // branch below, which logs.
    //
    // No user message inserted yet, so no orphan (#6).
    if (createdNewChat) {
      // Best-effort: drop the just-created empty chat so nothing lingers.
      await svc.from("chats").delete().eq("id", chatId).eq("user_id", userId);
    }
    const refusal = mapStartRunError(debitErr?.code);
    if (refusal) return sseErrorResponse(refusal.code, refusal.message);
    console.error("[agent/run] start_run failed:", debitErr);
    return sseErrorResponse("debit_error", "Could not start the run.");
  }
  const runIdStr = runId as string;

  // (g) POST-DEBIT / PRE-MODEL-CALL — any throw here MUST refund_run (#1).
  let assistantMsgId: string;
  let providerMessages: ChatMessage[];
  try {
    // User message inserted AFTER the debit succeeds (#6).
    const { error: userErr } = await svc.from("messages").insert({
      chat_id: chatId,
      user_id: userId,
      run_id: runIdStr,
      role: "user",
      content: message,
    });
    if (userErr) throw userErr;

    const { data: aMsg, error: aErr } = await svc
      .from("messages")
      .insert({
        chat_id: chatId,
        user_id: userId,
        run_id: runIdStr,
        role: "assistant",
        content: "",
      })
      .select("id")
      .single();
    if (aErr || !aMsg) throw aErr ?? new Error("assistant message insert failed");
    assistantMsgId = aMsg.id as string;

    // Full conversation context every turn (CHAT-04): system + history + new user.
    // The system prompt is the FROZEN byte-stable module constant (D-49) — cache
    // breakpoint 1. Never interpolate anything into it here.
    providerMessages = [
      { role: "system", content: DEEP_RESEARCH_SYSTEM },
      ...history,
      { role: "user", content: message },
    ];
  } catch (err) {
    console.error("[agent/run] post-debit setup failed:", err);
    await svc.rpc("refund_run", { p_user_id: userId, p_run_id: runIdStr });
    return sseErrorResponse("setup_error", "Could not start the run.");
  }

  // The service-role-backed Db the run lifecycle writes through. Extracted to
  // lib/agent/run-db.ts (GW-01) so its five money/lifecycle writes CHECK the
  // resolved `{ error }` — supabase-js never rejects on a Postgres refusal, so
  // the inline version that lived here made loop.ts's terminalStep guard dead
  // code in production. This is the single construction site.
  const db: Db = createRunDb({ svc, userId });

  // The Model factory — the ONLY place a provider name picks an implementation
  // (D-48). Anthropic goes through the NATIVE Messages API wrapper (cache_control
  // breakpoints + finalMessage usage merge); everything else is openai-compat.
  // NEVER route claude-* through the compat shim — it silently drops cache_control
  // and all cache usage fields (CM-3).
  const model: Model =
    spec.provider === "anthropic"
      ? createAnthropicModel({ apiKey, baseURL, modelId })
      : // `provider` only picks the completion-cap parameter NAME
        // (max_completion_tokens on openai, max_tokens elsewhere — WR-03).
        // `contextTokens` decides whether a cap is sent AT ALL (GW-04): the
        // registry records `null` on ten of sixteen ids, and an unknown window
        // means the provider's own default, never an app-chosen reservation
        // that could itself cause a billed 400.
        createOpenAiCompatModel({
          apiKey,
          baseURL,
          modelId,
          provider: spec.provider,
          contextTokens: spec.contextTokens,
        });

  // (h) Stream. waitUntil keeps the loop alive past client disconnect (CHAT-08).
  const finalChatId = chatId;
  const wasNew = createdNewChat;
  // One source registry per run (D-35): every fetch_page success in this run
  // mints its [n] here; the loop echoes the number into observations and the
  // resolved tool rows carry it for the client + the 03-05 PDF bibliography.
  const sources = createSourceRegistry();
  // Queued-report slot (D-44): filled synchronously by a create_pdf_report
  // tool call inside the loop; consumed by the deferred settle below.
  const reportSlot: { queued?: QueuedReport } = {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sender = createSseSender(controller);
      if (wasNew) sender.send("chat_created", { chatId: finalChatId });
      const heartbeat = setInterval(() => sender.ping(), 15_000);
      const task = runTurn({
        send: sender.send,
        db,
        model,
        chatId: finalChatId,
        runId: runIdStr,
        userId,
        modelId,
        assistantMsgId,
        history: providerMessages,
        sources,
        report: reportSlot,
      })
        .finally(() => {
          // The run is terminal as soon as the answer is done (D-46): close
          // the stream FIRST so the client's `done` lands immediately — the
          // render fires afterwards and settles over Realtime.
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* client gone */
          }
        })
        .then(async () => {
          // Deferred PDF render (D-44/D-46/D-47) — same waitUntil task, after
          // terminal, after the SSE stream closed. Every failure path lands on
          // a degraded settle; nothing here may throw out of the task.
          if (!reportSlot.queued) return;
          const q = reportSlot.queued;
          let artifactId: string | null = null;
          let carrierMsgId = "";
          try {
            // Pending rows FIRST (AI-SPEC Pitfall 10): a waitUntil cancelled by
            // the platform timeout still leaves reopenable state behind.
            artifactId = await insertPendingArtifact(svc, {
              runId: runIdStr,
              chatId: finalChatId,
              userId,
              title: q.title,
            });
            if (!artifactId) return; // no row — nothing a settle could update
            carrierMsgId =
              (await db.insertToolMessage?.({
                chatId: finalChatId,
                userId,
                runId: runIdStr,
                content: artifactCarrierPayload(artifactId, q.title, "pending"),
              })) ?? "";
            // The run's complete source registry → the PDF bibliography (D-42).
            const registrySources = sources
              .entries()
              .map((e) => ({ n: e.n, title: e.title, url: e.url }));
            await settleReport(
              {
                fetchFn: fetch,
                svc,
                origin: renderOrigin,
                cookie: forwardCookie,
              },
              {
                artifactId,
                carrierMsgId,
                title: q.title,
                markdown: q.markdown,
                sources: registrySources,
                userId,
                chatId: finalChatId,
              },
            );
          } catch (err) {
            // Unexpected throw → degraded settle (never-pending, T-3-52).
            console.error(
              `[artifact] run=${runIdStr} deferred settle threw:`,
              err instanceof Error ? err.name : "error",
            );
            if (artifactId) {
              // Review WR-01 (the GW-01 class): supabase-js RESOLVES { error }
              // on a Postgres refusal — it never rejects — so the catch alone
              // was dead code and a refused fallback write left the card
              // pending forever, silently. Check the resolved error on both
              // writes (code only, never a body); keep the catch for anything
              // genuinely thrown.
              try {
                const { error: artErr } = await svc
                  .from("artifacts")
                  .update({ status: "degraded" })
                  .eq("id", artifactId);
                if (artErr) {
                  console.error(
                    `[artifact] run=${runIdStr} degraded fallback artifacts write refused:`,
                    artErr.code ?? "unknown",
                  );
                }
                if (carrierMsgId) {
                  const { error: carrierErr } = await svc
                    .from("messages")
                    .update({
                      // RC-02: the body rides along on the degraded carrier —
                      // the settle never ran, so this row is the user's only
                      // remaining route to the report (D-43).
                      content: artifactCarrierPayload(
                        artifactId,
                        q.title,
                        "degraded",
                        q.markdown,
                      ),
                    })
                    .eq("id", carrierMsgId);
                  if (carrierErr) {
                    console.error(
                      `[artifact] run=${runIdStr} degraded fallback carrier write refused:`,
                      carrierErr.code ?? "unknown",
                    );
                  }
                }
              } catch (settleErr) {
                console.error(
                  `[artifact] run=${runIdStr} degraded fallback write failed:`,
                  settleErr instanceof Error ? settleErr.name : "error",
                );
              }
            }
          }
        });
      // Outlive the client connection — the loop must keep persisting even if
      // the tab closed (CHAT-08 / D-25).
      //
      // WR-04: the chain is TERMINATED here. `runTurn`, the `.finally` close and
      // the deferred-render `.then` are each individually defensive, but nothing
      // downstream of them was — a rejection anywhere in the chain became an
      // unhandled rejection on the function. This catch makes it one tagged log
      // line (error NAME only — never a provider or Postgres body) and
      // guarantees the promise handed to waitUntil always settles.
      waitUntil(
        task.catch((err: unknown) => {
          console.error(
            `[agent/run] run=${runIdStr} waitUntil task rejected:`,
            err instanceof Error ? err.name : "error",
          );
        }),
      );
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
