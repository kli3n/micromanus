/**
 * components/chat/stream-replay.ts — the DEV-ONLY deterministic replay harness
 * behind the D-61 before/after measurement (04-03 Task 3, RESEARCH Pattern 1b).
 *
 * NO React import and NO client directive: this is a text fixture plus a timer
 * loop, following the `components/chat/render-rules.ts` leaf convention.
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────────
 * A before/after comparison over two different research answers is not a
 * measurement. Two questions produce different token counts, different markdown
 * complexity and different tool-row counts, so the delta between two live runs
 * is noise wearing a number's clothing. This module replaces the variable with a
 * constant: ONE fixed fixture, ONE fixed cadence. That is what turns the
 * rung-2-vs-rung-3 escalation (plan 04-07) into a decision rather than a guess,
 * and it is why T-04-14 rates an unrecorded or non-deterministic baseline as a
 * repudiation threat rather than a missing nicety.
 *
 * ── THE TWO GATES (both required, stated here because the header IS the
 *    contract a reviewer checks first) ──────────────────────────────────────────
 *   GATE 1: `process.env.NODE_ENV !== "production"`. Next inlines NODE_ENV at
 *           build time, so in a production bundle `isReplayEnabled` collapses to
 *           `return false` and everything downstream of it is unreachable.
 *   GATE 2: an explicit query flag on the URL (`?mmReplay=1`). A dev server
 *           alone does not arm it; someone has to ask.
 *
 * ── WHY THAT IS A STRUCTURAL GUARANTEE, NOT DISCIPLINE (T-04-10) ─────────────
 * A stream injector that reached production would let anyone drive the client
 * render path with attacker-chosen content, and one that could call the run
 * route would touch a metered money path. So the driver below takes a CALLBACK
 * and imports nothing: no fetch, no SSE parser, no route path, no Supabase
 * client, no money symbol. It structurally cannot reach the agent run route, the
 * start-run RPC or the debit RPC — there is no name in scope through which it
 * could. An asserting grep over the non-comment lines of this file is an
 * acceptance criterion of the plan that created it, precisely so this paragraph
 * is not the only thing holding the property up.
 *
 * ── WHAT IT MEASURES AGAINST ─────────────────────────────────────────────────
 * `ChatThread` feeds `onDelta` into the SAME `token`-case code path a real SSE
 * frame takes, so what gets measured is the real render pipeline rather than a
 * parallel one built for the occasion.
 */

/** Names the fixture in every recorded number. Bump on any fixture edit — an
 *  after-number compared against a differently-named fixture is meaningless. */
export const REPLAY_FIXTURE_NAME = "d61-mixed-8k-v1";

/**
 * Deltas per second. Declared, fixed, and deliberately ABOVE 60.
 *
 * The choice is load-bearing rather than arbitrary. RESEARCH Pattern 1c notes
 * that rung 2's frame coalescing can only collapse what arrives faster than the
 * frame rate: at 60 deltas/second or below, `deltas / 60 ≈ 1` and rAF batching
 * has essentially nothing to collapse. A fixture pinned at, say, 30/second would
 * therefore make rung 2 look useless for a reason that is an artifact of the
 * fixture, not a property of the code. 120/second sits inside the realistic band
 * (a fast provider streams 180-260 tokens/second; a slow one 20-40) and leaves
 * rung 2 real headroom, so the measurement can distinguish "batching did not
 * help" from "batching had nothing to batch".
 */
export const REPLAY_DELTAS_PER_SECOND = 120;

/** Characters per delta, ~1 token. Real providers emit roughly one token per
 *  SSE frame; anything chunkier would understate the per-delta cost. */
export const REPLAY_CHUNK_CHARS = 4;

/** The query flag of GATE 2. */
export const REPLAY_QUERY_FLAG = "mmReplay";

/**
 * At most this many due deltas are flushed per timer tick.
 *
 * Catch-up is deliberate, not sloppy: a real reader loop resumes from
 * `reader.read()` and dispatches every buffered frame inside ONE task, which is
 * exactly why React 19 already batches the state updates from a burst (RESEARCH
 * Pattern 1c). Modelling that faithfully is what makes the `deltas / commits`
 * ratio mean something. The cap keeps a long stall from collapsing the whole
 * remaining fixture into a single unrealistic flush.
 */
