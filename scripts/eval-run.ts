/**
 * scripts/eval-run.ts — deterministic post-run eval checker (AI-SPEC § 5.2, § 7).
 *
 * READ-ONLY against the live database (service-role, .select() only — this
 * script NEVER mutates a row). No model calls, no cost, no re-fetch: every
 * check runs over rows the run itself persisted (runs / usage_events /
 * messages / artifacts). The trace IS product data — Arize Phoenix stays
 * overridden (AI-SPEC § 5.2, five grounds).
 *
 * Run: `npm run eval:offline -- --last N` or `npm run eval:offline -- --run <uuid>`
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (NEXT_PUBLIC_* fallbacks accepted),
 * exactly like scripts/rls-probe.ts (CM-8: server-side script, never app code).
 *
 * Per run it prints one block with PASS/FLAG/FAIL per check:
 *   EV-01  citation resolvability (max [n] <= registry size; dense server numbering;
 *          "Also found" search hits never numbered)
 *   EV-03  quoted-span verbatim check against the STORED extraction of the cited
 *          source (whitespace/quote-normalized; ellipsis fragments independently;
 *          near-misses flagged for human adjudication)
 *   EV-04  distinct eTLD+1 count + pairwise title-similarity syndication flags
 *   EV-05  assist print (n · domain · title · date-if-present) — human judges on data
 *   EV-12/14 cost recompute from the four token columns x four STORED prices
 *          (tolerance 1e-9), savings recompute via the same arithmetic as
 *          lib/pricing.ts savingsUsd, count(usage_events) vs runs.iterations
 *   EV-11/15/16 truncation-note hygiene, stuck non-terminal runs (>6 min),
 *          iterations/elapsed vs the 12 / 240s caps, meter-carrier honesty
 *   EV-10  artifacts terminal hygiene (any 'pending' older than 2 minutes fails)
 * and ends with the AI-SPEC § 7 triage-signal list so "which run do I open
 * first" is answered mechanically.
 *
 * Exit code: non-zero when any Critical check fails (EV-01 / EV-03 / EV-12 /
 * EV-14 / EV-10). FLAGs never change the exit code — they order human review.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ============================ env (rls-probe convention) ============================
function requireEnv(...names: string[]): string {
  for (const n of names) {
    const raw = process.env[n];
    if (raw == null) continue;
    const v = raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
    if (v.length > 0) return v;
  }
  throw new Error(`Missing required env var (one of: ${names.join(", ")}).`);
}

const SUPABASE_URL = requireEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;

/** Service-role client — READ ONLY in this script (T-3-70: reads only). */
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noPersist);
}

// ============================ CLI ============================
interface CliArgs {
  runId?: string;
  last: number;
}
function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { last: 5 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run" && argv[i + 1]) out.runId = argv[++i];
    else if (argv[i] === "--last" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.last = Math.floor(n);
    }
  }
  return out;
}

