import { z } from "zod";
import type OpenAINS from "openai";
import type { NormalizedUsage } from "@/lib/agent/adapter";
import { fromOpenAI } from "@/lib/agent/adapter";
import { costUsd, type ModelPrices } from "@/lib/pricing";
import { getModel, DEFAULT_BASE_URLS, type Provider } from "@/lib/registry";

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
export interface UsageEventRow {
  run_id: string;
  chat_id: string;
  user_id: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  input_price_per_1m: number;
  output_price_per_1m: number;
  cache_read_price_per_1m: number;
  cache_write_price_per_1m: number;
  cost_usd: number;
}

export interface Db {
  updateMessageContent(id: string, content: string): Promise<void>;
  markFirstModelCall(runId: string): Promise<void>;
  setRunStatus(runId: string, status: string, iterations?: number): Promise<void>;
  insertUsageEvent(row: UsageEventRow): Promise<void>;
  refundRun(runId: string): Promise<void>;
}

export interface ChatMessage {
  role: string;
  content: string;
}

export interface ModelChunk {
  delta?: string;
  usage?: NormalizedUsage;
}

export interface Model {
  run(messages: ChatMessage[]): AsyncIterable<ModelChunk>;
}

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
}

/** Map a provider/RPC error to safe human copy — NEVER the raw body (Pitfall 7). */
function mapProviderError(err: unknown): { code: string; message: string } {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403)
    return {
      code: "auth",
      message:
        "Your API key was rejected by the provider. Check the key in Settings.",
    };
  if (status === 429)
    return {
      code: "rate_limited",
      message:
        "The provider is rate-limiting your key. Wait a moment and try again.",
    };
  if (typeof status === "number" && status >= 500)
    return {
      code: "provider_error",
      message: "The model provider had a server error. Please try again.",
    };
  return {
    code: "model_error",
    message: "The research run failed to complete. Please try again.",
  };
}

function pricesFor(modelId: string): ModelPrices {
  const s = getModel(modelId);
  return s
    ? {
        inputPer1M: s.inputPer1M,
        outputPer1M: s.outputPer1M,
        cacheReadPer1M: s.cacheReadPer1M,
        cacheWritePer1M: s.cacheWritePer1M,
      }
    : { inputPer1M: 0, outputPer1M: 0, cacheReadPer1M: 0, cacheWritePer1M: 0 };
}

/**
 * Single-turn orchestrator, provider-agnostic via the injected `db` + `model`.
 * 02-05 REPLACES the `model.run(...)` iteration with the think→act→observe loop,
 * reusing `send` + `db`. A `send` that no-ops because the client is gone must
 * NEVER alter persistence or control flow (CHAT-08).
 */
export async function runTurn(opts: RunTurnOpts): Promise<void> {
  const { send, db, model, chatId, runId, userId, modelId, assistantMsgId, history } =
    opts;
  let acc = "";
  let firstDelta = false;
  let lastFlush = Date.now();
  let lastFlushLen = 0;

  try {
    for await (const chunk of model.run(history)) {
      if (typeof chunk.delta === "string" && chunk.delta.length > 0) {
        acc += chunk.delta;
        if (!firstDelta) {
          firstDelta = true;
          await db.markFirstModelCall(runId); // bills this run (PAY-06 gate)
        }
        send("token", { delta: chunk.delta });
        // Throttle DB writes so Realtime UPDATE events flow to reopened tabs
        // without a write per token.
        const now = Date.now();
        if (acc.length - lastFlushLen >= 24 || now - lastFlush >= 250) {
          lastFlush = now;
          lastFlushLen = acc.length;
          await db.updateMessageContent(assistantMsgId, acc);
        }
      }
      if (chunk.usage) {
        const prices = pricesFor(modelId);
        const cost = costUsd(chunk.usage, prices);
        await db.insertUsageEvent({
          run_id: runId,
          chat_id: chatId,
          user_id: userId,
          model_id: modelId,
          input_tokens: chunk.usage.inputTokens,
          output_tokens: chunk.usage.outputTokens,
          cache_read_tokens: chunk.usage.cacheReadTokens,
          cache_write_tokens: chunk.usage.cacheWriteTokens,
          input_price_per_1m: prices.inputPer1M,
          output_price_per_1m: prices.outputPer1M,
          cache_read_price_per_1m: prices.cacheReadPer1M,
          cache_write_price_per_1m: prices.cacheWritePer1M,
          cost_usd: cost,
        });
        send("usage", {
          inputTokens: chunk.usage.inputTokens,
          outputTokens: chunk.usage.outputTokens,
          cacheReadTokens: chunk.usage.cacheReadTokens,
          cacheWriteTokens: chunk.usage.cacheWriteTokens,
          costUsd: cost,
        });
      }
    }
    await db.updateMessageContent(assistantMsgId, acc);
    await db.setRunStatus(runId, "succeeded", 1);
    send("done", { runId, status: "succeeded" });
  } catch (err) {
    // Server-side only — never leak the raw provider/RPC detail (Pitfall 7).
    console.error("[agent/run] runTurn failed:", err);
    const mapped = mapProviderError(err);
    // Refund ONLY when the very first model call never returned a delta
    // (disconnect ≠ failure; a started model call already bills — Pitfall 3).
    if (!firstDelta) await db.refundRun(runId);
    await db.updateMessageContent(
      assistantMsgId,
      acc.length > 0 ? acc : mapped.message,
    );
    await db.setRunStatus(runId, "failed");
    send("error", mapped);
    send("done", { runId, status: "failed" });
  }
}