const MAX_FLUSH_PER_TICK = 16;

// ── Fixture ──────────────────────────────────────────────────────────────────
// Built by a deterministic, input-free function: same string on every call, in
// every environment, forever. That is what "fixed fixture" means here — a
// literal 32 000-character blob would be no more deterministic and far less
// reviewable. Content shape matters: GFM tables, fenced code blocks and [n]
// citation markers are all real shapes in this app's answers, and each stresses
// a different part of the render path (`.md-tablewrap`, the fence renderer, and
// the remark citation transformer respectively).

const TOPICS = [
  "sulfide electrolyte conductivity",
  "dry-electrode calendering",
  "anode-free lithium plating",
  "cell-to-pack thermal margins",
  "pilot-line yield ramps",
  "separator-free stack pressure",
  "solid-liquid hybrid interlayers",
  "recycling of sulfide cathodes",
];

const CLAIM_TEMPLATES = [
  "Reported figures for {t} cluster tightly across independent groups, which is unusual this early in a scale-up curve [{a}].",
  "The dominant failure mode in {t} is interfacial rather than bulk, so improvements in raw material purity plateau quickly [{a}].",
  "Cost models for {t} are dominated by a single process step, and every published estimate that omits it lands roughly a factor of two low [{a}].",
  "Two of the three pilot lines that published data on {t} paused mid-ramp, and neither disclosed the reason [{a}].",
  "Where {t} is measured at cell rather than coin-cell scale, the reported advantage narrows by about half [{a}].",
  "Independent replication of {t} exists, but every replication used the same supplier, so supplier variance is untested [{a}].",
];

function buildSection(i: number): string {
  const topic = TOPICS[i % TOPICS.length] as string;
  const a = (i % 9) + 1;
  const b = ((i + 3) % 9) + 1;
  const claim = (CLAIM_TEMPLATES[i % CLAIM_TEMPLATES.length] as string)
    .replace("{t}", topic)
    .replace("{a}", String(a));
  const parts: string[] = [];

  parts.push(`## ${i + 1}. ${topic[0]?.toUpperCase()}${topic.slice(1)}`);
  parts.push("");
  parts.push(claim);
  parts.push("");
  parts.push(
    `The evidence splits along a line worth naming. Sources that measured ${topic} under load report one range; sources that inferred it from a datasheet report another, and the second group is cited more often [${b}]. Treating the two as one dataset is what produces the confident-looking averages that appear in secondary coverage.`,
  );
  parts.push("");

  // A GFM table every section — wide enough to exercise `.md-tablewrap`.
  parts.push("| Source | Scale | Metric | Reported | Verified |");
  parts.push("| --- | --- | --- | --- | --- |");
  for (let r = 0; r < 5; r += 1) {
    const n = ((i + r) % 9) + 1;
    parts.push(
      `| Group ${String.fromCharCode(65 + r)} [${n}] | ${r % 2 === 0 ? "cell" : "coin-cell"} | ${topic.split(" ")[0]} | ${(1.2 + r * 0.37).toFixed(2)} mS/cm | ${r % 3 === 0 ? "yes" : "partial"} |`,
    );
  }
  parts.push("");

  // A fenced code block every other section — the splitter's real-world shape.
  if (i % 2 === 0) {
    parts.push("```python");
    parts.push(`# normalised comparison for ${topic}`);
    parts.push("def normalise(rows):");
    parts.push("    scale = {'cell': 1.0, 'coin-cell': 0.58}");
    parts.push("");
    parts.push("    return [r.value * scale[r.kind] for r in rows]");
    parts.push("```");
    parts.push("");
  }

  parts.push(`- The load-bearing caveat: ${topic} is measured at three different temperatures across the literature and only one group states theirs [${a}].`);
  parts.push(`- A second caveat, smaller but directional: the sample sizes are single digits [${b}].`);
  parts.push("");
  parts.push(
    `> Read together, the ${topic} picture supports a narrow claim (the mechanism works) and not the broad one (it works at price and at scale) [${a}][${b}].`,
  );
  parts.push("");
  return parts.join("\n");
}

