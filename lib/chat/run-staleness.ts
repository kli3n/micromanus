/**
 * lib/chat/run-staleness.ts — the age bound on the reload-surviving in-flight
 * signal (review GW-02).
 *
 * ZERO IMPORTS by design, following the `lib/chat/run-guard.ts` precedent: a
 * node-env Vitest run pins this without pulling in React, Next, or the
 * `"use client"` ChatThread component. It is also imported by an RSC
 * (`app/app/c/[chatId]/page.tsx`), and a leaf with no imports cannot drag
 * anything into either graph.
 *
 * WHY THIS EXISTS. WR-01 made `pendingAssistantId` one of the three
 * `isRunInFlight` signals, and it is the ONLY one that survives a reload — the
 * server re-seeds it on every load while the chat's latest run reads
 * `'running'`. That is correct for money (it is what stops a reopened tab
 * asking for a second debit on one question), but it has no upper bound: a run
 * that never reaches a terminal status — a Vercel hard kill at the 300s
 * ceiling, an evicted `waitUntil` task, or a Postgres refusal that survives
 * both terminal-write attempts (GW-01) — leaves that chat permanently
 * unsendable, spinner forever, with no reason shown and no escape. The signal
 * needs a bound AT THE POINT IT IS MINTED, which is the server component.
 *
 * WHY 330_000. It is a PLATFORM FACT, not a tuning knob. The agent route runs
 * under Vercel Fluid Compute with `maxDuration = 300` (and a 240s self-budget
 * inside that), so no live run can ever be older than 300s; 330s clears it with
 * a 30s margin for the terminal write. It is deliberately the SAME number the
 * DB-side in-flight window in migration `0007` uses (planned in 03-18), so the
 * client-side release and the server-side reaper cannot drift into a state
 * where one considers a run live and the other does not.
 *
 * FAIL-SAFE DIRECTION. A `running` row whose start cannot be established —
 * null, empty, or unparseable `started_at` — returns `true` (wedged, release
 * the guard). The alternative is an immortal in-flight signal minted from a
 * malformed row, which is precisely the defect this module closes. Releasing is
 * safe here because this predicate carries NO money invariant: the server's
 * `start_run` RPC and the append-only ledger remain the authority on debits
 * (and 03-18 moves the one-question-one-debit check into Postgres itself).
 */

/**
 * The age past which a `running` run is treated as wedged. 330s > the 300s
 * Fluid Compute `maxDuration` the agent route runs under, so no LIVE run can
 * reach it. Kept in lockstep with the DB-side in-flight window (03-18).
 */
export const RUN_WEDGE_CEILING_MS = 330_000;

export interface RunStalenessArgs {
  /** `runs.status` as read from Postgres. Only the literal `running` can wedge. */
  status: string | null | undefined;
  /** `runs.started_at` (ISO). Untrusted: any deploy vintage may have written it. */
  startedAt: string | null | undefined;
  /** `Date.now()` at the render that mints the signal. */
  now: number;
}

/**
 * TRUE when the chat's latest run claims to be `running` but cannot still be
 * executing — so the composer must NOT be held for it.
 *
 * A terminal (or absent) status is never "wedged": that run is settled and the
 * in-flight signal is not minted for it in the first place.
 */
export function isRunWedged(args: RunStalenessArgs): boolean {
  if (args.status !== "running") return false;

  if (typeof args.startedAt !== "string" || args.startedAt.trim().length === 0) {
    return true;
  }
  const started = Date.parse(args.startedAt);
  // Guarded explicitly: every comparison against NaN is false, so relying on
  // comparison semantics would silently return the WRONG answer (not wedged)
  // for exactly the malformed rows this bound exists to release.
  if (Number.isNaN(started)) return true;

  const age = args.now - started;
  if (age >= RUN_WEDGE_CEILING_MS) return true;
  // Clock skew: a start stamped further into the future than the whole ceiling
  // could otherwise never age out. Modest skew is tolerated so a real run
  // survives a few seconds of drift between Postgres and the render.
  if (-age > RUN_WEDGE_CEILING_MS) return true;

  return false;
}
