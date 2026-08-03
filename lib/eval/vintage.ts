/**
 * lib/eval/vintage.ts — is this run row old enough that EV-01/EV-03 cannot
 * meaningfully audit it? (closes 03-VERIFICATION.md Process Finding #2)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZERO IMPORTS — LOAD-BEARING, NOT A STYLE CHOICE.
 *
 * `scripts/eval-run.ts` runs under node type-stripping
 * (`node --env-file-if-exists=.env.local scripts/eval-run.ts`), which cannot
 * resolve the `@/…` tsconfig path alias. This module therefore imports nothing
 * and uses erasable TypeScript syntax only (no enums, no namespaces, no
 * parameter properties), so the SAME file loads from the script by relative
 * `.ts` path AND from vitest via the `@/lib/eval/vintage` alias. That is what
 * lets the predicate be tested rather than duplicated the way the
 * `costUsd`/`savingsUsd` arithmetic had to be (`scripts/eval-run.ts:131-169`).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY A VINTAGE PREDICATE AT ALL
 *
 * The only run row that existed when Phase 3 closed was written on 2026-07-27
 * by `ling-3.0-flash:free`. Its answer carries 10 inline `[n]` markers against
 * a source registry of 0, so EV-01 reports `FAIL(critical)` — correctly, given
 * the rows. But the cause is not a regression: server-side citation numbering
 * (03-04) and page-extract persistence (03-07) did not exist yet. A reader who
 * runs the gate before a fresh eval sweep sees red and misreads it as a break,
 * which erodes trust in the one artifact whose entire job is trustworthiness.
 *
 * THE TWO 03-04 MARKERS (both landed together; both appear on every later run)
 *
 *   1. The meter carrier row — `lib/agent/loop.ts:418-427` emits
 *      `{ id: 'meter-{runId}', kind: 'meter', state: 'running', startedAt }`
 *      as the FIRST DB write inside the loop's try block, before the iteration
 *      loop begins. `scripts/eval-run.ts` already parses it and already flags
 *      its absence in EV-16 ("no meter carrier row persisted for this run").
 *   2. Server-minted `n` on `fetch_page` done rows — the source registry that
 *      `scripts/eval-run.ts` builds as `registryByN`. A pre-03-04 run has
 *      `fetch_page` rows with no `n` at all, hence `registrySize === 0`.
 *
 * MARKER 3 (added by 03-16, closing GW-05) — A POST-03-04 PAYLOAD KEY
 *
 *   3. Any `role='tool'` row carrying one of the four keys that only a
 *      post-03-04 deploy writes: `kind` (the plan card and the meter carrier),
 *      `n` and `extract` (a resolved `fetch_page` done row, 03-04 + 03-07), or
 *      `label` (both `create_pdf_report` rows). See `POST_NUMBERING_KEYS` in
 *      `scripts/eval-run.ts`, which computes this from the raw parsed payloads.
 *
 * WHY THE CONJUNCTION, NOT ANY MARKER ALONE
 *
 * Each marker alone has a legitimate current-run counterexample: a post-03-07
 * run whose meter-carrier insert happened to fail would lack marker 1, and a
 * post-03-07 run that fetched nothing would lack marker 2. Skipping either of
 * those would disarm a Critical gate on a live run. So the predicate requires
 * the JOINT absence of all markers, further gated on the run having actually
 * dispatched tool work (>= 1 `role='tool'` row) — which is what distinguishes
 * "old vintage" from "a run that simply answered without tools", where a
 * numbering break would be a real finding.
 *
 * WHY MARKER 3 (`hasPostNumberingPayload`) IS THE ONE THAT CLOSES THE HOLE (GW-05)
 *
 * Markers 1 and 2 are both suppressible by ordinary tool OUTCOMES on a CURRENT
 * deploy: `emitToolStatus` logs and SWALLOWS a failed meter-carrier insert
 * (`lib/agent/loop.ts`), and every `fetch_page` throwing (SSRF reject, timeout,
 * 404) leaves `registrySize === 0` because `[n]` is only minted after a fetch
 * RESOLVES. So the pre-03-16 three-conjunct predicate was satisfiable by a live
 * run and printed `SKIP` on an answer that may cite `[1]…[10]` against nothing —
 * the self-disarming gate the invariant below forbids. Marker 3 is structural
 * rather than outcome-dependent: it asks whether the WRITER of these rows knew
 * about the post-03-04 payload shape at all, which no tool result can change.
 *
 * Residual, stated honestly: one narrow live shape can still lack all three —
 * a run with no plan fence, a swallowed meter insert, only `web_search` rows
 * plus failed `fetch_page` rows, and no report. That shape is why
 * `vintageVerdict` exists: whenever such an answer actually carries citations
 * the verdict is FLAG, not SKIP, so the Critical check is still printed with
 * its numbers. Marker 3 narrows the hole; the FLAG path removes the silence.
 *
 * Consequence, and it is the half that matters: a run carrying a meter carrier
 * is NOT skippable no matter its registry size, and a run with a non-empty
 * registry is NOT skippable no matter its meter carrier. The 2026-07-30
 * capture that cited a phantom `[7]` against a 6-source registry (EC-04) still
 * FAILs EV-01 as a real Critical — exactly as it should.
 *
 * THE INVARIANT THAT MUST NEVER BE BROKEN
 *
 * The vintage signal must NEVER be derived from the condition EV-01 audits
 * (max cited `[n]` vs registry size), or the check would skip itself precisely
 * whenever it would have failed — a gate that disarms on the failing input is
 * worse than no gate. It must also never be derived from a timestamp, a
 * hardcoded date, or a run id: those rot, and they cannot be reasoned about
 * from the row itself. The signal is structural, drawn from rows the run wrote.
 *
 * Every comparison below is strict, so a malformed or partially-populated
 * input falls to `false` — the SAFE direction, which is "audit this run".
 */

