/**
 * lib/chat/done-frame.ts — the pure classifier for an SSE `done` frame
 * (review RC-01).
 *
 * ZERO IMPORTS by design, following the `lib/chat/run-guard.ts` /
 * `lib/chat/run-staleness.ts` precedent: a node-env Vitest run pins this
 * without pulling in the `"use client"` ChatThread component or any React/Next
 * module. It is a decision, not markup.
 *
 * WHY THIS EXISTS. `/api/agent/run` emits `done` from TWO places with opposite
 * meanings, and the client used to treat them identically:
 *
 *   1. The loop's own terminal frame — `lib/agent/loop.ts` sends
 *      `{ runId, status }` with a REAL run id on all three terminal paths
 *      (succeeded / budget_exhausted / failed). A run row exists, the user
 *      message and the assistant answer are persisted, and the client SHOULD
 *      reconcile the thread from the DB.
 *
 *   2. A start-time REFUSAL — `sseErrorResponse` sends `error` and then
 *      `done { runId: null, status: "failed" }`. Nothing ran: no `runs` row,
 *      and (except on the post-debit setup path) no `messages` rows either. The
 *      client must NOT reconcile, because `reconcileFromDb` is a whole-list
 *      REPLACE: it would discard the optimistic local question AND the refusal
 *      copy the preceding `error` frame just painted, one round-trip after they
 *      appeared. On a chat with any prior history that made every refusal —
 *      `run_in_flight`, `insufficient_credits`, `no_key`, `bad_model`,
 *      `not_found`, `db_error`, `key_error`, `setup_error` — silently invisible:
 *      the question vanished, no error was shown, and the composer was already
 *      empty. That is RC-01.
 *
 * `runId` is the discriminator that was already on the wire; this module names
 * it so both halves of the contract are pinned by a test rather than by a
 * comment.
 *
 * THE BIAS IS DELIBERATE. Anything that is not a non-empty string id counts as
 * a refusal, because the two errors are not symmetric:
 *   - False "refusal" on a real terminal frame costs nothing durable — the
 *     Realtime `runs` terminal UPDATE and the 4s status poll in
 *     `components/ChatThread.tsx` are both standing backstops that call
 *     `settleFromDb` anyway.
 *   - False "terminal" on a refusal is the RC-01 data loss itself.
 * So the ambiguous shapes (absent, null, "", a number) resolve to the harmless
 * side.
 */

/** The fields of a parsed `done` frame payload this rule reads. */
export interface DoneFramePayload {
  /** A run id string on the loop's terminal frame; `null` on a refusal. */
  runId?: unknown;
  /** Present on both shapes and deliberately NOT consulted: `sseErrorResponse`
   *  and the loop's failure path both send `"failed"`, so status cannot
   *  discriminate them. */
  status?: unknown;
}

/**
 * TRUE when this `done` frame closes a run that never started, so the thread
 * must NOT be reconciled from the DB.
 */
export function isStartRefusalDone(data: DoneFramePayload): boolean {
  return typeof data.runId !== "string" || data.runId.length === 0;
}

/**
 * TRUE when this `done` frame closes a REAL run, so `settleFromDb` may replace
 * the local thread with the persisted rows. The exact complement of
 * `isStartRefusalDone` — expressed once, so the wired call site and the test
 * cannot encode two different rules.
 */
export function doneFrameSettles(data: DoneFramePayload): boolean {
  return !isStartRefusalDone(data);
}