function buildFixture(): string {
  const head = [
    "# Solid-state battery commercialization: what the record supports",
    "",
    "This answer separates what is measured from what is inferred, and names the seam every time it crosses it.",
    "",
  ].join("\n");
  const body: string[] = [];
  // 24 sections lands ~32 000 characters ≈ 8 000 tokens at ~4 chars/token.
  for (let i = 0; i < 24; i += 1) body.push(buildSection(i));
  const tail = [
    "## What would change the conclusion",
    "",
    "Three disclosures would move this materially: per-group temperature and pressure conditions, cell-scale rather than coin-cell data from the two paused pilot lines, and a cost model that prices the step every public estimate omits.",
    "",
  ].join("\n");
  return `${head}${body.join("\n")}${tail}`;
}

/** The fixed fixture. Same bytes on every call — determinism is the point. */
export const REPLAY_FIXTURE: string = buildFixture();

// ── Gates ────────────────────────────────────────────────────────────────────

/**
 * Both gates in one predicate, so no caller can satisfy one and forget the
 * other. `search` is passed IN rather than read from `window` here: a leaf that
 * reads the environment for itself is a leaf that cannot be unit-tested and,
 * per the WR-09 finding, a `typeof window` guard only makes an SSR mismatch
 * deterministic rather than absent. The client component reads
 * `window.location.search` in an effect (post-hydration) and hands it over.
 */
export function isReplayEnabled(search: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    return new URLSearchParams(search).get(REPLAY_QUERY_FLAG) === "1";
  } catch {
    return false;
  }
}

// ── Driver ───────────────────────────────────────────────────────────────────

export interface ReplayOptions {
  /** Override the declared cadence. Any override must be recorded alongside the
   *  numbers or they are not comparable to anything. */
  deltasPerSecond?: number;
  chunkChars?: number;
  /** Override the fixture. Same warning as the cadence. */
  fixture?: string;
}

export interface ReplayStats {
  fixtureName: string;
  fixtureChars: number;
  /** Declared cadence — what was asked for. */
  targetDeltasPerSecond: number;
  chunkChars: number;
  deltas: number;
  elapsedMs: number;
  /** ACHIEVED cadence — what the timer actually managed. Always report this
   *  next to the target: a run whose achieved rate collapsed is a run whose
   *  render path was too slow to keep up, which is itself a finding. */
  deltasPerSecond: number;
}

/**
 * Feed the fixture through `onDelta` at a fixed cadence and resolve with the
 * run's own statistics.
 *
 * The driver knows nothing about transport. It is handed a function and calls
 * it; that is the whole interface, and it is what makes the T-04-10 containment
 * structural (see the module header). Scheduling is drift-corrected against a
 * wall-clock start so a slow frame does not silently stretch the cadence and
 * quietly change the experiment.
 */
export function replayFixture(
  onDelta: (delta: string) => void,
  opts: ReplayOptions = {},
): Promise<ReplayStats> {
  const fixture = opts.fixture ?? REPLAY_FIXTURE;
  const chunkChars = Math.max(1, opts.chunkChars ?? REPLAY_CHUNK_CHARS);
  const rate = Math.max(1, opts.deltasPerSecond ?? REPLAY_DELTAS_PER_SECOND);
  const intervalMs = 1000 / rate;

  const chunks: string[] = [];
  for (let i = 0; i < fixture.length; i += chunkChars) {
    chunks.push(fixture.slice(i, i + chunkChars));
  }

  return new Promise<ReplayStats>((resolve) => {
    const startedAt = performance.now();
    let sent = 0;

    const tick = () => {
      const due = Math.min(
        chunks.length,
        Math.floor((performance.now() - startedAt) / intervalMs) + 1,
      );
      let flushed = 0;
      while (sent < due && flushed < MAX_FLUSH_PER_TICK) {
        onDelta(chunks[sent] as string);
        sent += 1;
        flushed += 1;
      }
      if (sent >= chunks.length) {
        const elapsedMs = performance.now() - startedAt;
        resolve({
          fixtureName: REPLAY_FIXTURE_NAME,
          fixtureChars: fixture.length,
          targetDeltasPerSecond: rate,
          chunkChars,
          deltas: sent,
          elapsedMs,
          deltasPerSecond: sent / (elapsedMs / 1000),
        });
        return;
      }
      const nextDueAt = startedAt + sent * intervalMs;
      setTimeout(tick, Math.max(0, nextDueAt - performance.now()));
    };

    tick();
  });
}
