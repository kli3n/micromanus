"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createClient } from "@/lib/supabase/client";
import { BalanceBadge } from "@/components/BalanceBadge";

/**
 * ChatThread (CHAT-01/02/03/05/07/08, PAY-04/05) — the "use client" streaming
 * research thread.
 *
 * Streaming (CHAT-05/07): the composer POSTs to /api/agent/run and reads the
 * response body with a fetch-reader (NOT EventSource, NOT AI-SDK useChat —
 * CLAUDE.md "What NOT to Use"), splitting the byte stream on the SSE frame
 * terminator, ignoring `: ping` heartbeats, and dispatching chat_created / token
 * / usage / done / error. Assistant content renders via react-markdown +
 * remark-gfm (safe-by-default, no raw HTML injection).
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

export function ChatThread({
  chatId,
  initialMessages,
  modelId,
  balance: initialBalance,
  isNew,
}: ChatThreadProps) {
  const router = useRouter();
  const [activeChatId, setActiveChatId] = useState<string | null>(chatId);
  const [messages, setMessages] = useState<ThreadMessage[]>(initialMessages);
  const [balance, setBalance] = useState(initialBalance);
  const [input, setInput] = useState("");
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const streamingRef = useRef(false);
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
      if (streamingRef.current) return; // this tab is the SSE source of truth
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
        () => {
          // Run-status changes drive no banner (D-25/26); reserved for 02-05.
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
          window.history.replaceState(null, "", `/app/c/${newId}`);
          router.refresh(); // server-rendered sidebar picks up the new chat
        }
        break;
      }
      case "token":
        patchMessage(assistantId, (m) => ({
          ...m,
          content: m.content + ((data.delta as string) ?? ""),
        }));
        break;
      case "usage":
        break; // recorded server-side; no UI this phase
      case "done":
        if (data.status === "succeeded") setBalance((b) => Math.max(0, b - 1));
        break;
      case "error": {
        const msg =
          (data.message as string) ||
          "The research run failed. Please try again.";
        patchMessage(assistantId, (m) => ({ ...m, content: m.content || msg }));
        break;
      }
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || !canSend || streamingRef.current) return;

    const userMsgId = `local-u-${Date.now()}`;
    const assistantId = `local-a-${Date.now()}`;
    setInput("");
    streamingRef.current = true;
    setStreamingId(assistantId);
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content: text },
      { id: assistantId, role: "assistant", content: "" },
    ]);

    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: activeChatId, message: text, modelId }),
      });
      if (!res.ok || !res.body) {
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
      // The server loop survives via waitUntil (CHAT-08); reopening resumes it.
      patchMessage(assistantId, (m) => ({
        ...m,
        content:
          m.content ||
          "Connection interrupted — your run may still be completing. Reopen this chat to see the result.",
      }));
    } finally {
      streamingRef.current = false;
      setStreamingId(null);
    }
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
            const isUser = m.role === "user";
            const isStreaming = m.id === streamingId;
            return (
              <div
                key={m.id}
                className={
                  isUser ? "flex justify-end" : "flex justify-start"
                }
              >
                <div
                  className={
                    isUser
                      ? "max-w-[80%] rounded-[var(--radius)] bg-[var(--accent)] px-[14px] py-[10px] text-[14px] leading-[1.55] text-white"
                      : "max-w-[92%] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[16px] py-[12px] text-[14px] leading-[1.6] text-[var(--text)]"
                  }
                >
                  {isUser ? (
                    <span className="whitespace-pre-wrap">{m.content}</span>
                  ) : (
                    <div className="chat-markdown prose-sm">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {m.content}
                      </ReactMarkdown>
                      {isStreaming && (
                        <span className="streaming-cursor" aria-hidden="true" />
                      )}
                    </div>
                  )}
                </div>
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
