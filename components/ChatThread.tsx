"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCitations } from "@/lib/markdown/remark-citations";
import { createClient } from "@/lib/supabase/client";
import { subscribeChatChannel, type ChatMessageRow } from "@/lib/chat/realtime";
import { getModel } from "@/lib/registry";
import { BalanceBadge } from "@/components/BalanceBadge";
import {
  ResearchPlanCard,
  type PlanRowItem,
} from "@/components/chat/ResearchPlanCard";
import {
  SourcesCard,
  type FoundRow,
  type SourceRow,
} from "@/components/chat/SourcesCard";
import { RunMeter } from "@/components/chat/RunMeter";
import {
  ArtifactCard,
  parseArtifactCarrier,
  type ArtifactCarrier,
} from "@/components/chat/ArtifactCard";
import { ExportPdfButton } from "@/components/chat/ExportPdfButton";

/**
 * ChatThread (CHAT-01/02/03/05/07/08, PAY-04/05) — the "use client" streaming
 * research thread.
 *
 * Run lifecycle (CHAT-05/07): the composer POSTs to /api/agent/run and reads the
 * response body with a fetch-reader (NOT EventSource, NOT AI-SDK useChat —
 * CLAUDE.md "What NOT to Use"), splitting the byte stream on the SSE frame
 * terminator, ignoring `: ping` heartbeats, and dispatching chat_created /
 * token / tool_status / usage / done / error.
 *
 * Streaming vs disconnection (the CHAT-08 contract):
 *   - While the SSE connection is LIVE, token deltas paint incrementally (the
 *     normal streaming UX).
 *   - If the stream ends WITHOUT a terminal event — fetch throw (client drop),
 *     server close without `done`, or a silent stall (no bytes past the 15s
 *     heartbeat cadence, caught by a 45s watchdog abort) — the half-painted
 *     text is swapped for the "Researching…" placeholder and the thread lands
 *     WHOLE from the DB at terminal status (SSE `done` never came; the
 *     Realtime runs terminal UPDATE settles it). The DB never holds partials
 *     (terminal-once persistence, loop.ts), so no reload path can show broken
 *     tokens.
 * Assistant content renders via react-markdown + remark-gfm (safe-by-default,
 * no raw HTML injection).
 *
 * Reconnect (CHAT-08, D-25/26/27): a reopened tab (no local SSE stream) renders
 * `initialMessages` and applies Supabase Realtime postgres_changes on messages /
 * runs — so a run still executing server-side resumes seamlessly with NO
 * reconnect banner and NO unread marker. The initiating tab suppresses Realtime
 * while it owns the live SSE stream so it never double-applies its own rows.
 *
 * Money (PAY-04/05): <BalanceBadge showMeter> renders the balance + the locked
 * "1 credit = 1 agent run" meta beside the input; at 0 credits the composer is
 * disabled with the D-18 "…please recharge credits" link to the paywall.
 */

export interface ThreadMessage {
  id: string;
  role: string;
  content: string;
}

interface ChatThreadProps {
  chatId: string | null;
  initialMessages: ThreadMessage[];
  modelId: string | null;
  balance: number;
  isNew: boolean;
  /** Set by the page when the chat's latest run is still executing: the empty
   * assistant row to render as the "Researching…" placeholder on a
   * refreshed/reopened tab. Realtime fills/settles it at terminal status. */
  initialPendingAssistantId?: string | null;
}

function WarnIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[15px] w-[15px]"
      aria-hidden="true"
    >
      <path d="m21.7 18-9-16a1.5 1.5 0 0 0-2.6 0l-9 16A1.5 1.5 0 0 0 2.7 20h18.6a1.5 1.5 0 0 0 1.4-2Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[17px] w-[17px]"
      aria-hidden="true"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[14px] w-[14px]"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * A single live/persisted tool-status line (CHAT-06 / D-29). Payload shape is
 * emitted by the loop's `tool_status` SSE event AND persisted as the JSON content
 * of a role='tool' message row, so the live and reopened renders are identical.
 *
 * Phase 3 (03-03 payload contract — the server emits these shapes in 03-04):
 * payloads gain a `kind` discriminator. Rows WITHOUT kind are the existing
 * web_search / fetch_page tool lines (unchanged shape). kind "plan" carries
 * the research-plan items; kind "meter" is the run-meter carrier; kind
 * "artifact" is the PDF report carrier (03-05/03-06 — pending/ready/degraded,
 * settled over the SAME messages Realtime channel by an UPDATE after the SSE
 * stream closed, D-46); unknown or unparseable kinds render NOTHING (D-52
 * graceful absence). fetch_page DONE payloads gain {n, title} on successful
 * fetches; web_search DONE payloads gain {results}.
 */
export interface ToolStatusEntry {
  id: string;
  tool: string; // "web_search" | "fetch_page"
  state: string; // "running" | "done"
  query?: string;
  url?: string;
  domain?: string;
  resultCount?: number;
  tokensApprox?: number;
  note?: string;
  // --- Phase 3 additions (03-03 interfaces block, LOCKED) ---
  kind?: string; // "plan" | "meter" | "artifact" — absent on plain tool lines
  items?: string[]; // kind "plan": 1..8 sub-questions
  startedAt?: string; // kind "meter": ISO runs.started_at
  iterations?: number; // kind "meter", terminal: final count
  elapsedMs?: number; // kind "meter", terminal: ended_at - started_at (server-computed)
  n?: number; // fetch_page done: server-assigned source number
  title?: string; // fetch_page done: page title | kind "artifact": report title
  results?: { title: string; url: string; domain: string }[]; // web_search done, <= 8
  // --- kind "artifact" (03-05 carrier contract, validated on read) ---
  artifactId?: string; // kind "artifact": artifacts row id for the download route
  markdown?: string; // kind "artifact", forward-compat: degraded report body
}

