import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { costUsd, savingsUsd } from "@/lib/pricing";
import { getModel } from "@/lib/registry";
import { countConversationMessages } from "@/lib/stats/message-count";

/**
 * /app/stats — Cost & usage (STAT-02, STAT-03, STAT-05, UX-02; D-16).
 *
 * STAT-05 (D-53/D-54): cache savings are a GROSS derivation over the same
 * stored event-time price columns — savingsUsd(cache_read_tokens,
 * input_price_per_1m, cache_read_price_per_1m) — shown at three levels
 * (all-time tile + headline note, per-chat "Saved" column, per-run sentence).
 * Never netted against cache-write cost; never priced from the registry.
 *
 * A read-only async Server Component (renders on the server only): every number comes from
 * rows the run handler (02-05) already wrote into the schema owned by 02-01
 * (`usage_events`, `chats`, `runs`, `messages`) — never re-estimated, never
 * tiktoken. Money is the STORED provider-reported `cost_usd`; per-class tile
 * dollars decompose STORED event-time per-1M prices through `lib/pricing.ts`.
 * `lib/registry.ts` is used ONLY to map a model id to a display label (never a
 * price). Reads are RLS-scoped by the anon-key server client AND a defensive
 * `.eq('user_id', userId)` (T-02-06-01: no cross-account read). No service-role
 * client, no mutating path — this is a pure consumer.
 *
 * Auth: the (app) layout is the authoritative guard; this page re-derives
 * `userId` (getClaims() -> getUser() fallback) only to scope its queries and
 * redirects defensively if absent (T-02-06-04).
 */