// ============================ row shapes (0002/0006 identifiers) ============================
interface RunRow {
  id: string;
  chat_id: string;
  user_id: string;
  model_id: string;
  status: string;
  iterations: number;
  started_at: string;
  ended_at: string | null;
}
interface UsageRow {
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
interface MessageRow {
  id: string;
  role: string;
  content: string | null;
  created_at: string;
}
interface ArtifactRow {
  id: string;
  status: string;
  created_at: string;
  title: string;
}
/** Persisted role='tool' JSON payload (03-03/03-04 locked contract, additive fields ok). */
interface ToolPayload {
  id?: string;
  tool?: string;
  kind?: string;
  state?: string;
  url?: string;
  domain?: string;
  n?: number;
  title?: string;
  extract?: string;
  iterations?: number;
  elapsedMs?: number;
  results?: { title?: string; url?: string; domain?: string; n?: number }[];
}
interface RegistryEntry {
  n: number;
  url: string;
  title: string;
  domain: string;
  extract: string | null;
}

// ============================ money arithmetic (mirrors lib/pricing.ts) ============================
/**
 * Recompute cost EXACTLY like lib/pricing.ts costUsd (same term order, same
 * finite-coercion) so a stored cost_usd that came from that function matches
 * to 1e-9. Duplicated (not imported) because node type-stripping cannot
 * resolve the "@/..." alias graph — keep in sync with lib/pricing.ts.
 */
function finite(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  return Number.isFinite(n) ? n : 0;
}
function recomputeCostUsd(u: UsageRow): number {
  const line = (tokens: unknown, price: unknown): number =>
    (finite(tokens) / 1_000_000) * finite(price);
  return (
    line(u.input_tokens, u.input_price_per_1m) +
    line(u.output_tokens, u.output_price_per_1m) +
    line(u.cache_read_tokens, u.cache_read_price_per_1m) +
    line(u.cache_write_tokens, u.cache_write_price_per_1m)
  );
}
/** Same arithmetic + invariants as lib/pricing.ts savingsUsd (D-53): non-finite → 0 whole, clamp >= 0. */
function recomputeSavingsUsd(
  cacheReadTokens: number,
  inputPricePer1M: number,
  cacheReadPricePer1M: number,
): number {
  if (
    !Number.isFinite(cacheReadTokens) ||
    !Number.isFinite(inputPricePer1M) ||
    !Number.isFinite(cacheReadPricePer1M)
  ) {
    return 0;
  }
  return Math.max(
    0,
    (cacheReadTokens / 1_000_000) * (inputPricePer1M - cacheReadPricePer1M),
  );
}

// ============================ text utilities ============================
/** Citation markers [n] in a text, in document order. */
function citationNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) out.push(Number(m[1]));
  return out;
}

/**
 * Sentence segmentation over the terminal answer. Deterministic and simple:
 * split on newlines and on ".!?" followed by whitespace. Good enough for
 * locating which sentence a quote or citation lives in — never used to score.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Normalize for verbatim comparison: curly→straight quotes, collapse whitespace. */
function normalizeForMatch(s: string): string {
  return s
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Double-quoted spans (straight or curly) matched over the WHOLE answer (a
 * quote may contain ". " that the sentence splitter would cut), each paired
 * with its containing sentence — the region between the nearest sentence
 * boundary/newline before the opening quote and after the closing quote —
 * so "the source cited on that sentence" can be resolved.
 */
function quotedSpans(text: string): { span: string; sentence: string }[] {
  const out: { span: string; sentence: string }[] = [];
  for (const m of text.matchAll(/"([^"]{3,600})"|“([^”]{3,600})”/g)) {
    const span = (m[1] ?? m[2] ?? "").replace(/\s+/g, " ").trim();
    if (span.split(/\s+/).length < 4) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    let s = start;
    while (s > 0 && text[s - 1] !== "\n" && !/[.!?]/.test(text[s - 1])) s--;
    let e = end;
    while (e < text.length && text[e] !== "\n" && !/[.!?]/.test(text[e])) e++;
    if (e < text.length) e++;
    out.push({ span, sentence: text.slice(s, e) });
  }
  return out;
}

/**
 * Registrable domain (eTLD+1), dependency-free approximation: last two labels,
 * or last three when the penultimate label is a well-known second-level public
 * suffix (co.uk, com.au, …). Good enough to count "distinct publishers".
 */
