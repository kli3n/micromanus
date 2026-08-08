/**
 * scripts/eval-judge.ts — the phase's ONLY LLM-judge spend, deliberately
 * bounded (AI-SPEC § 5.2). Closed-book entailment: for each mechanically
 * sampled cited sentence it sends ONLY the sentence plus the STORED extraction
 * window of the source it cites (persisted in the fetch_page done tool row —
 * no live web, no re-fetch) and asks supported / unsupported / unclear with a
 * one-line reason.
 *
 * Run: `npm run eval:judge -- --last N --sample 10` (or `--run <uuid>`)
 * Env:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  — read-only row access (rls-probe convention)
 *   EVAL_JUDGE_MODEL     — judge model id; DEFAULT is the free OpenRouter model
 *                          already wired as OPENROUTER_FREE_FALLBACK[0] in
 *                          lib/registry.ts (keep the literal in sync)
 *   EVAL_JUDGE_API_KEY   — key for the judge endpoint (falls back to OPENROUTER_API_KEY)
 *   EVAL_JUDGE_BASE_URL  — default https://openrouter.ai/api/v1
 *
 * Cost discipline (AI-SPEC § 5.2):
 *   - batched 10 sentences per call => ~1-2 calls per run, <=20 for the eval set
 *   - a free judge is weak, so its DEFAULT status is TRIAGE ONLY — it orders
 *     sentences for manual review; it never overrides a human label
 *   - calibration gate: when a filled scoresheet exists at
 *     .planning/phases/03-deep-research/eval/runs/<run_id>.md this script
 *     prints raw judge-vs-human agreement; only at >=16/20 agreement across
 *     >=20 labeled sentences may a judge score be quoted anywhere (EV-02)
 *   - EV-03 quotes and EV-04 domains are CODE checks in eval-run.ts — never judged
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
function optionalEnv(...names: string[]): string | undefined {
  try {
    return requireEnv(...names);
  } catch {
    return undefined;
  }
}

const SUPABASE_URL = requireEnv("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL");
const SERVICE_ROLE_KEY = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
/** Default = OPENROUTER_FREE_FALLBACK[0] in lib/registry.ts — keep in sync. */
const JUDGE_MODEL = optionalEnv("EVAL_JUDGE_MODEL") ?? "inclusionai/ling-3.0-tiny:free";
const JUDGE_KEY = optionalEnv("EVAL_JUDGE_API_KEY", "OPENROUTER_API_KEY");
const JUDGE_BASE_URL = optionalEnv("EVAL_JUDGE_BASE_URL") ?? "https://openrouter.ai/api/v1";

const SCORESHEET_DIR = join(".planning", "phases", "03-deep-research", "eval", "runs");

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noPersist);
}

// ============================ CLI ============================
interface CliArgs {
  runId?: string;
  last: number;
  sample: number;
}
function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { last: 2, sample: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--run" && argv[i + 1]) out.runId = argv[++i];
    else if (argv[i] === "--last" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.last = Math.floor(n);
    } else if (argv[i] === "--sample" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.sample = Math.floor(n);
    }
  }
  return out;
}

// ============================ row shapes ============================
interface RunRow {
  id: string;
  chat_id: string;
  model_id: string;
  status: string;
  started_at: string;
}
interface MessageRow {
  role: string;
  content: string | null;
  created_at: string;
}
interface ToolPayload {
  tool?: string;
  state?: string;
  url?: string;
  domain?: string;
  n?: number;
  title?: string;
  extract?: string;
}
interface RegistryEntry {
  n: number;
  domain: string;
  title: string;
  extract: string | null;
}

// ============================ sampling (rubric.md mechanical rule) ============================
function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
function citationNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\[(\d{1,3})\]/g)) out.push(Number(m[1]));
  return out;
}
/**
 * Every k-th cited sentence in document order, k chosen so the sample is
 * `size` (<= size cited sentences => all of them). NEVER eye-picked — this is
 * the rubric.md bias control, and the human scoresheet uses the SAME sample.
 */
function mechanicalSample(citedSentences: string[], size: number): string[] {
  if (citedSentences.length <= size) return citedSentences;
  const k = Math.floor(citedSentences.length / size);
  const out: string[] = [];
  for (let i = k - 1; i < citedSentences.length && out.length < size; i += k) {
    out.push(citedSentences[i]);
  }
  return out;
}

/**
 * The "relevant window" of a stored extraction (AI-SPEC § 5.2): the 2000-char
 * window (step 1000) sharing the most content words with the sentence, so the
 * judge call stays ~2k tokens instead of shipping the whole 20k extraction.
 */