// ---- Row shapes (bound to the ACTUAL 0002_chat_agent.sql identifiers) ----
interface UsageRow {
  chat_id: string;
  run_id: string;
  model_id: string | null;
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
interface ChatRow {
  id: string;
  title: string | null;
  model_id: string;
}
interface MessageRow {
  chat_id: string;
  role: string;
  content: string | null;
  created_at: string;
  run_id: string | null;
}
interface RunRow {
  id: string;
  chat_id: string;
  model_id: string;
  status: "running" | "succeeded" | "failed" | "budget_exhausted";
  started_at: string;
}

// ---- Formatting: NaN-safe, tabular. Money >= 3 fractional digits. ----
function safe(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}
function formatUsd(n: number | null | undefined): string {
  return `$${safe(n).toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 4,
  })}`;
}
function formatTokens(n: number | null | undefined): string {
  return safe(n).toLocaleString("en-US");
}
function formatPrice(n: number | null | undefined): string {
  return `$${safe(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

/**
 * One token-class's dollar contribution, computed by feeding STORED event-time
 * price + token count to lib/pricing.ts (never the registry, never estimated).
 */
function classDollar(tokens: number, pricePer1M: number): number {
  return costUsd(
    {
      inputTokens: safe(tokens),
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    {
      inputPer1M: safe(pricePer1M),
      outputPer1M: 0,
      cacheReadPer1M: 0,
      cacheWritePer1M: 0,
    },
  );
}

function modelLabel(id: string | null | undefined): string {
  if (!id) return "—";
  return getModel(id)?.label ?? id;
}

export default async function StatsPage() {
  const supabase = await createClient();

  // Re-derive the caller's id (the layout already enforced auth).
  let userId: string | undefined;
  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{
      data: { claims?: { sub?: string } } | null;
    }>;
  };
  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    userId = data?.claims?.sub;
  } else {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
  }
  if (!userId) redirect("/");

  // RLS-scoped reads. On any query error, log server-side only and degrade to
  // the zero/empty state — never surface a raw Postgres error (T-02-06-03).
  let usage: UsageRow[] = [];
  let chats: ChatRow[] = [];
  let messages: MessageRow[] = [];
  let runs: RunRow[] = [];
  try {
    const [usageRes, chatsRes, messagesRes, runsRes] = await Promise.all([
      supabase
        .from("usage_events")
        .select(
          "chat_id, run_id, model_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, input_price_per_1m, output_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, cost_usd",
        )
        .eq("user_id", userId),
      supabase
        .from("chats")
        .select("id, title, model_id")
        .eq("user_id", userId),
      supabase
        .from("messages")
        .select("chat_id, role, content, created_at, run_id")
        .eq("user_id", userId),
      supabase
        .from("runs")
        .select("id, chat_id, model_id, status, started_at")
        .eq("user_id", userId),
    ]);
    if (usageRes.error) throw usageRes.error;
    if (chatsRes.error) throw chatsRes.error;
    if (messagesRes.error) throw messagesRes.error;
    if (runsRes.error) throw runsRes.error;
    usage = (usageRes.data ?? []) as UsageRow[];
    chats = (chatsRes.data ?? []) as ChatRow[];
    messages = (messagesRes.data ?? []) as MessageRow[];
    runs = (runsRes.data ?? []) as RunRow[];
  } catch (err) {
    console.error("[/app/stats] usage read failed", err);
    usage = [];
    chats = [];
    messages = [];
    runs = [];
  }

  // ---- Grand totals (STAT-03) ----
  const totals = {
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    inputUsd: 0,
    outputUsd: 0,
    cacheReadUsd: 0,
    cacheWriteUsd: 0,
    savedUsd: 0,
  };
  const chatIds = new Set<string>();
  const runIds = new Set<string>();
  for (const u of usage) {
    totals.cost += safe(u.cost_usd);
    totals.input += safe(u.input_tokens);
    totals.output += safe(u.output_tokens);
    totals.cacheRead += safe(u.cache_read_tokens);
    totals.cacheWrite += safe(u.cache_write_tokens);
    totals.inputUsd += classDollar(u.input_tokens, u.input_price_per_1m);
    totals.outputUsd += classDollar(u.output_tokens, u.output_price_per_1m);
    totals.cacheReadUsd += classDollar(
      u.cache_read_tokens,
      u.cache_read_price_per_1m,
    );
    totals.cacheWriteUsd += classDollar(
      u.cache_write_tokens,
      u.cache_write_price_per_1m,
    );
    totals.savedUsd += savingsUsd(
      u.cache_read_tokens,
      u.input_price_per_1m,
      u.cache_read_price_per_1m,
    );
    if (u.chat_id) chatIds.add(u.chat_id);
    if (u.run_id) runIds.add(u.run_id);
  }

  // ---- Per-chat rollup (STAT-02) ----
  const chatMeta = new Map<string, ChatRow>();
  for (const c of chats) chatMeta.set(c.id, c);

  // WR-06: conversation TURNS only. `messages` also carries internal rows — one
  // insert plus one status update per tool call, the run-meter carrier, the plan
  // card and the artifact carrier are all role='tool' in the same table — so a
  // per-row count reported ~21 messages for a 4-message chat. The helper's
  // allow-list (user | assistant) keeps any future internal role out by default.
  const messageCount = countConversationMessages(messages);

  interface ChatAgg {
    chatId: string;
    title: string;
    modelId: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    saved: number;
    messages: number;
  }
  const chatAggMap = new Map<string, ChatAgg>();
  for (const u of usage) {
    let agg = chatAggMap.get(u.chat_id);
    if (!agg) {
      const meta = chatMeta.get(u.chat_id);
      agg = {
        chatId: u.chat_id,
        title: meta?.title?.trim() || "Untitled chat",
        modelId: meta?.model_id ?? u.model_id ?? "",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        saved: 0,
        messages: messageCount.get(u.chat_id) ?? 0,
      };
      chatAggMap.set(u.chat_id, agg);
    }
    agg.input += safe(u.input_tokens);
    agg.output += safe(u.output_tokens);
    agg.cacheRead += safe(u.cache_read_tokens);
    agg.cacheWrite += safe(u.cache_write_tokens);
    agg.cost += safe(u.cost_usd);
    agg.saved += savingsUsd(
      u.cache_read_tokens,
      u.input_price_per_1m,
      u.cache_read_price_per_1m,
    );
  }
  const chatAggs = [...chatAggMap.values()].sort((a, b) => b.cost - a.cost);

  // ---- Per-run drill-down (STAT-04) ----
  // Group usage rows by run_id; per-run token/cost sums + STORED event-time
  // prices (constant per run — taken from any usage row of that run).
  interface RunAgg {
    runId: string;
    modelId: string;
    status: RunRow["status"];
    startedAt: string;
    label: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    saved: number;
    hasPrices: boolean;
    inputPrice: number;
    outputPrice: number;
    cacheReadPrice: number;
    cacheWritePrice: number;
  }

  const usageByRun = new Map<string, UsageRow[]>();
  for (const u of usage) {
    if (!u.run_id) continue;
    const list = usageByRun.get(u.run_id);
    if (list) list.push(u);
    else usageByRun.set(u.run_id, [u]);
  }

  // Earliest user-message text per run (best-effort query label, STAT-04).
  const userMsgByRun = new Map<string, MessageRow>();
  for (const m of messages) {
    if (!m.run_id || m.role !== "user") continue;
    const cur = userMsgByRun.get(m.run_id);
    if (!cur || m.created_at < cur.created_at) userMsgByRun.set(m.run_id, m);
  }
  function truncate(s: string, max = 72): string {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }
  function runQueryLabel(run: RunRow): string {
    const msg = userMsgByRun.get(run.id);
    if (msg?.content && msg.content.trim().length > 0) {
      return truncate(msg.content);
    }
    // Fallback: the run's start time (no resolvable user message).
    const d = new Date(run.started_at);
    return Number.isNaN(d.getTime())
      ? "Research run"
      : `Run · ${d.toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        })}`;
  }

  // Runs grouped by chat, ordered by started_at (ascending).
  const runsByChat = new Map<string, RunAgg[]>();
  const sortedRuns = [...runs].sort((a, b) =>
    a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0,
  );
  for (const run of sortedRuns) {
    const rows = usageByRun.get(run.id) ?? [];
    const first = rows[0];
    const agg: RunAgg = {
      runId: run.id,
      modelId: run.model_id ?? first?.model_id ?? "",
      status: run.status,
      startedAt: run.started_at,
      label: runQueryLabel(run),
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      saved: 0,
      hasPrices: rows.length > 0,
      inputPrice: safe(first?.input_price_per_1m),
      outputPrice: safe(first?.output_price_per_1m),
      cacheReadPrice: safe(first?.cache_read_price_per_1m),
      cacheWritePrice: safe(first?.cache_write_price_per_1m),
    };
    for (const u of rows) {
      agg.input += safe(u.input_tokens);
      agg.output += safe(u.output_tokens);
      agg.cacheRead += safe(u.cache_read_tokens);
      agg.cacheWrite += safe(u.cache_write_tokens);
      agg.cost += safe(u.cost_usd);
      agg.saved += savingsUsd(
        u.cache_read_tokens,
        u.input_price_per_1m,
        u.cache_read_price_per_1m,
      );
    }
    const list = runsByChat.get(run.chat_id);
    if (list) list.push(agg);
    else runsByChat.set(run.chat_id, [agg]);
  }

  const hasUsage = usage.length > 0;

  const hasSavings = totals.savedUsd > 0;

  const tiles: {
    label: string;
    value: string;
    sub: string;
    accent?: boolean;
    tone?: "success" | "muted";
  }[] =
    [
      {
        label: "All-time spend",
        value: formatUsd(totals.cost),
        sub: `across ${formatTokens(chatIds.size)} chats · ${formatTokens(
          runIds.size,
        )} runs`,
        accent: true,
      },
      {
        label: "Input tokens",
        value: formatTokens(totals.input),
        sub: formatUsd(totals.inputUsd),
      },
      {
        label: "Output tokens",
        value: formatTokens(totals.output),
        sub: formatUsd(totals.outputUsd),
      },
      {
        label: "Cache read",
        value: formatTokens(totals.cacheRead),
        sub: formatUsd(totals.cacheReadUsd),
      },
      {
        label: "Cache write",
        value: formatTokens(totals.cacheWrite),
        sub: formatUsd(totals.cacheWriteUsd),
      },
      {
        // STAT-05 (D-53): GROSS savings, muted $0.000 at zero — never green.
        label: "Cache savings",
        value: hasSavings ? `~${formatUsd(totals.savedUsd)}` : formatUsd(0),
        sub: "cache read vs. input price",
        tone: hasSavings ? "success" : "muted",
      },
    ];

  return (
    <div className="mx-auto w-full max-w-[860px] self-start px-8 py-[34px]">
      <style>{STATS_CSS}</style>

      <h1 className="m-0 text-[24px] font-[650] tracking-[-.02em]">
        Cost &amp; usage
      </h1>
      <p className="mb-6 mt-2 max-w-[64ch] text-[14.5px] leading-[1.6] text-[var(--text-2)]">
        Every model call is metered from provider-reported token counts. Click a
        chat to see its per-run breakdown and the exact per-1M prices used.
      </p>

      {!hasUsage ? (
        /* Designed empty state (UX-02) — never a blank table/canvas. */
        <div className="mx-auto mt-6 max-w-[460px] text-center">
          <div
            aria-hidden="true"
            className="mx-auto mb-[22px] grid h-16 w-16 place-items-center rounded-[18px] border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)]"
            style={{ boxShadow: "var(--shadow)" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[30px] w-[30px]"
            >
              <path d="M3 3v18h18" />
              <path d="m19 9-5 5-4-4-3 3" />
            </svg>
          </div>
          <h2 className="mb-[10px] text-[22px] tracking-[-0.02em]">
            No usage yet
          </h2>
          <p className="text-[14.5px] leading-[1.6] text-[var(--text-2)]">
            Run your first research question and its metered cost will appear
            here — broken down by token class, with the exact per-1M prices used.
          </p>
        </div>
      ) : (
        <>
          {/* Grand-total stat strip (STAT-03) — 5 tiles: spend + all four classes. */}
          <div className="stats-strip">
            {tiles.map((t) => (
              <div key={t.label} className="stats-tile">
                <div className="stats-tile-label">{t.label}</div>
                <div
                  className={`stats-tile-value${t.accent ? " accent" : ""}${
                    t.tone ? ` ${t.tone}` : ""
                  }`}
                >
                  {t.value}
                </div>
                <div className="stats-tile-sub">{t.sub}</div>
              </div>
            ))}
          </div>

          {/* STAT-05 headline note — locked copy, GROSS figure (D-53). */}
          <p className="stats-savings-note">
            {hasSavings
              ? `Cache read saved ~${formatUsd(
                  totals.savedUsd,
                )} across all runs. Cache-write cost is shown in its own tile.`
              : "No cached tokens yet — savings appear once a provider reports cache reads."}
          </p>

          {/* Per-chat cost table (STAT-02) — CSS grid, header + one row per chat. */}
          <div className="stats-scroll">
        <div className="stats-table">
          <div className="stats-thead">
            <span>Chat</span>
            <span>Model</span>
            <span className="num">Input</span>
            <span className="num">Output</span>
            <span className="num">Cache read</span>
            <span className="num">Cache write</span>
            <span className="num">Saved</span>
            <span className="num">Cost</span>
          </div>
          {chatAggs.map((c) => {
            const chatRuns = runsByChat.get(c.chatId) ?? [];
            return (
              <details key={c.chatId} className="stats-row">
                <summary className="stats-summary">
                  <span className="stats-chat">
                    <svg
                      className="stats-chev"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                    <span className="stats-chat-title">{c.title}</span>
                    <span className="stats-chat-meta">
                      · {formatTokens(c.messages)} messages
                    </span>
                  </span>
                  <span className="stats-model">{modelLabel(c.modelId)}</span>
                  <span className="num">{formatTokens(c.input)}</span>
                  <span className="num">{formatTokens(c.output)}</span>
                  <span className="num">{formatTokens(c.cacheRead)}</span>
                  <span className="num">{formatTokens(c.cacheWrite)}</span>
                  <span className={`num${c.saved > 0 ? " saved" : ""}`}>
                    {formatUsd(c.saved)}
                  </span>
                  <span className="num total">{formatUsd(c.cost)}</span>
                </summary>

                <div className="stats-drill">
                  <h4 className="stats-drill-h">
                    Per-run breakdown · {formatTokens(chatRuns.length)} runs
                  </h4>
                  {chatRuns.length === 0 ? (
                    <p className="stats-pricenote">
                      No metered runs recorded for this chat yet.
                    </p>
                  ) : (
                    chatRuns.map((r) => (
                      <div key={r.runId}>
                        <div className="stats-run-line">
                          <span className="rq">
                            {r.label}
                            {r.status === "budget_exhausted" && (
                              <span className="stats-budget">
                                {" "}
                                (ran out of compute time)
                              </span>
                            )}
                          </span>
                          <span className="rc">
                            {formatTokens(r.input)}
                            <small>input</small>
                          </span>
                          <span className="rc">
                            {formatTokens(r.output)}
                            <small>output</small>
                          </span>
                          <span className="rc">
                            {formatTokens(r.cacheRead)}
                            <small>cache read</small>
                          </span>
                          <span className="rc">
                            {formatTokens(r.cacheWrite)}
                            <small>cache write</small>
                          </span>
                          <span className="rt">{formatUsd(r.cost)}</span>
                        </div>
                        {r.hasPrices && (
                          <p className="stats-pricenote">
                            Priced at <code>{r.modelId || "—"}</code>: input{" "}
                            <code>{formatPrice(r.inputPrice)}</code>/1M · output{" "}
                            <code>{formatPrice(r.outputPrice)}</code>/1M · cache
                            read <code>{formatPrice(r.cacheReadPrice)}</code>/1M ·
                            cache write{" "}
                            <code>{formatPrice(r.cacheWritePrice)}</code>/1M.{" "}
                            {"Cost = Σ(tokens ÷ 1e6 × price) per class."}{" "}
                            {`Cache read saved ~${formatUsd(
                              r.saved,
                            )} on this run (gross — cache-write cost is listed above).`}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </details>
            );
          })}
            </div>
          </div>
          <p className="mt-[14px] text-[11.5px] leading-[1.6] text-[var(--text-3)]">
            Click any chat row to expand its per-run drill-down.
          </p>
        </>
      )}
    </div>
  );
}

// Server-rendered global CSS (pure RSC; zero client JS). Compositor-only motion,
// wrapped in prefers-reduced-motion. Tokens only — no raw hex.
const STATS_CSS = `
.stats-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin-bottom:22px}
.stats-tile{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 15px;box-shadow:var(--shadow-sm)}
.stats-tile-label{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);margin-bottom:7px}
.stats-tile-value{font-family:var(--mono);font-size:19px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.stats-tile-value.accent{color:var(--accent)}
.stats-tile-value.success{color:var(--success)}
.stats-tile-value.muted{color:var(--text-2)}
.stats-tile-sub{font-size:11px;color:var(--text-3);margin-top:4px;font-variant-numeric:tabular-nums}
.stats-savings-note{font-size:12.5px;color:var(--text-2);margin-top:-10px;margin-bottom:22px;line-height:1.5}
.stats-scroll{overflow-x:auto}
.stats-table{min-width:720px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.stats-thead,.stats-summary{display:grid;grid-template-columns:minmax(200px,1fr) 128px repeat(6,minmax(70px,max-content));gap:14px;align-items:center;padding:11px 16px}
.stats-thead{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);background:var(--surface-2);border-bottom:1px solid var(--border)}
.stats-summary{border-bottom:1px solid var(--border);font-size:13px}
.stats-summary:last-child{border-bottom:0}
.stats-thead .num,.stats-summary .num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text-2)}
.stats-summary .num.total{font-weight:650;color:var(--text)}
.stats-summary .num.saved{color:var(--success)}
.stats-chat{display:flex;align-items:center;gap:8px;min-width:0}
.stats-chat-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stats-chat-meta{font-size:11.5px;color:var(--text-3);white-space:nowrap}
.stats-model{font-family:var(--mono);font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stats-row{border-bottom:1px solid var(--border)}
.stats-row:last-child{border-bottom:0}
.stats-summary{cursor:pointer;list-style:none;transition:background .12s}
.stats-summary::-webkit-details-marker{display:none}
.stats-summary:hover{background:var(--surface-2)}
.stats-summary:focus-visible{outline:none;box-shadow:inset 0 0 0 3px var(--accent-soft)}
.stats-chev{width:13px;height:13px;flex:none;color:var(--text-3);transition:transform .15s}
.stats-row[open] .stats-chev{transform:rotate(90deg)}
.stats-drill{padding:2px 16px 16px 34px;background:var(--surface-2)}
.stats-drill-h{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);margin:12px 0 8px;font-weight:600}
.stats-run-line{display:grid;grid-template-columns:1fr repeat(4,minmax(84px,auto)) minmax(64px,auto);gap:14px;align-items:center;padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);margin-bottom:6px;font-size:12px}
.stats-run-line .rq{font-weight:550;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis}
.stats-run-line .rc{font-family:var(--mono);color:var(--text-2);text-align:right;font-variant-numeric:tabular-nums}
.stats-run-line .rc small{color:var(--text-3);font-size:10px;display:block}
.stats-run-line .rt{font-family:var(--mono);font-weight:650;text-align:right;color:var(--text);font-variant-numeric:tabular-nums}
.stats-budget{color:var(--warning);font-weight:600}
.stats-pricenote{font-size:11px;color:var(--text-3);margin:2px 0 12px;line-height:1.5}
.stats-pricenote code{font-family:var(--mono);background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
@media (prefers-reduced-motion: reduce){.stats-chev,.stats-summary{transition:none}}
`;