const SECOND_LEVEL_SUFFIX = new Set([
  "co", "com", "net", "org", "gov", "ac", "edu", "or", "ne", "go",
]);
function etldPlusOne(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (tld.length === 2 && SECOND_LEVEL_SUFFIX.has(second)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

/** Token-set Dice similarity between two titles (syndication flagging). */
function titleSimilarity(a: string, b: string): number {
  const tok = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const A = tok(a);
  const B = tok(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** Date-if-present: scan url + title for a year/month-ish signal (EV-05 assist). */
function dateHint(url: string, title: string): string {
  const hay = `${url} ${title}`;
  const iso = hay.match(/\b(20\d{2})[-/](\d{1,2})(?:[-/](\d{1,2}))?\b/);
  if (iso) return iso[0];
  const month = hay.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\.?\s+\d{1,2},?\s+20\d{2}\b/i,
  );
  if (month) return month[0];
  const year = hay.match(/\b20\d{2}\b/);
  return year ? year[0] : "—";
}

/** Locked-copy markers (lib/agent/loop.ts INCOMPLETE_COPY / CONTEXT_TOO_LONG_COPY). */
const INCOMPLETE_MARKER = "answer may be incomplete";
const CONTEXT_MARKER = "got too long for the model";
/** Heuristic: does the terminal answer end like a finished sentence/block? */
function endsCleanly(text: string): boolean {
  const t = text.trimEnd();
  if (t.length === 0) return false;
  if (t.endsWith("```")) return true;
  return /[.!?:…"'”’)\]|_*`]$/.test(t);
}

// ============================ per-run verdict plumbing ============================
type Level = "PASS" | "FLAG" | "FAIL";
interface Verdict {
  check: string;
  level: Level;
  detail: string;
  critical: boolean;
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function auditRun(
  admin: SupabaseClient,
  run: RunRow,
): Promise<{ verdicts: Verdict[]; triage: string[] }> {
  const verdicts: Verdict[] = [];
  const triage: string[] = [];
  const add = (check: string, level: Level, detail: string, critical = false): void => {
    verdicts.push({ check, level, detail, critical });
  };

  // ---- load the run's rows (read-only) ----
  const [msgRes, usageRes, artRes, chatMsgRes] = await Promise.all([
    admin
      .from("messages")
      .select("id, role, content, created_at")
      .eq("run_id", run.id)
      .order("created_at", { ascending: true }),
    admin
      .from("usage_events")
      .select(
        "input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, input_price_per_1m, output_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, cost_usd",
      )
      .eq("run_id", run.id),
    admin.from("artifacts").select("id, status, created_at, title").eq("run_id", run.id),
    admin
      .from("messages")
      .select("id, role, content, created_at")
      .eq("chat_id", run.chat_id),
  ]);
  for (const [name, res] of [
    ["messages", msgRes],
    ["usage_events", usageRes],
    ["artifacts", artRes],
    ["chat messages", chatMsgRes],
  ] as const) {
    if (res.error) throw new Error(`${name} read failed for run ${run.id}: ${res.error.message}`);
  }
  const messages = (msgRes.data ?? []) as MessageRow[];
  const usage = (usageRes.data ?? []) as UsageRow[];
  const artifacts = (artRes.data ?? []) as ArtifactRow[];
  const chatMessages = (chatMsgRes.data ?? []) as MessageRow[];

  // ---- parse tool rows into the registry + search results + carriers ----
  const registryByN = new Map<number, RegistryEntry>();
  const searchResults: { title?: string; url?: string; n?: number }[] = [];
  let meter: ToolPayload | null = null;
  let duplicateMint = false;
  for (const m of messages) {
    if (m.role !== "tool" || !m.content) continue;
    let p: ToolPayload;
    try {
      p = JSON.parse(m.content) as ToolPayload;
    } catch {
      continue;
    }
    if (p.kind === "meter") meter = p;
    if (p.tool === "web_search" && p.state === "done" && Array.isArray(p.results)) {
      searchResults.push(...p.results);
    }
    if (p.tool === "fetch_page" && p.state === "done" && typeof p.n === "number") {
      const existing = registryByN.get(p.n);
      if (existing && existing.url !== (p.url ?? "")) duplicateMint = true;
      registryByN.set(p.n, {
        n: p.n,
        url: p.url ?? "",
        title: p.title ?? "",
        domain: p.domain ?? "",
        extract: typeof p.extract === "string" ? p.extract : null,
      });
    }
  }
  const registry = [...registryByN.values()].sort((a, b) => a.n - b.n);
  const registrySize = registry.length;

  // ---- terminal answer = the run's assistant row (terminal-once write) ----
  const assistantRows = messages.filter((m) => m.role === "assistant");
  const answer = (assistantRows[assistantRows.length - 1]?.content ?? "").trim();

  // ============ EV-01 — citation resolvability & registry integrity (Critical) ============
  {
    const cited = citationNumbers(answer);
    const maxCited = cited.length > 0 ? Math.max(...cited) : 0;
    const dense =
      registry.every((e, i) => e.n === i + 1) && !duplicateMint;
    const numberedSearchHit = searchResults.some((r) => typeof r.n === "number");
    if (maxCited > registrySize) {
      add(
        "EV-01 citation resolvability",
        "FAIL",
        `max [n] cited = ${maxCited} but registry has ${registrySize} entr${registrySize === 1 ? "y" : "ies"} — an unregistered citation reached the reader`,
        true,
      );
    } else if (!dense) {
      add(
        "EV-01 citation resolvability",
        "FAIL",
        `registry numbering is not dense/unique (ns: ${registry.map((e) => e.n).join(",")})${duplicateMint ? " — two URLs share one n" : ""}`,
        true,
      );
    } else if (numberedSearchHit) {
      add(
        "EV-01 citation resolvability",
        "FAIL",
        `an "Also found" web_search hit carries a citation number — un-read hits must never be numbered`,
        true,
      );
    } else {
      add(
        "EV-01 citation resolvability",
        "PASS",
        `${cited.length} inline citation(s), max [n]=${maxCited}, registry=${registrySize} (dense, server-minted, no numbered search hits)`,
      );
    }
    if (maxCited > registrySize) triage.push("max [n] in answer > registry size");
  }

  // ============ EV-03 — quotation fidelity (Critical; code check, human on near-misses) ============
  {
    const spans = quotedSpans(answer);
    if (spans.length === 0) {
      add("EV-03 quotation fidelity", "PASS", "no double-quoted spans of >=4 words in the answer");
    } else {
      let failures = 0;
      let nearMisses = 0;
      let unverifiable = 0;
      const details: string[] = [];
      for (const { span, sentence } of spans) {
        const citedNs = citationNumbers(sentence);
        const sources = citedNs.length > 0 ? citedNs.map((n) => registryByN.get(n)).filter(Boolean) : registry;
        const scope = citedNs.length > 0 ? `cited [${citedNs.join(",")}]` : "no citation on the sentence — checked against ALL registered sources";
        const withExtract = (sources as RegistryEntry[]).filter((s) => s.extract);
        if (withExtract.length === 0) {
          unverifiable++;
          details.push(`UNVERIFIABLE (${scope}; no stored extraction — pre-03-07 run): "${span.slice(0, 60)}…"`);
          continue;
        }
        // Ellipsis fragments checked independently (rubric EV-03).
        const fragments = normalizeForMatch(span)
          .split(/\.{3}|…/)
          .map((f) => f.trim())
          .filter((f) => f.split(/\s+/).length >= 4);
        const checkOne = (needle: string, ci: boolean): boolean =>
          withExtract.some((s) => {
            const hay = normalizeForMatch(s.extract as string);
            return ci ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle);
          });
        const allVerbatim = fragments.every((f) => checkOne(f, false));
        if (allVerbatim) continue;
        const allCaseInsensitive = fragments.every((f) => checkOne(f, true));
        if (allCaseInsensitive) {
          nearMisses++;
          details.push(`NEAR-MISS (case differs; human adjudication): "${span.slice(0, 80)}"`);
        } else {
          failures++;
          details.push(`NOT FOUND in ${scope}: "${span.slice(0, 80)}"`);
        }
      }
      if (failures > 0) {
        add(
          "EV-03 quotation fidelity",
          "FAIL",
          `${failures}/${spans.length} quoted span(s) not verbatim in the cited source's stored extraction:\n      ${details.join("\n      ")}`,
          true,
        );
      } else if (nearMisses > 0 || unverifiable > 0) {
        add(
          "EV-03 quotation fidelity",
          "FLAG",
          `${spans.length} span(s): ${spans.length - nearMisses - unverifiable} verbatim, ${nearMisses} near-miss, ${unverifiable} unverifiable → human adjudication:\n      ${details.join("\n      ")}`,
        );
      } else {
        add("EV-03 quotation fidelity", "PASS", `${spans.length} quoted span(s), all verbatim in stored extractions`);
      }
    }
  }

  // ============ EV-04 — source independence (High; code count + syndication flags) ============
  {
    const domains = new Set(registry.map((e) => etldPlusOne(e.domain || e.url)));
    const pairs: string[] = [];
    for (let i = 0; i < registry.length; i++) {
      for (let j = i + 1; j < registry.length; j++) {
        const sim = titleSimilarity(registry[i].title, registry[j].title);
        if (sim >= 0.6) {
          pairs.push(`[${registry[i].n}]~[${registry[j].n}] title similarity ${sim.toFixed(2)}`);
        }
      }
    }
    if (registrySize >= 3 && domains.size < 3) {
      add(
        "EV-04 source independence",
        "FLAG",
        `${registrySize} sources span only ${domains.size} distinct eTLD+1 domain(s): ${[...domains].join(", ")}`,
      );
      triage.push("fewer than 3 distinct registered domains on a run with >=3 sources");
    } else {
      add(
        "EV-04 source independence",
        "PASS",
        `${registrySize} source(s) across ${domains.size} distinct eTLD+1 domain(s)`,
      );
    }
    if (pairs.length > 0) {
      add("EV-04 syndication flags", "FLAG", `possible syndication (human adjudicates): ${pairs.join("; ")}`);
    }
  }

  // ============ EV-05 assist — data for the human authority/recency judgement ============
  {
    const lines = registry.map(
      (e) => `[${e.n}] ${e.domain || "—"} · "${e.title}" · date: ${dateHint(e.url, e.title)}`,
    );
    add(
      "EV-05 assist (human judges)",
      "PASS",
      lines.length > 0 ? `\n      ${lines.join("\n      ")}` : "no registered sources",
    );
  }

  // ============ EV-12 / EV-14 — the money recomputes (Critical) ============
  {
    let worst = 0;
    let bad = 0;
    let savingsTotal = 0;
    for (const u of usage) {
      const delta = Math.abs(finite(u.cost_usd) - recomputeCostUsd(u));
      if (delta > worst) worst = delta;
      if (delta > 1e-9) bad++;
      savingsTotal += recomputeSavingsUsd(
        finite(u.cache_read_tokens),
        finite(u.input_price_per_1m),
        finite(u.cache_read_price_per_1m),
      );
    }
    if (bad > 0) {
      add(
        "EV-12/14 cost recompute",
        "FAIL",
        `${bad}/${usage.length} usage row(s) with |cost_usd − recompute| > 1e-9 (worst delta ${worst.toExponential(2)})`,
        true,
      );
    } else {
      add(
        "EV-12/14 cost recompute",
        "PASS",
        `${usage.length} usage row(s) reconcile to 1e-9 (worst delta ${worst.toExponential(2)}); savings recompute (D-53 gross) = $${savingsTotal.toFixed(6)}`,
      );
    }
    // count(usage_events) vs runs.iterations — the money-integrity tripwire.
    if (usage.length !== run.iterations) {
      const critical = run.status === "succeeded";
      add(
        "EV-12/14 rows-vs-iterations",
        critical ? "FAIL" : "FLAG",
        `count(usage_events)=${usage.length} vs runs.iterations=${run.iterations}${critical ? " on a succeeded run — a model call is missing its meter row" : ` (status=${run.status}: a pass may have died mid-call)`}`,
        critical,
      );
      triage.push("count(usage_events) <> runs.iterations");
    } else {
      add("EV-12/14 rows-vs-iterations", "PASS", `one usage row per pass (${usage.length} = ${run.iterations})`);
    }
  }

  // ============ EV-11 / EV-15 / EV-16 — truncation, budget, meter honesty (flags) ============
  {
    const hasNote = answer.includes(INCOMPLETE_MARKER) || answer.includes(CONTEXT_MARKER);
    if (answer.length > 0 && !endsCleanly(answer) && !hasNote) {
      add(
        "EV-11 truncation hygiene",
        "FLAG",
        `terminal answer ends mid-sentence ("…${answer.slice(-60).replace(/\n/g, " ")}") with NO incomplete note — read it by hand`,
      );
      triage.push("answer ends without a clean sentence terminator and carries no incomplete note");
    } else {
      add(
        "EV-11 truncation hygiene",
        "PASS",
        hasNote ? "incomplete/context note present (detector fired — verify it reads honestly)" : "answer ends cleanly",
      );
      if (hasNote) triage.push("assistant content carries the incomplete/context note");
    }

    const startedMs = Date.parse(run.started_at);
    const endedMs = run.ended_at ? Date.parse(run.ended_at) : NaN;
    const terminal = run.status !== "running";
    if (!terminal && Date.now() - startedMs > 6 * 60_000) {
      add(
        "EV-15 terminal hygiene",
        "FLAG",
        `runs.status='${run.status}' and started ${fmtMs(Date.now() - startedMs)} ago (>6 min) — stuck non-terminal run`,
      );
      triage.push("non-terminal run older than 6 minutes");
    } else if (terminal && Number.isFinite(endedMs)) {
      const elapsed = endedMs - startedMs;
      const overIter = run.iterations > 12;
      const overBudget = elapsed > 240_000;
      if (overIter) {
        add("EV-15 caps", "FLAG", `iterations=${run.iterations} exceeds the hard 12 cap — impossible by design, investigate`);
      } else if (overBudget) {
        add(
          "EV-15 caps",
          "FLAG",
          `elapsed ${fmtMs(elapsed)} > 240s self-budget (a final in-flight call may legitimately overrun; >300s means the platform cap was grazed)`,
        );
      } else {
        add("EV-15 caps", "PASS", `iterations ${run.iterations}/12 · elapsed ${fmtMs(elapsed)}/240s · status=${run.status}`);
      }
      if (run.iterations >= 10 || elapsed > 180_000) triage.push("near the caps (iterations >= 10 or elapsed > 180s)");
    } else {
      add("EV-15 terminal hygiene", "PASS", `status=${run.status} (recent, still settling)`);
    }

    if (meter) {
      if (typeof meter.iterations === "number" && meter.iterations !== run.iterations) {
        add(
          "EV-16 meter honesty",
          "FLAG",
          `meter carrier settled at iterations=${meter.iterations} but runs.iterations=${run.iterations} — a reopened tab would disagree with the live one`,
        );
      } else {
        add(
          "EV-16 meter honesty",
          "PASS",
          `meter carrier state=${meter.state ?? "?"} iterations=${meter.iterations ?? "?"} elapsed=${typeof meter.elapsedMs === "number" ? fmtMs(meter.elapsedMs) : "?"}`,
        );
      }
    } else {
      add("EV-16 meter honesty", "FLAG", "no meter carrier row persisted for this run");
    }
  }

  // ============ EV-10 — artifact settlement (Critical when stuck pending) ============
  {
    if (artifacts.length === 0) {
      add("EV-10 artifact settlement", "PASS", "no artifacts row for this run (no report queued)");
    } else {
      for (const a of artifacts) {
        const ageMs = Date.now() - Date.parse(a.created_at);
        if (a.status === "pending" && ageMs > 2 * 60_000) {
          add(
            "EV-10 artifact settlement",
            "FAIL",
            `artifacts row ${a.id} 'pending' for ${fmtMs(ageMs)} (>2 min) — the never-pending invariant broke`,
            true,
          );
          triage.push("artifact stuck at pending");
        } else if (a.status === "pending") {
          add("EV-10 artifact settlement", "FLAG", `artifacts row ${a.id} 'pending' (${fmtMs(ageMs)} old — watch it settle)`);
        } else {
          const note =
            a.status === "degraded" && run.status === "budget_exhausted"
              ? " (budget-exhausted + degraded is the EXPECTED, documented pairing)"
              : "";
          add("EV-10 artifact settlement", "PASS", `artifacts row ${a.id} terminal '${a.status}'${note}`);
          if (a.status === "degraded") triage.push("artifact degraded");
        }
      }
    }
  }

  // ============ remaining § 7 triage signals ============
  if (run.status !== "succeeded") triage.push(`runs.status='${run.status}' (non-clean ending)`);
  {
    const isClaude = run.model_id.startsWith("claude-");
    if (isClaude && usage.length >= 2 && usage.every((u) => finite(u.cache_read_tokens) === 0)) {
      triage.push("cache_read_tokens = 0 on a claude-* run with >=2 usage rows (D-49 regression signal)");
    }
    if (registrySize >= 3 && answer.length > 0 && answer.length < 400) {
      triage.push("answer under ~400 chars on a run that fetched >=3 sources (collapsed synthesis)");
    }
    const emptyAssistant = chatMessages.filter(
      (m) => m.role === "assistant" && (m.content ?? "").trim().length === 0,
    );
    if (emptyAssistant.length > 0) {
      triage.push(
        `chat history contains ${emptyAssistant.length} empty-content assistant row(s) — the D-57/D-59 signature (filter must hold on turn 2)`,
      );
    }
  }

  return { verdicts, triage };
}

// ============================ main ============================
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const admin = adminClient();

  let runs: RunRow[] = [];
  if (args.runId) {
    const { data, error } = await admin
      .from("runs")
      .select("id, chat_id, user_id, model_id, status, iterations, started_at, ended_at")
      .eq("id", args.runId);
    if (error) throw new Error(`runs read failed: ${error.message}`);
    runs = (data ?? []) as RunRow[];
    if (runs.length === 0) throw new Error(`no run found with id ${args.runId}`);
  } else {
    const { data, error } = await admin
      .from("runs")
      .select("id, chat_id, user_id, model_id, status, iterations, started_at, ended_at")
      .order("started_at", { ascending: false })
      .limit(args.last);
    if (error) throw new Error(`runs read failed: ${error.message}`);
    runs = (data ?? []) as RunRow[];
  }

  if (runs.length === 0) {
    console.log("eval-run: no runs found — run an eval question first (see eval/questions.md).");
    return;
  }

  let criticalFailures = 0;
  for (const run of runs) {
    console.log(
      `\n=== RUN ${run.id} · ${run.model_id} · ${run.status} · ${run.started_at} ===`,
    );
    const { verdicts, triage } = await auditRun(admin, run);
    for (const v of verdicts) {
      const tag = v.level === "FAIL" ? (v.critical ? "FAIL(critical)" : "FAIL") : v.level;
      console.log(`  ${tag.padEnd(14)} ${v.check}: ${v.detail}`);
      if (v.level === "FAIL" && v.critical) criticalFailures++;
    }
    console.log(
      triage.length > 0
        ? `  TRIAGE SIGNALS (open this run first):\n      - ${triage.join("\n      - ")}`
        : "  TRIAGE SIGNALS: none",
    );
  }

  console.log(
    `\neval-run: ${runs.length} run(s) audited · ${criticalFailures} critical failure(s).`,
  );
  if (criticalFailures > 0) {
    console.error("EVAL OFFLINE GATE: FAILED — a Critical check (EV-01/03/12/14/10) failed. Do not submit.");
    process.exitCode = 1;
  } else {
    console.log("EVAL OFFLINE GATE: no Critical failures (FLAGs, if any, order human review).");
  }
}

main().catch((err: unknown) => {
  console.error("EVAL-RUN ERROR:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