/**
 * Normalized URL for alsoFound matching (interfaces derivation rule):
 * lowercase host, no trailing slash, no fragment.
 */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw.toLowerCase().replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

interface RunSurfaces {
  planItems: PlanRowItem[];
  meter: ToolStatusEntry | null;
  lines: ToolStatusEntry[];
  registry: Set<number>;
  sources: SourceRow[];
  alsoFound: FoundRow[];
  artifact: ArtifactCarrier | null;
}

/**
 * Derive every 03-03 surface from ONE ordered payload list — applied
 * identically to live SSE state and persisted-row replay, so a reopened tab
 * renders byte-identical surfaces (D-25 parity for free). Unknown kinds fall
 * out of every bucket and render nothing (D-52).
 */
function deriveRunSurfaces(
  tools: ToolStatusEntry[],
  terminal: boolean,
): RunSurfaces {
  const plan = tools.find((t) => t.kind === "plan") ?? null;
  const meter = tools.find((t) => t.kind === "meter") ?? null;
  const lines = tools.filter((t) => t.kind == null);

  // Artifact carrier (RSCH-03, D-46): validated defensively on read — rows
  // from any deploy vintage are untrusted (T-3-60), so an unknown state or a
  // missing artifactId renders NOTHING. Last valid entry wins: the settle
  // UPDATE (ready/degraded) supersedes the pending insert on the same row.
  let artifact: ArtifactCarrier | null = null;
  for (const t of tools) {
    if (t.kind !== "artifact") continue;
    const parsed = parseArtifactCarrier(t);
    if (parsed) artifact = parsed;
  }

  const doneSearchCount = lines.filter(
    (t) => t.tool === "web_search" && t.state === "done",
  ).length;
  // Plan-row resolution rule (interfaces block): row i is resolved when
  // i < (count of DONE web_search entries for this message) OR the run is
  // terminal — derived, never stored, so reopen parity is free (D-31/D-52).
  const rawItems = plan && Array.isArray(plan.items) ? plan.items : [];
  const planItems: PlanRowItem[] = rawItems.map((text, i) => ({
    text: String(text),
    resolved: terminal || i < doneSearchCount,
  }));

  // Citation registry + Sources rows: fetch_page done entries carrying n,
  // sorted ascending by stored n — NEVER array order (Pitfall 10).
  const registry = new Set<number>();
  const sources: SourceRow[] = [];
  const fetched = new Set<string>();
  for (const t of lines) {
    if (t.tool !== "fetch_page") continue;
    if (t.url) fetched.add(normalizeUrl(t.url));
    if (t.state === "done" && typeof t.n === "number" && !registry.has(t.n)) {
      registry.add(t.n);
      sources.push({
        n: t.n,
        title: t.title ?? t.domain ?? t.url ?? "",
        url: t.url ?? "",
        domain: t.domain ?? "",
      });
    }
  }
  sources.sort((a, b) => a.n - b.n);

  // "Also found": union of web_search results whose normalized URL was never
  // fetched, deduped, order preserved (D-36/D-37).
  const seen = new Set<string>();
  const alsoFound: FoundRow[] = [];
  for (const t of lines) {
    if (t.tool !== "web_search" || t.state !== "done") continue;
    for (const r of t.results ?? []) {
      if (!r || typeof r.url !== "string") continue;
      const key = normalizeUrl(r.url);
      if (fetched.has(key) || seen.has(key)) continue;
      seen.add(key);
      alsoFound.push({
        title: r.title ?? r.url,
        url: r.url,
        domain: r.domain ?? "",
      });
    }
  }

  return { planItems, meter, lines, registry, sources, alsoFound, artifact };
}

/**
 * GFM tables render inside an overflow-x wrapper so wide research tables
 * scroll instead of blowing out the 92% column (UI-SPEC .chat-markdown
 * contract, [BD §8]).
 */
const markdownComponents: Components = {
  table: ({ node: _node, ...props }) => (
    <div className="md-tablewrap">
      <table {...props} />
    </div>
  ),
};

function toolLineParts(t: ToolStatusEntry): { label: string; text: string; meta: string } {
  const running = t.state !== "done";
  if (t.tool === "web_search") {
    return {
      label: running ? "Searching the web" : "Searched the web",
      text: t.query ? ` · "${t.query}"` : "",
      meta: t.note
        ? t.note
        : running
          ? "searching…"
          : `SerpAPI · ${t.resultCount ?? 0} results`,
    };
  }
  if (t.tool === "fetch_page") {
    return {
      label: running ? "Reading page" : "Read page",
      text: running ? (t.url ? ` · ${t.url}` : "") : t.domain ? ` · ${t.domain}` : "",
      meta: t.note
        ? t.note
        : running
          ? "fetching…"
          : `${(t.tokensApprox ?? 0).toLocaleString()} tok`,
    };
  }
  return { label: "Tool", text: "", meta: running ? "…" : "done" };
}