// ============================ Request body ============================
const bodySchema = z.object({
  chatId: z.string().uuid().nullable(),
  message: z.string().trim().min(1),
  modelId: z.string().min(1),
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
    modelId = chat.model_id; // no mid-chat model switch
  }

  // (b2) Validate the effective model against the registry (T-04-07 / OQ-1).
  const spec = getModel(modelId);
  if (!spec || spec.provider === "anthropic" || spec.selectable === false) {
    return sseErrorResponse(
      "bad_model",
      "That model is not available for research runs.",
    );
  }
  const provider: Provider = spec.provider;

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
    for (const r of rows ?? [])
      history.push({ role: r.role as string, content: (r.content as string) ?? "" });
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
    // P0001 = insufficient_credits. No user message inserted (no orphan, #6).
    if (createdNewChat) {
      // Best-effort: drop the just-created empty chat so nothing lingers.
      await svc.from("chats").delete().eq("id", chatId).eq("user_id", userId);
    }
    if (debitErr?.code === "P0001") {
      return sseErrorResponse(
        "insufficient_credits",
        "You are out of credits. Redeem a credit to run another research chat.",
      );
    }
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
    providerMessages = [
      {
        role: "system",
        content:
          "You are MicroManus, a concise research assistant. Answer clearly in Markdown.",
      },
      ...history,
      { role: "user", content: message },
    ];
  } catch (err) {
    console.error("[agent/run] post-debit setup failed:", err);
    await svc.rpc("refund_run", { p_user_id: userId, p_run_id: runIdStr });
    return sseErrorResponse("setup_error", "Could not start the run.");
  }

  // The service-role-backed Db the run lifecycle writes through.
  const db: Db = {
    async updateMessageContent(id, content) {
      await svc.from("messages").update({ content }).eq("id", id);
    },
    async markFirstModelCall(rid) {
      await svc.from("runs").update({ first_model_call_completed: true }).eq("id", rid);
    },
    async setRunStatus(rid, status, iterations) {
      const patch: Record<string, unknown> = {
        status,
        ended_at: new Date().toISOString(),
      };
      if (iterations != null) patch.iterations = iterations;
      await svc.from("runs").update(patch).eq("id", rid);
    },
    async insertUsageEvent(row) {
      await svc.from("usage_events").insert(row);
    },
    async refundRun(rid) {
      await svc.rpc("refund_run", { p_user_id: userId, p_run_id: rid });
    },
  };

  // The openai-compat model wrapper — the create() call lives INSIDE the async
  // generator so every provider error surfaces inside runTurn's guarded catch
  // (centralizing the refund / first-delta logic).
  const model: Model = {
    async *run(messages) {
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ apiKey, baseURL });
      const stream = await client.chat.completions.create({
        model: modelId,
        messages: messages as OpenAINS.Chat.Completions.ChatCompletionMessageParam[],
        stream: true,
        stream_options: { include_usage: true },
      });
      for await (const part of stream) {
        const delta = part.choices?.[0]?.delta?.content;
        if (delta) yield { delta };
        if (part.usage) yield { usage: fromOpenAI(part.usage) };
      }
    },
  };

  // (h) Stream. waitUntil keeps the loop alive past client disconnect (CHAT-08).
  const finalChatId = chatId;
  const wasNew = createdNewChat;
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
      }).finally(() => {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* client gone */
        }
      });
      // Outlive the client connection — the loop must keep persisting even if
      // the tab closed (CHAT-08 / D-25).
      waitUntil(task);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