/** The run's own structural markers, computed from rows it persisted. */
export interface RunVintageInput {
  /** A `kind: 'meter'` tool row was found for this run (03-04 marker 1). */
  hasMeterCarrier: boolean;
  /** Size of the server-minted `[n]` source registry (03-04 marker 2). */
  registrySize: number;
  /** How many `role='tool'` rows this run persisted (did it do tool work?). */
  toolRowCount: number;
  /**
   * True when ANY `role='tool'` row this run persisted carries a
   * post-03-04-only payload key — `kind`, `n`, `extract`, or `label`
   * (03-04 marker 3; the key list lives in `scripts/eval-run.ts` as
   * `POST_NUMBERING_KEYS`).
   *
   * This is the conjunct that closes GW-05, because unlike the other two it
   * cannot be suppressed by tool OUTCOMES. The meter carrier's insert is
   * guarded and swallowed on failure, and the registry is empty whenever every
   * fetch threw — both are reachable on a current run. But a post-03-04 deploy
   * writes these keys from the payload shape itself: the plan card carries
   * `kind`, the meter carrier carries `kind`, a resolved `fetch_page` row
   * carries `n` and `extract`, and both `create_pdf_report` rows carry `label`.
   */
  hasPostNumberingPayload: boolean;
}

/**
 * Printed verbatim on the skipped verdict line. Self-explanatory by contract:
 * a reader must understand why a Critical check was skipped without consulting
 * a plan.
 */
export const PRE_NUMBERING_VINTAGE_SKIP_REASON: string =
  "SKIPPED — pre-03-04 vintage run: no meter-carrier row and no server-minted [n] " +
  "on any fetch_page row, so neither citation numbering (03-04) nor page-extract " +
  "persistence (03-07) existed when this run was written. There is nothing " +
  "resolvable to audit here — this is stale data, not a regression. Capture a " +
  "fresh eval sweep against a current deploy for a real verdict.";

/**
 * Printed alongside a FLAGged verdict: the check ran, its numbers are real
 * output, but they came off a pre-03-04 row rather than a current deploy.
 */
export const PRE_NUMBERING_VINTAGE_FLAG_REASON: string =
  "FLAGGED (pre-03-04 vintage) — this run persisted none of the structural " +
  "markers a post-03-04 deploy writes (no meter-carrier row, no server-minted " +
  "[n] on any fetch_page row, no post-numbering payload key), so the numbers " +
  "printed below are a real reading of a STALE row, not evidence of a current " +
  "regression. They are shown rather than skipped because the answer does cite " +
  "sources and a Critical check must never vanish silently. Capture a fresh " +
  "eval sweep against a current deploy for a verdict that binds.";

/**
 * True only for the one shape that cannot be audited: ALL THREE 03-04 markers
 * absent AND the run actually dispatched tool work.
 *
 * Deliberately NOT a function of anything EV-01 or EV-03 asserts — see the
 * header's invariant.
 */
export function isPreNumberingVintage(input: RunVintageInput): boolean {
  // Marker 3 present (or not a clean boolean) → audit it. FIRST because it is
  // the strongest marker: no tool outcome can suppress it (see the header).
  if (input.hasPostNumberingPayload !== false) return false;
  // Marker 1 present (or not a clean boolean) → audit it.
  if (input.hasMeterCarrier !== false) return false;
  // Marker 2 present (or not a clean count of zero) → audit it.
  if (input.registrySize !== 0) return false;
  // No tool work at all → a plain answer, not an old vintage → audit it.
  if (!(input.toolRowCount >= 1)) return false;
  return true;
}

/** What a Critical vintage-gated check should do with this run. */
export type VintageVerdict = "AUDIT" | "FLAG" | "SKIP";

/**
 * Three-way refinement of `isPreNumberingVintage`, so a Critical check is never
 * simply ABSENT from the eval output:
 *
 *   AUDIT — not a vintage run; evaluate and record normally.
 *   FLAG  — a vintage run whose answer DOES cite sources; evaluate anyway and
 *           record a would-be FAIL as FLAG with
 *           `PRE_NUMBERING_VINTAGE_FLAG_REASON` appended, so a human still
 *           sees the numbers.
 *   SKIP  — a vintage run whose answer cites nothing; there is genuinely
 *           nothing resolvable to print.
 *
 * WHY THIS DOES NOT BREAK THE MODULE'S INVARIANT
 *
 * The invariant forbids deriving the vintage signal from the condition EV-01
 * audits — whether the maximum cited `[n]` RESOLVES against the registry size.
 * `answerHasCitations` is strictly weaker: it asks only whether any `[n]` is
 * PRESENT. Presence never determines the skip decision (`isPreNumberingVintage`
 * is computed without it) and it can only move a verdict in the SAFER
 * direction, SKIP → FLAG. There is no input on which a citation makes the gate
 * quieter, which is the failure mode the invariant exists to prevent.
 */
export function vintageVerdict(
  input: RunVintageInput,
  opts: { answerHasCitations: boolean },
): VintageVerdict {
  if (!isPreNumberingVintage(input)) return "AUDIT";
  return opts.answerHasCitations ? "FLAG" : "SKIP";
}
