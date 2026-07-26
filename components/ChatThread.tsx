"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createClient } from "@/lib/supabase/client";
import { getModel } from "@/lib/registry";
import { BalanceBadge } from "@/components/BalanceBadge";

/**
 * ChatThread (CHAT-01/02/03/05/07/08, PAY-04/05) — the "use client" streaming
 * research thread.
 *
 * Run lifecycle (CHAT-05/07): the composer POSTs to /api/agent/run and reads the
 * response body with a fetch-reader (NOT EventSource, NOT AI-SDK useChat —
 * CLAUDE.md "What NOT to Use"), splitting the byte stream on the SSE frame
 * terminator, ignoring `: ping` heartbeats, and dispatching chat_created /
 * tool_status / usage / done / error. `token` deltas are intentionally NOT
 * painted: the thread shows an in-progress placeholder and the finished thread
 * is pushed WHOLE from the DB at terminal status (SSE `done` when connected,
 * the Realtime runs terminal UPDATE when the stream broke or stalled) — a
 * half-painted thread from a broken SSE stream can never duplicate against the
 * Realtime rows. Assistant content renders via react-markdown + remark-gfm
 * (safe-by-default, no raw HTML injection).
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
}

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

function ToolStatusGroup({ tools }: { tools: ToolStatusEntry[] }) {
  if (tools.length === 0) return null;
  return (
    <div
      className="my-[2px] flex flex-col border-l-2 border-[var(--border-strong)]"
      role="status"
      aria-live="polite"
    >
      {tools.map((t) => (
        <ToolStatusLine key={t.id} t={t} />
      ))}
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
  // survives a broken/stalled stream — the thread renders a loading placeholder
  // and is pushed once, whole, when the run settles (no token-by-token paint).
  const pendingRef = useRef(false);
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
  useEffect(() => {
    if (!activeChatId) return;
    const supabase = createClient();
    const applyRow = (row: { id: string; role: string; content: string | null }) => {
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
    const channel = supabase
      .channel(`chat:${activeChatId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `chat_id=eq.${activeChatId}`,
        },
        (payload) => applyRow(payload.new as never),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "messages",
          filter: `chat_id=eq.${activeChatId}`,
        },
        (payload) => applyRow(payload.new as never),
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "runs",
          filter: `chat_id=eq.${activeChatId}`,
        },
        (payload) => {
          // Run-status changes drive no banner (D-25/26). A TERMINAL run status
          // is the authoritative "thread is complete" signal for EVERY tab:
          // passive/reopened tabs converge here, and the initiating tab relies
          // on it when its SSE stream broke or stalled without ever throwing
          // (the case a catch-based reconcile can never see). Reconciliation is
          // idempotent (whole-thread replace), so racing the SSE `done` event
          // is harmless.
          const status = (payload.new as { status?: string } | null)?.status;
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
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeChatId]);

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
        // Intentionally ignored: the thread renders a loading placeholder and
        // is pushed WHOLE at terminal status. Token-by-token painting was
        // removed because a broken/stalled SSE stream left half-painted
        // threads that duplicated against the Realtime rows.
        break;
      case "tool_status": {
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
        if (data.status === "succeeded") setBalance((b) => Math.max(0, b - 1));
        // Push the finished thread in one shot + refresh the RSC sidebar
        // (bump-to-top). settleFromDb is idempotent with the Realtime terminal
        // backstop.
        void settleFromDb();
        break;
      case "error": {
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
    setStreamingId(assistantId);
    setPendingAssistantId(assistantId);

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
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (frame.length > 0) handleFrame(frame, assistantId);
        }
      }
    } catch {
      // The server loop survives via waitUntil (CHAT-08). Keep the loading
      // placeholder in place — the Realtime runs terminal UPDATE settles the
      // whole thread when the run finishes. One immediate status check covers
      // the run having ALREADY finished while this tab was disconnected (the
      // terminal event it can no longer receive).
      streamingRef.current = false;
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
    } finally {
      streamingRef.current = false;
      setStreamingId(null);
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
            // Persisted tool-status row (reopened tab, D-25) — render the same
            // tool-status line as the live SSE `tool_status` event.
            if (m.role === "tool") {
              let entry: ToolStatusEntry | null = null;
              try {
                entry = JSON.parse(m.content) as ToolStatusEntry;
              } catch {
                entry = null;
              }
              if (!entry) return null;
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
            const liveTools = toolsByMsg[m.id] ?? [];
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
                    {/* Live tool-status lines for the initiating tab (CHAT-06). */}
                    <ToolStatusGroup tools={liveTools} />
                    {m.content.length > 0 ? (
                      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[16px] py-[12px] text-[14px] leading-[1.6] text-[var(--text)]">
                        <div className="chat-markdown prose-sm">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {m.content}
                          </ReactMarkdown>
                        </div>
                      </div>
                    ) : isPending ? (
                      /* In-progress placeholder: the finished thread is pushed
                         whole at terminal status — no token-by-token paint. */
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