function bestWindow(extract: string, sentence: string): string {
  if (extract.length <= 2400) return extract;
  const words = new Set(
    sentence
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  let best = extract.slice(0, 2000);
  let bestScore = -1;
  for (let off = 0; off < extract.length; off += 1000) {
    const win = extract.slice(off, off + 2000);
    const lower = win.toLowerCase();
    let score = 0;
    for (const w of words) if (lower.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = win;
    }
    if (off + 2000 >= extract.length) break;
  }
  return best;
}

// ============================ judge call ============================
type JudgeVerdict = "supported" | "unsupported" | "unclear";
interface SampleItem {
  index: number; // 1-based position in the mechanical sample
  sentence: string;
  citedNs: number[];
  evidence: string | null; // null => no stored extraction (pre-03-07 run)
}
interface JudgedItem extends SampleItem {
  verdict: JudgeVerdict;
  reason: string;
}

const JUDGE_SYSTEM = [
  "You are a strict closed-book fact-checking judge.",
  "For each numbered item you get a SENTENCE from a research answer and EVIDENCE",
  "(text extracted from the exact web page the sentence cites). Decide, using ONLY",
  "the evidence — no outside knowledge:",
  '- "supported": the sentence\'s numbers, dates, and causal attributions are backed by the evidence',
  '- "unsupported": the evidence is silent on, or contradicts, a load-bearing part of the sentence',
  '- "unclear": the evidence is related but you cannot decide either way',
  "Respond with ONLY a JSON array, one object per item:",
  '[{"i": <item number>, "verdict": "supported"|"unsupported"|"unclear", "reason": "<one line>"}]',
].join("\n");

async function judgeBatch(items: SampleItem[]): Promise<Map<number, { verdict: JudgeVerdict; reason: string }>> {
  const user = items
    .map(
      (it) =>
        `ITEM ${it.index}\nSENTENCE: ${it.sentence}\nEVIDENCE (from cited source${it.citedNs.length > 1 ? "s" : ""} [${it.citedNs.join(",")}]):\n${it.evidence}`,
    )
    .join("\n\n---\n\n");

  const res = await fetch(`${JUDGE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${JUDGE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`judge call failed: HTTP ${res.status} (model=${JUDGE_MODEL})`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = body.choices?.[0]?.message?.content ?? "";

  const out = new Map<number, { verdict: JudgeVerdict; reason: string }>();
  // Primary parse: first JSON array in the response.
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]) as { i?: number; verdict?: string; reason?: string }[];
      for (const row of arr) {
        const v = (row.verdict ?? "").toLowerCase();
        if (
          typeof row.i === "number" &&
          (v === "supported" || v === "unsupported" || v === "unclear")
        ) {
          out.set(row.i, { verdict: v, reason: row.reason ?? "" });
        }
      }
    } catch {
      /* fall through to lenient parse */
    }
  }
  // Lenient fallback: "ITEM 3 ... supported" style lines.
  if (out.size === 0) {
    for (const m of text.matchAll(/\b(?:item\s*)?(\d+)\b[^\n]*?\b(supported|unsupported|unclear)\b/gi)) {
      out.set(Number(m[1]), { verdict: m[2].toLowerCase() as JudgeVerdict, reason: "(lenient parse)" });
    }
  }
  return out;
}

// ============================ human labels (filled scoresheet) ============================
/**
 * Parse eval/runs/<run_id>.md — the EV-02 table's Label column (4th cell):
 * | # | Cited sentence (verbatim) | Cites [n] | Label | Note |
 */
function humanLabels(runId: string): Map<number, JudgeVerdict> {
  const out = new Map<number, JudgeVerdict>();
  const file = join(SCORESHEET_DIR, `${runId}.md`);
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    // ['', '#', 'sentence', 'cites', 'label', 'note', ''] for a filled row
    if (cells.length < 6) continue;
    const idx = Number(cells[1]);
    const label = cells[4].toLowerCase();
    if (
      Number.isInteger(idx) &&
      (label === "supported" || label === "unsupported" || label === "unclear")
    ) {
      out.set(idx, label);
    }
  }
  return out;
}

// ============================ main ============================
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const admin = adminClient();

  let runs: RunRow[] = [];
  if (args.runId) {
    const { data, error } = await admin
      .from("runs")
      .select("id, chat_id, model_id, status, started_at")
      .eq("id", args.runId);
    if (error) throw new Error(`runs read failed: ${error.message}`);
    runs = (data ?? []) as RunRow[];
    if (runs.length === 0) throw new Error(`no run found with id ${args.runId}`);
  } else {
    const { data, error } = await admin
      .from("runs")
      .select("id, chat_id, model_id, status, started_at")
      .order("started_at", { ascending: false })
      .limit(args.last);
    if (error) throw new Error(`runs read failed: ${error.message}`);
    runs = (data ?? []) as RunRow[];
  }
  if (runs.length === 0) {
    console.log("eval-judge: no runs found — run an eval question first (see eval/questions.md).");
    return;
  }

  let calls = 0;
  let totalLabeled = 0;
  let totalAgree = 0;

  for (const run of runs) {
    console.log(`\n=== JUDGE · RUN ${run.id} · ${run.model_id} · ${run.status} ===`);

    const { data, error } = await admin
      .from("messages")
      .select("role, content, created_at")
      .eq("run_id", run.id)
      .order("created_at", { ascending: true });
    if (error) throw new Error(`messages read failed: ${error.message}`);
    const messages = (data ?? []) as MessageRow[];

    // Registry (with stored extractions) from the persisted fetch_page done rows.
    const registryByN = new Map<number, RegistryEntry>();
    for (const m of messages) {
      if (m.role !== "tool" || !m.content) continue;
      let p: ToolPayload;
      try {
        p = JSON.parse(m.content) as ToolPayload;
      } catch {
        continue;
      }
      if (p.tool === "fetch_page" && p.state === "done" && typeof p.n === "number") {
        registryByN.set(p.n, {
          n: p.n,
          domain: p.domain ?? "",
          title: p.title ?? "",
          extract: typeof p.extract === "string" ? p.extract : null,
        });
      }
    }

    const assistantRows = messages.filter((m) => m.role === "assistant");
    const answer = (assistantRows[assistantRows.length - 1]?.content ?? "").trim();
    if (answer.length === 0) {
      console.log("  no terminal answer persisted for this run — skipped.");
      continue;
    }

    const cited = splitSentences(answer).filter((s) => citationNumbers(s).length > 0);
    const sample = mechanicalSample(cited, args.sample);
    if (sample.length === 0) {
      console.log("  no cited sentences in the terminal answer — nothing to judge.");
      continue;
    }
    console.log(
      `  mechanical sample: ${sample.length} of ${cited.length} cited sentence(s) (every k-th, document order — copy THESE into the scoresheet):`,
    );

    const items: SampleItem[] = sample.map((sentence, i) => {
      const ns = [...new Set(citationNumbers(sentence))];
      const withExtract = ns
        .map((n) => registryByN.get(n))
        .filter((e): e is RegistryEntry => Boolean(e && e.extract));
      const evidence =
        withExtract.length > 0
          ? withExtract
              .map((e) => `[${e.n}] ${e.domain} — "${e.title}":\n${bestWindow(e.extract as string, sentence)}`)
              .join("\n\n")
          : null;
      return { index: i + 1, sentence, citedNs: ns, evidence };
    });

    for (const it of items) {
      console.log(`    ${it.index}. [cites ${it.citedNs.map((n) => `[${n}]`).join("")}] ${it.sentence.slice(0, 140)}`);
    }

    const judgeable = items.filter((it) => it.evidence !== null);
    const results: JudgedItem[] = [];

    // Locally settled: no stored extraction => unclear, no spend.
    for (const it of items) {
      if (it.evidence === null) {
        results.push({
          ...it,
          verdict: "unclear",
          reason: "no stored extraction for the cited source (pre-03-07 run) — human must open the URL",
        });
      }
    }

    if (judgeable.length > 0) {
      if (!JUDGE_KEY) {
        console.log(
          "  NO JUDGE KEY (set EVAL_JUDGE_API_KEY or OPENROUTER_API_KEY) — sample printed above for manual labeling; judge verdicts skipped.",
        );
      } else {
        // Batched: 10 sentences per call (cost discipline — ~1-2 calls per run).
        for (let off = 0; off < judgeable.length; off += 10) {
          const batch = judgeable.slice(off, off + 10);
          calls++;
          const verdicts = await judgeBatch(batch);
          for (const it of batch) {
            const v = verdicts.get(it.index);
            results.push({
              ...it,
              verdict: v?.verdict ?? "unclear",
              reason: v?.reason ?? "judge returned no verdict for this item",
            });
          }
        }
      }
    }

    results.sort((a, b) => a.index - b.index);
    if (results.some((r) => r.evidence !== null && JUDGE_KEY)) {
      console.log("  judge verdicts (TRIAGE ORDER — review unsupported/unclear first):");
      for (const r of results) {
        console.log(`    ${r.index}. ${r.verdict.toUpperCase().padEnd(11)} — ${r.reason}`);
      }
    }

    // Calibration: raw agreement vs the filled scoresheet, aligned by sample index.
    const labels = humanLabels(run.id);
    if (labels.size > 0) {
      let agree = 0;
      let compared = 0;
      for (const r of results) {
        const human = labels.get(r.index);
        if (!human) continue;
        compared++;
        if (human === r.verdict) agree++;
      }
      totalLabeled += compared;
      totalAgree += agree;
      console.log(`  human labels found (eval/runs/${run.id}.md): agreement ${agree}/${compared}`);
    } else {
      console.log(`  no filled scoresheet at eval/runs/${run.id}.md — label it to calibrate the judge.`);
    }
  }

  console.log(`\neval-judge: ${calls} model call(s) made (judge=${JUDGE_MODEL}).`);
  const calibrated = totalLabeled >= 20 && totalAgree / totalLabeled >= 16 / 20;
  if (calibrated) {
    console.log(
      `CALIBRATION GATE PASSED: agreement ${totalAgree}/${totalLabeled} (>=16/20 across >=20 labels) — judge scores may be quoted in scoresheets/UAT.`,
    );
  } else {
    console.log(
      `TRIAGE-ONLY: ${
        totalLabeled > 0
          ? `agreement ${totalAgree}/${totalLabeled} — below the >=16/20-over->=20-labels gate.`
          : "no human labels yet."
      } Judge output ORDERS sentences for manual review; scoresheets record HUMAN labels only (EV-02). The judge never overrides a human label.`,
    );
  }
}

main().catch((err: unknown) => {
  console.error("EVAL-JUDGE ERROR:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