function ToolStatusLine({ t }: { t: ToolStatusEntry }) {
  const running = t.state !== "done";
  const { label, text, meta } = toolLineParts(t);
  return (
    <div className="flex items-center gap-[10px] py-[6px] pl-[14px] text-[12.5px] text-[var(--text-2)]">
      <span className="grid h-4 w-4 flex-none place-items-center">
        {running ? (
          <span className="agent-spinner" aria-hidden="true" />
        ) : (
          <span className="text-[var(--success)]">
            <CheckIcon />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <b className="font-semibold text-[var(--text)]">{label}</b>
        <span>{text}</span>
      </span>
      <span
        className="ml-auto flex-none text-[10.5px] text-[var(--text-3)]"
        style={{ fontFamily: "var(--mono)" }}
      >
        {meta}
      </span>
    </div>
  );
}

function ToolStatusGroup({
  tools,
  meter,
}: {
  tools: ToolStatusEntry[];
  meter?: ReactNode;
}) {
  if (tools.length === 0 && !meter) return null;
  return (
    <div className="my-[2px] flex flex-col border-l-2 border-[var(--border-strong)]">
      {/* Run meter (STAT-06): FIRST row inside the bordered rail but OUTSIDE
          the polite region — a 1s-ticking live region would spam assistive
          tech continuously (03-UI-SPEC § [2] a11y). */}
      {meter}
      {tools.length > 0 && (
        <div className="flex flex-col" role="status" aria-live="polite">
          {tools.map((t) => (
            <ToolStatusLine key={t.id} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * SaturationNotice (saturation-fallback) — inline chooser rendered under the
 * assistant bubble when the model provider returns a 429 ("upstream saturated").
 * It offers the next-priority free OpenRouter model(s) and auto-switches on a 10s
 * countdown. Motion is compositor-only (a scaleX bar via transform), respects
 * prefers-reduced-motion, uses design tokens only, and reserves space (fixed
 * min-height + tabular-nums digits) so the ticking countdown causes no CLS.
 */
function SaturationNotice({
  saturatedModelId,
  fallback,
  onSwitch,
  onCancel,
}: {
  saturatedModelId: string;
  fallback: string[];
  onSwitch: (chosenModelId: string) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState(fallback[0] ?? "");
  const [secondsLeft, setSecondsLeft] = useState(10);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const firedRef = useRef(false);

  const reduceMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const fire = useCallback(
    (id: string) => {
      if (firedRef.current) return;
      firedRef.current = true;
      onSwitch(id);
    },
    [onSwitch],
  );

  // Local 1s countdown; cleared on unmount (cancel/switch both unmount).
  useEffect(() => {
    const iv = setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (secondsLeft === 0) fire(selectedRef.current);
  }, [secondsLeft, fire]);

  const satLabel = getModel(saturatedModelId)?.label ?? saturatedModelId;

  return (
    <div
      role="alert"
      className="flex min-h-[132px] flex-col gap-[10px] rounded-[var(--radius)] border border-[var(--warning-border)] bg-[var(--warning-soft)] px-[14px] py-[12px] text-[13px] text-[var(--text-2)]"
    >
      <div className="flex items-start gap-[8px] text-[var(--warning)]">
        <span className="mt-[1px] flex-none">
          <WarnIcon />
        </span>
        <span className="font-[550] leading-[1.5] text-[var(--text)]">
          <b className="font-semibold">{satLabel}</b> is busy (upstream
          saturated). Switching to the next free model in{" "}
          <span style={{ fontFamily: "var(--mono)", fontVariantNumeric: "tabular-nums" }}>
            {secondsLeft}s
          </span>
          …
        </span>
      </div>

      {/* Compositor-only progress: scaleX transform, never width (no CLS/jank). */}
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-[var(--warning-border)]">
        <div
          className="h-full origin-left rounded-full bg-[var(--warning)]"
          style={{
            transform: `scaleX(${Math.max(0, secondsLeft) / 10})`,
            transition: reduceMotion ? "none" : "transform 1s linear",
            willChange: "transform",
          }}
        />
      </div>

      <div className="flex flex-wrap items-center gap-[8px]">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Choose a fallback model"
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[10px] py-[7px] text-[12.5px] text-[var(--text)] outline-none focus:border-[var(--accent)]"
        >
          {fallback.map((id) => (
            <option key={id} value={id}>
              {getModel(id)?.label ?? id}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => fire(selected)}
          className="rounded-[var(--radius)] bg-[var(--accent)] px-[12px] py-[7px] text-[12.5px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)]"
        >
          Switch now
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[12px] py-[7px] text-[12.5px] font-[550] text-[var(--text-2)] transition-colors hover:text-[var(--text)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ChatThread({
  chatId,
  initialMessages,
  modelId,
  balance: initialBalance,
  isNew,
  initialPendingAssistantId = null,
}: ChatThreadProps) {
  const router = useRouter();
  const [activeChatId, setActiveChatId] = useState<string | null>(chatId);
  // Ref mirror of activeChatId for closures that outlive a render (the stream
  // catch path runs in a closure created before chat_created could update state).
  const activeChatIdRef = useRef<string | null>(chatId);
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [balance, setBalance] = useState(initialBalance);
  const [input, setInput] = useState("");
  const [streamingId, setStreamingId] = useState<string | null>(null);
  // Live tool-status lines keyed by the streaming assistant message id (CHAT-06).
  // The reopened tab renders persisted role='tool' rows instead (D-25 parity).
  const [toolsByMsg, setToolsByMsg] = useState<Record<string, ToolStatusEntry[]>>({});
  // Per-run iteration counter fed by SSE `meter` events on the initiating tab
  // (STAT-06; 03-04 emits one at the top of each loop pass). Reset per send
  // and at settle.
  const [liveIterations, setLiveIterations] = useState(0);
  // Meter feed from runs Realtime UPDATEs (iterations, started_at — written
  // per-pass by 03-04) for tabs that do NOT own a live SSE stream (D-25/D-56).
  const [realtimeRun, setRealtimeRun] = useState<{
    iterations: number;
    startedAt?: string;
  } | null>(null);
  // Saturation-fallback chooser: set on a `rate_limited` SSE event with a
  // non-empty fallback list; drives the inline SaturationNotice.
  const [saturation, setSaturation] = useState<{
    assistantId: string;
    saturatedModelId: string;
    fallback: string[];
    lastUserText: string;
  } | null>(null);
  const streamingRef = useRef(false);
  // A run is "pending" from send until the FULL thread is reconciled from the
  // DB (terminal status). Unlike streamingRef (SSE reader liveness), pending
  // survives a broken/stalled stream — after a disconnection the thread renders
  // the loading placeholder and is pushed once, whole, when the run settles.
  const pendingRef = useRef(false);
  // Whether THIS stream delivered a terminal SSE event (done/error). A stream
  // that ends without one ended by DISCONNECTION (client or server side).
  const sawTerminalRef = useRef(false);
  // Seeded from the server when the latest run is mid-flight on page load
  // (refreshed/reopened tab). pendingRef stays FALSE for that case: Realtime
  // must apply normally so the terminal UPDATE fills the placeholder row.
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(
    initialPendingAssistantId,
  );
  // The last user question sent — reused verbatim when a saturation switch
  // re-runs the same question on the fallback model (no re-typing).
  const lastUserTextRef = useRef("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const canSend = balance > 0 && !!modelId;

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Realtime (CHAT-08). The initiating tab owns the SSE stream and suppresses
  // Realtime application while streaming so it never double-applies its own
  // rows; the passive/reopened tab applies everything, keyed by server id.
  //
  // The channel is constructed, AUTHORIZED and observed in lib/chat/realtime.ts
  // (gap G-1): both published tables are RLS-protected, and joining before the
  // cookie session's access token reached the realtime transport made the socket
  // join unauthenticated — alive, but delivering nothing to a reopened tab. What
  // the handlers below do with a row is unchanged.
  useEffect(() => {
    if (!activeChatId) return;
    const applyRow = (row: ChatMessageRow) => {
      // Suppress while this tab owns a run (SSE live OR pending after a broken
      // stream) — the thread is pushed whole at terminal status, never
      // incrementally, so partial rows must not leak in beside placeholders.
      if (streamingRef.current || pendingRef.current) return;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === row.id);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = { id: row.id, role: row.role, content: row.content ?? "" };
          return copy;
        }
        return [...prev, { id: row.id, role: row.role, content: row.content ?? "" }];
      });
    };
    return subscribeChatChannel({
      chatId: activeChatId,
      onMessageRow: applyRow,
      onRunRow: (run) => {
        // Run-meter feed (STAT-06, 03-03): pick up the per-pass iterations /
        // started_at writes for tabs that do NOT own the run — the same
        // initiating-tab suppression guard as applyRow (the initiating tab
        // gets its iterations from the SSE `meter` events instead).
        if (run && !streamingRef.current && !pendingRef.current) {
          setRealtimeRun((prev) => ({
            iterations: Math.max(prev?.iterations ?? 0, run.iterations ?? 0),
            startedAt: run.started_at ?? prev?.startedAt,
          }));
        }
        // Run-status changes drive no banner (D-25/26). A TERMINAL run status
        // is the authoritative "thread is complete" signal for EVERY tab:
        // passive/reopened tabs converge here, and the initiating tab relies
        // on it when its SSE stream broke or stalled without ever throwing
        // (the case a catch-based reconcile can never see). Reconciliation is
        // idempotent (whole-thread replace), so racing the SSE `done` event
        // is harmless.
        const status = run?.status;
        if (!status || status === "running") return;
        if (
          status !== "succeeded" &&
          status !== "failed" &&
          status !== "budget_exhausted"
        ) {
          return;
        }
        void settleFromDb();
      },
    });
  }, [activeChatId]);

  /**
   * Settle backstop (CHAT-08). Realtime postgres_changes has NO replay: losing
   * the client's network also drops the Realtime socket, so a run that reaches
   * a terminal status while the socket is down emits an event nobody receives —
   * and supabase-js resubscribes on reconnect WITHOUT backfilling. Relying on
   * that event alone leaves the placeholder waiting forever (the exact bug).
   * So while a run is pending and this tab has no live SSE stream, poll the run
   * status and settle on any terminal value. Also probes immediately on mount
   * (catches a run that finished between SSR and hydration) and whenever the
   * tab regains network / visibility, so recovery is prompt rather than
   * waiting out a full tick.
   */
  useEffect(() => {
    if (!pendingAssistantId) return;
    let stopped = false;
    const check = async () => {
      // The live SSE stream owns the thread; `done` settles it there.
      if (stopped || streamingRef.current) return;
      const cid = activeChatIdRef.current;
      if (!cid) return;
      try {
        const supabase = createClient();
        const { data: run } = await supabase
          .from("runs")
          .select("status")
          .eq("chat_id", cid)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const status = run?.status as string | undefined;
        if (!stopped && status && status !== "running") await settleFromDb();
      } catch {
        /* transient — the next tick retries */
      }
    };
    void check();
    const iv = setInterval(() => void check(), 4000);
    const onWake = () => void check();
    window.addEventListener("online", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      stopped = true;
      clearInterval(iv);
      window.removeEventListener("online", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
    // settleFromDb reads refs only — safe to omit (matches the Realtime effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAssistantId]);

  function patchMessage(id: string, patch: (m: ThreadMessage) => ThreadMessage) {
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }

  /**
   * Replace the local thread with the persisted rows. The optimistic
   * `local-u-*` / `local-a-*` placeholders have fake ids, so DB rows (real
   * UUIDs) can never be merged into them — the thread converges only by a
   * whole-list replace. Returns false when there is nothing to reconcile from
   * (no chat id yet / query failed / no rows).
   */
  async function reconcileFromDb(): Promise<boolean> {
    const cid = activeChatIdRef.current;
    if (!cid) return false;
    try {
      const supabase = createClient();
      const { data } = await supabase
        .from("messages")
        .select("id, role, content")
        .eq("chat_id", cid)
        .order("created_at", { ascending: true });
      if (!data || data.length === 0) return false;
      setMessages(
        data.map((m) => ({
          id: m.id as string,
          role: m.role as string,
          content: (m.content as string) ?? "",
        })),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Terminal-status settle: push the finished thread from the DB in one shot,
   * clear the loading placeholder + all run-ownership flags, and refresh the
   * server-rendered sidebar (bump-to-top). Idempotent — safe to call from both
   * the SSE `done` event and the Realtime runs terminal UPDATE, whichever
   * arrives (first or both).
   */
  async function settleFromDb(): Promise<void> {
    const ok = await reconcileFromDb();
    if (ok) {
      pendingRef.current = false;
      streamingRef.current = false;
      setPendingAssistantId(null);
      setStreamingId(null);
      setToolsByMsg({});
      // Meter state resets with the run — the persisted meter carrier row
      // (state "done", server-computed elapsedMs) renders the terminal form.
      setLiveIterations(0);
      setRealtimeRun(null);
      router.refresh();
    }
  }

  function handleFrame(frame: string, assistantId: string) {
    const lines = frame.split("\n");
    let event = "";
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith(":")) return; // heartbeat comment — ignore
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
    }
    if (!event) return;
    let data: Record<string, unknown> = {};
    try {
      data = dataStr ? JSON.parse(dataStr) : {};
    } catch {
      return;
    }
    switch (event) {
      case "chat_created": {
        const newId = data.chatId as string;
        if (newId) {
          setActiveChatId(newId);
          activeChatIdRef.current = newId;
          window.history.replaceState(null, "", `/app/c/${newId}`);
          router.refresh(); // server-rendered sidebar picks up the new chat
        }
        break;
      }
      case "token":
        // Live-connection streaming UX. If the stream later dies without a
        // terminal event, handleStreamDrop swaps this half-painted text for
        // the placeholder — partial text never survives a disconnection.
        patchMessage(assistantId, (m) => ({
          ...m,
          content: m.content + ((data.delta as string) ?? ""),
        }));
        break;
      case "tool_status": {
        // Payloads with a `kind` discriminator (plan / meter / artifact —
        // 03-03/03-05 contracts) flow into the same per-message list;
        // deriveRunSurfaces discriminates at render (kind "plan" ->
        // ResearchPlanCard, "meter" -> RunMeter, "artifact" -> ArtifactCard,
        // unknown kind -> nothing, no kind -> the existing tool lines).
        const p = data as unknown as ToolStatusEntry;
        if (!p.id) break;
        setToolsByMsg((prev) => {
          const list = prev[assistantId] ?? [];
          const idx = list.findIndex((t) => t.id === p.id);
          const next =
            idx >= 0 ? list.map((t) => (t.id === p.id ? p : t)) : [...list, p];
          return { ...prev, [assistantId]: next };
        });
        break;
      }
      case "meter": {
        // Per-pass iteration counter (STAT-06; live tab only — reopened tabs
        // use the runs Realtime UPDATE feed instead). Monotonic via max.
        const n = data.iterations;
        if (typeof n === "number" && Number.isFinite(n)) {
          setLiveIterations((prev) => Math.max(prev, n));
        }
        break;
      }
      case "usage":
        break; // recorded server-side; no UI this phase
      case "rate_limited": {
        // Provider 429 ("upstream saturated"). Offer the priority-ordered free
        // fallbacks; render the chooser only when at least one exists (the
        // following `error` event still fills the bubble otherwise).
        const fb = (data.fallback as string[]) ?? [];
        if (fb.length === 0) break;
        setSaturation({
          assistantId,
          saturatedModelId: String(data.saturatedModelId ?? ""),
          fallback: fb,
          lastUserText: lastUserTextRef.current,
        });
        break;
      }
      case "done":
        sawTerminalRef.current = true;
        if (data.status === "succeeded") setBalance((b) => Math.max(0, b - 1));
        // Push the finished thread in one shot + refresh the RSC sidebar
        // (bump-to-top). settleFromDb is idempotent with the Realtime terminal
        // backstop.
        void settleFromDb();
        break;
      case "error": {
        sawTerminalRef.current = true;
        const msg =
          (data.message as string) ||
          "The research run failed. Please try again.";
        pendingRef.current = false;
        setPendingAssistantId(null);
        patchMessage(assistantId, (m) => ({ ...m, content: m.content || msg }));
        break;
      }
    }
  }

  // The shared send path: owns the fetch-reader loop so both the initial send
  // and a saturation fallback switch re-run through the same code. `switchModel`
  // is the explicit opt-in that lets the route honor the chosen fallback model.
  async function streamRun({
    text,
    assistantId,
    modelId: runModelId,
    switchModel,
  }: {
    text: string;
    assistantId: string;
    modelId: string;
    switchModel?: boolean;
  }) {
    lastUserTextRef.current = text;
    streamingRef.current = true;
    pendingRef.current = true;
    sawTerminalRef.current = false;
    setStreamingId(assistantId);
    setPendingAssistantId(assistantId);
    setLiveIterations(0); // fresh run — meter counts from its own SSE events

    // Stall watchdog: the server heartbeats every 15s, so a live connection is
    // never byte-silent for long. 45s of silence = the stream died without
    // erroring (proxy holding a dead socket) — abort so it becomes a normal
    // disconnection instead of a forever-wedged reader.
    const aborter = new AbortController();
    let lastByteAt = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastByteAt > 45_000) aborter.abort();
    }, 10_000);

    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: activeChatId,
          message: text,
          modelId: runModelId,
          ...(switchModel ? { switchModel: true } : {}),
        }),
        signal: aborter.signal,
      });
      if (!res.ok || !res.body) {
        pendingRef.current = false;
        setPendingAssistantId(null);
        patchMessage(assistantId, (m) => ({
          ...m,
          content:
            m.content || "The research run could not start. Please try again.",
        }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastByteAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (frame.length > 0) handleFrame(frame, assistantId);
        }
      }
      // Stream closed CLEANLY but no done/error event arrived → the server
      // side dropped the connection mid-run.
      if (!sawTerminalRef.current) await handleStreamDrop(assistantId);
    } catch {
      // Fetch threw → client-side drop (network loss) or the watchdog abort.
      if (!sawTerminalRef.current) await handleStreamDrop(assistantId);
    } finally {
      clearInterval(watchdog);
      streamingRef.current = false;
      setStreamingId(null);
    }
  }

  /**
   * The SSE stream ended by DISCONNECTION (no terminal event). The server loop
   * survives via waitUntil (CHAT-08): swap the half-painted text for the
   * "Researching…" placeholder — partial text must not survive a broken stream
   * — and let the Realtime runs terminal UPDATE push the finished thread
   * whole. One immediate status check covers the run having ALREADY finished
   * while disconnected (the terminal event this tab can no longer receive).
   */
  async function handleStreamDrop(assistantId: string) {
    streamingRef.current = false;
    patchMessage(assistantId, (m) => ({ ...m, content: "" }));
    try {
      const cid = activeChatIdRef.current;
      if (cid) {
        const supabase = createClient();
        const { data: run } = await supabase
          .from("runs")
          .select("status")
          .eq("chat_id", cid)
          .order("started_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const status = run?.status as string | undefined;
        if (status && status !== "running") await settleFromDb();
      }
    } catch {
      /* stay pending — the Realtime terminal backstop settles the thread */
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !canSend || streamingRef.current) return;

    const userMsgId = `local-u-${Date.now()}`;
    const assistantId = `local-a-${Date.now()}`;
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: text },
      { id: assistantId, role: "assistant", content: "" },
    ]);

    await streamRun({ text, assistantId, modelId: modelId as string });
  }

  // Re-run the SAME last question on the chosen fallback model. Removes the
  // failed assistant bubble and appends one fresh empty bubble (no new user
  // bubble — the question is unchanged). The saturated run was already refunded
  // server-side; this fresh run debits its own credit (money stays correct).
  function onSwitch(chosenModelId: string) {
    const sat = saturation;
    if (!sat) return;
    setSaturation(null);
    const newAssistantId = `local-a-${Date.now()}`;
    setMessages((prev) => [
      ...prev.filter((m) => m.id !== sat.assistantId),
      { id: newAssistantId, role: "assistant", content: "" },
    ]);
    void streamRun({
      text: sat.lastUserText,
      assistantId: newAssistantId,
      modelId: chosenModelId,
      switchModel: true,
    });
  }

  // Persisted-row replay derivation (D-25 parity, 03-03): associate each
  // role='tool' row with its run's assistant row. The assistant placeholder is
  // inserted before the loop starts, so a run segment in created_at order is
  // [user] [assistant] [tool rows…] — tool rows attach to the nearest
  // PRECEDING assistant row, resetting at every user row. The assistant block
  // then renders plan card, rail, answer, sources in the UI-SPEC fixed
  // vertical order from these payloads, and the tool rows render nothing at
  // their own list positions (they'd otherwise paint BELOW the answer).
  const replaySegments = useMemo(() => {
    const byAssistant = new Map<string, ToolStatusEntry[]>();
    const ownedToolRows = new Set<string>();
    let lastAssistantId: string | null = null;
    for (const m of messages) {
      if (m.role === "user") {
        lastAssistantId = null;
        continue;
      }
      if (m.role === "assistant") {
        lastAssistantId = m.id;
        continue;
      }
      if (m.role !== "tool" || !lastAssistantId) continue;
      ownedToolRows.add(m.id);
      let entry: ToolStatusEntry | null = null;
      try {
        entry = JSON.parse(m.content) as ToolStatusEntry;
      } catch {
        entry = null; // D-52: an unparseable payload renders NOTHING
      }
      if (!entry) continue;
      const list = byAssistant.get(lastAssistantId) ?? [];
      list.push({ ...entry, id: entry.id || m.id });
      byAssistant.set(lastAssistantId, list);
    }
    return { byAssistant, ownedToolRows };
  }, [messages]);

  // Export-as-PDF title (D-38): derived from the chat title, which is the
  // literal first user prompt (CHAT-02) — so the first user message content
  // IS the chat title on live and reopened tabs alike. Truncated to the
  // render route's zod bound (title 1..200).
  const exportTitle = useMemo(() => {
    const first = messages.find((mm) => mm.role === "user")?.content ?? "";
    return first.trim().slice(0, 200).trim() || "Research report";
  }, [messages]);

  const showEmpty = messages.length === 0;

  return (
    <div className="flex h-full w-full max-w-[820px] flex-col self-stretch">
      {/* ---- Thread column ---- */}
      <div className="flex-1 overflow-y-auto px-1 py-4">
        {showEmpty && (
          <div className="mx-auto max-w-[460px] py-16 text-center text-[var(--text-3)]">
            <p className="text-[14.5px] leading-[1.6]">
              Ask the deep-research agent a question — it browses the web, reasons
              across sources, and streams a cited answer.
            </p>
          </div>
        )}
        <div className="flex flex-col gap-4">
          {messages.map((m) => {
            // Persisted tool-status rows (reopened tab, D-25). Segment-owned
            // rows render inside their assistant block (fixed vertical order:
            // plan card, rail, answer, sources) — nothing at their own
            // position. Orphan rows (no preceding assistant — defensive) keep
            // the legacy single-line rendering; kind-discriminated orphans
            // render nothing (D-52 null fallback).
            if (m.role === "tool") {
              if (replaySegments.ownedToolRows.has(m.id)) return null;
              let entry: ToolStatusEntry | null = null;
              try {
                entry = JSON.parse(m.content) as ToolStatusEntry;
              } catch {
                entry = null;
              }
              if (!entry || entry.kind != null) return null;
              return (
                <div key={m.id} className="flex justify-start">
                  <div className="w-full max-w-[92%]">
                    <ToolStatusGroup tools={[{ ...entry, id: entry.id || m.id }]} />
                  </div>
                </div>
              );
            }

            const isUser = m.role === "user";
            const isPending = m.id === pendingAssistantId && m.content.length === 0;
            const isStreaming = m.id === streamingId;
            const liveTools = toolsByMsg[m.id] ?? [];
            // A run is terminal for this message when this tab neither
            // streams it nor holds it pending — replayed finished threads
            // land here (SourcesCard is terminal-only, D-37).
            const terminal = !isStreaming && m.id !== pendingAssistantId;
            // Live SSE state and replayed rows feed ONE derivation (D-25
            // parity). They never overlap: Realtime application is suppressed
            // while this tab owns the run, and settleFromDb clears live tool
            // state when the persisted rows take over.
            const segmentTools = replaySegments.byAssistant.get(m.id) ?? [];
            const {
              planItems,
              meter,
              lines,
              registry,
              sources,
              alsoFound,
              artifact,
            } = deriveRunSurfaces([...segmentTools, ...liveTools], terminal);
            const meterStartedAt = meter?.startedAt ?? realtimeRun?.startedAt;
            const meterRunning = meter?.state !== "done" && !terminal;
            const meterNode =
              meter && meterStartedAt ? (
                <RunMeter
                  startedAt={meterStartedAt}
                  running={meterRunning}
                  iterations={
                    meterRunning
                      ? Math.max(
                          liveIterations,
                          realtimeRun?.iterations ?? 0,
                          meter.iterations ?? 0,
                        )
                      : (meter.iterations ??
                        Math.max(liveIterations, realtimeRun?.iterations ?? 0))
                  }
                  elapsedMs={meter.elapsedMs}
                />
              ) : null;
            return (
              <div
                key={m.id}
                className={isUser ? "flex justify-end" : "flex justify-start"}
              >
                {isUser ? (
                  <div className="max-w-[80%] rounded-[var(--radius)] bg-[var(--accent)] px-[14px] py-[10px] text-[14px] leading-[1.55] text-white">
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  </div>
                ) : (
                  <div className="flex w-full max-w-[92%] flex-col gap-1">
                    {/* [1] Research plan card (RSCH-01) — absent when the
                        model omitted the block (D-52: renders null). */}
                    <ResearchPlanCard items={planItems} />
                    {/* [2] Run meter + tool-status rail — live SSE lines for
                        the initiating tab (CHAT-06), replayed rows otherwise;
                        one derivation feeds both (D-25). */}
                    <ToolStatusGroup tools={lines} meter={meterNode} />
                    {m.content.length > 0 ? (
                      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[16px] py-[12px] text-[14px] leading-[1.6] text-[var(--text)]">
                        {/* [3] Answer markdown on the real .chat-markdown
                            stylesheet (the dead legacy class is deleted).
                            Citations resolve per-render against the registry —
                            an [n] streamed before source n registers stays
                            literal and upgrades on a later delta (RSCH-02). */}
                        <div className="chat-markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm, remarkCitations(registry)]}
                            components={markdownComponents}
                          >
                            {m.content}
                          </ReactMarkdown>
                          {isStreaming && (
                            <span className="streaming-cursor" aria-hidden="true" />
                          )}
                        </div>
                      </div>
                    ) : isPending ? (
                      /* Disconnection placeholder: shown only when no live SSE
                         text exists for this run (stream dropped, or a
                         refreshed tab) — the finished thread is pushed whole
                         at terminal status. */
                      <div
                        role="status"
                        aria-live="polite"
                        className="flex items-center gap-[10px] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[16px] py-[12px] text-[13px] text-[var(--text-2)]"
                      >
                        <span className="agent-spinner" aria-hidden="true" />
                        Researching — the full answer appears here when the run
                        completes…
                      </div>
                    ) : null}
                    {saturation?.assistantId === m.id && (
                      <SaturationNotice
                        saturatedModelId={saturation.saturatedModelId}
                        fallback={saturation.fallback}
                        onSwitch={onSwitch}
                        onCancel={() => setSaturation(null)}
                      />
                    )}
                    {/* [4] Export as PDF (D-38) — the always-visible safety
                        net on every TERMINAL assistant answer (never a
                        streaming one): the same PDF via /api/render-pdf even
                        when the model never called the tool, and the retry
                        path for a degraded card. Carries the D-42
                        bibliography from the client-held source registry. */}
                    {terminal && m.content.length > 0 && (
                      <ExportPdfButton
                        title={exportTitle}
                        markdown={m.content}
                        sources={sources
                          .slice(0, 50)
                          .map((s) => ({ n: s.n, title: s.title, url: s.url }))}
                      />
                    )}
                    {/* [5] Sources card — appears once, complete, at terminal
                        state only (D-37; CLS contract). Renders null when the
                        run fetched nothing (D-52). */}
                    {terminal && (
                      <SourcesCard sources={sources} alsoFound={alsoFound} />
                    )}
                    {/* [6] Artifact card (RSCH-03) — only when a report was
                        requested (D-52 absence otherwise). Fixed 72px box;
                        the pending→ready/degraded settle arrives as a
                        messages Realtime UPDATE on the already-subscribed
                        channel AFTER the SSE stream closed, when the
                        initiating-tab suppression flags are already cleared
                        by settleFromDb (D-46 — no new subscription). */}
                    {artifact && (
                      <ArtifactCard
                        artifactId={artifact.artifactId}
                        title={artifact.title}
                        state={artifact.state}
                      />
                    )}
                    {/* [7] Degraded report body (RSCH-04, D-43) — the user
                        always gets the content: the report markdown in a
                        standard assistant bubble beneath the card. Source:
                        carrier markdown when present (forward-compat), else
                        the terminal answer — the report body IS the answer
                        in the fallback path (03-05 weak-markdown guarantee). */}
                    {artifact?.state === "degraded" &&
                      (artifact.markdown ?? m.content).length > 0 && (
                        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[16px] py-[14px]">
                          <div className="chat-markdown">
                            <ReactMarkdown
                              remarkPlugins={[
                                remarkGfm,
                                remarkCitations(registry),
                              ]}
                              components={markdownComponents}
                            >
                              {artifact.markdown ?? m.content}
                            </ReactMarkdown>
                          </div>
                        </div>
                      )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* ---- Composer ---- */}
      <div className="border-t border-[var(--border)] bg-[var(--surface)] px-1 pt-3 pb-2">
        <div className="mb-2 flex items-center gap-3">
          <BalanceBadge balance={balance} showMeter />
        </div>

        {balance <= 0 ? (
          <div
            role="note"
            className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--warning-border)] bg-[var(--warning-soft)] px-[14px] py-[12px] text-[13px] font-[550] text-[var(--warning)]"
          >
            <WarnIcon />
            <span>
              Credits exhausted, please recharge{" "}
              <a
                href="/app"
                className="font-[650] text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-hover)]"
              >
                credits
              </a>
            </span>
          </div>
        ) : !modelId ? (
          <div
            role="note"
            className="rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-[14px] py-[12px] text-[13px] text-[var(--text-3)]"
          >
            Pick a model to start this research chat.
          </div>
        ) : (
          <form onSubmit={submit} className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit(e as unknown as React.FormEvent);
                }
              }}
              rows={2}
              placeholder="Ask a follow-up research question…"
              className="min-h-[46px] flex-1 resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-2)] px-[14px] py-[11px] text-[14px] leading-[1.5] text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <button
              type="submit"
              disabled={!input.trim() || !!streamingId}
              aria-label="Send research question"
              className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[var(--radius)] bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
              style={{ boxShadow: "0 2px 8px rgba(194,65,12,.22)" }}
            >
              <SendIcon />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
