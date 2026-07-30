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
 * WHY THE CONJUNCTION, NOT EITHER MARKER ALONE
 *
 * Each marker alone has a legitimate current-run counterexample: a post-03-07
 * run whose meter-carrier insert happened to fail would lack marker 1, and a
 * post-03-07 run that fetched nothing would lack marker 2. Skipping either of
 * those would disarm a Critical gate on a live run. So the predicate requires
 * the JOINT absence of both markers, further gated on the run having actually
 * dispatched tool work (>= 1 `role='tool'` row) — which is what distinguishes
 * "old vintage" from "a run that simply answered without tools", where a
 * numbering break would be a real finding.
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
 * True only for the one shape that cannot be audited: BOTH 03-04 markers
 * absent AND the run actually dispatched tool work.
 *
 * Deliberately NOT a function of anything EV-01 or EV-03 asserts — see the
 * header's invariant.
 */
export function isPreNumberingVintage(input: RunVintageInput): boolean {
  // Marker 1 present (or not a clean boolean) → audit it.
  if (input.hasMeterCarrier !== false) return false;
  // Marker 2 present (or not a clean count of zero) → audit it.
  if (input.registrySize !== 0) return false;
  // No tool work at all → a plain answer, not an old vintage → audit it.
  if (!(input.toolRowCount >= 1)) return false;
  return true;
}
