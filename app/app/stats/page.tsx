import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { costUsd } from "@/lib/pricing";
import { getModel } from "@/lib/registry";

/**
 * /app/stats — Cost & usage (STAT-02, STAT-03, UX-02; D-16).
 *
 * A read-only async Server Component (no "use client"): every number comes from
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
  try {
    const [usageRes, chatsRes, messagesRes] = await Promise.all([
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
    ]);
    if (usageRes.error) throw usageRes.error;
    if (chatsRes.error) throw chatsRes.error;
    if (messagesRes.error) throw messagesRes.error;
    usage = (usageRes.data ?? []) as UsageRow[];
    chats = (chatsRes.data ?? []) as ChatRow[];
    messages = (messagesRes.data ?? []) as MessageRow[];
  } catch (err) {
    console.error("[/app/stats] usage read failed", err);
    usage = [];
    chats = [];
    messages = [];
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
    if (u.chat_id) chatIds.add(u.chat_id);
    if (u.run_id) runIds.add(u.run_id);
  }

  // ---- Per-chat rollup (STAT-02) ----
  const chatMeta = new Map<string, ChatRow>();
  for (const c of chats) chatMeta.set(c.id, c);

  const messageCount = new Map<string, number>();
  for (const m of messages) {
    messageCount.set(m.chat_id, (messageCount.get(m.chat_id) ?? 0) + 1);
  }

  interface ChatAgg {
    chatId: string;
    title: string;
    modelId: string;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
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
        messages: messageCount.get(u.chat_id) ?? 0,
      };
      chatAggMap.set(u.chat_id, agg);
    }
    agg.input += safe(u.input_tokens);
    agg.output += safe(u.output_tokens);
    agg.cacheRead += safe(u.cache_read_tokens);
    agg.cacheWrite += safe(u.cache_write_tokens);
    agg.cost += safe(u.cost_usd);
  }
  const chatAggs = [...chatAggMap.values()].sort((a, b) => b.cost - a.cost);

  const tiles: { label: string; value: string; sub: string; accent?: boolean }[] =
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

      {/* Grand-total stat strip (STAT-03) — 5 tiles: spend + all four classes. */}
      <div className="stats-strip">
        {tiles.map((t) => (
          <div key={t.label} className="stats-tile">
            <div className="stats-tile-label">{t.label}</div>
            <div className={`stats-tile-value${t.accent ? " accent" : ""}`}>
              {t.value}
            </div>
            <div className="stats-tile-sub">{t.sub}</div>
          </div>
        ))}
      </div>

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
            <span className="num">Cost</span>
          </div>
          {chatAggs.map((c) => (
            <div key={c.chatId} className="stats-summary">
              <span className="stats-chat">
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
              <span className="num total">{formatUsd(c.cost)}</span>
            </div>
          ))}
        </div>
      </div>
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
.stats-tile-sub{font-size:11px;color:var(--text-3);margin-top:4px;font-variant-numeric:tabular-nums}
.stats-scroll{overflow-x:auto}
.stats-table{min-width:640px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.stats-thead,.stats-summary{display:grid;grid-template-columns:minmax(200px,1fr) 128px repeat(5,minmax(70px,max-content));gap:14px;align-items:center;padding:11px 16px}
.stats-thead{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-3);background:var(--surface-2);border-bottom:1px solid var(--border)}
.stats-summary{border-bottom:1px solid var(--border);font-size:13px}
.stats-summary:last-child{border-bottom:0}
.stats-thead .num,.stats-summary .num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;color:var(--text-2)}
.stats-summary .num.total{font-weight:650;color:var(--text)}
.stats-chat{display:flex;align-items:baseline;gap:7px;min-width:0}
.stats-chat-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stats-chat-meta{font-size:11.5px;color:var(--text-3);white-space:nowrap}
.stats-model{font-family:var(--mono);font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;
