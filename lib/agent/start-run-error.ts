/**
 * lib/agent/start-run-error.ts — the pure `start_run` refusal → SSE mapping
 * (review GC-01).
 *
 * ZERO IMPORTS by design, following the `lib/chat/run-guard.ts` /
 * `lib/chat/run-staleness.ts` precedent: a node-env Vitest run pins this
 * without pulling in Supabase, Next, or the agent route's module graph, and a
 * leaf with no imports cannot drag anything into the route's bundle either.
 *
 * WHY THE SIGNATURE TAKES A BARE CODE, NOT A PostgrestError. This is the
 * information-disclosure boundary for the debit path (threat T-03-18-03), and
 * it is enforced by the TYPE rather than by convention. A PostgrestError
 * carries `message`, `details`, `hint` and — for a unique violation — the
 * offending CONSTRAINT NAME, and a constraint name can echo a user-supplied
 * value. If this function accepted the error object, some future call site
 * would eventually interpolate part of it into user-facing copy or a log line,
 * and nothing in review would reliably catch it. Accepting only
 * `string | null | undefined` means the call site must write `debitErr?.code`
 * and physically cannot hand the body across. Every message returned below is
 * a fixed literal with no interpolation: no table, column, constraint, chat id
 * or run id crosses the boundary.
 *
 * WHY `P0002` IS FREE HERE even though `public.redeem_coupon` already raises
 * `P0002` for `invalid_code` (migration 0002). SQLSTATE codes in the `P0xxx`
 * range are the "PL/pgSQL raise" block that Postgres reserves for
 * application-defined conditions — in this schema they are a PER-FUNCTION
 * convention, not a global registry. `redeem_coupon` is called from the
 * paywall route with `auth.uid()` identity; `start_run` is called only from
 * the agent route with a service-role client. The two never share a call site,
 * and each call site maps its OWN codes, so `P0002` means `invalid_code` in
 * one route and `run_in_flight` in the other with no ambiguity possible.
 * (`P0001` = insufficient_credits and `P0003` = already_redeemed follow the
 * same rule.)
 *
 * WHERE THE INVARIANT ACTUALLY LIVES. `run_in_flight` is raised by Postgres —
 * by the in-flight `exists` check inside `start_run` and, for any caller that
 * skips the RPC, by the `runs_one_running_per_chat` partial unique index
 * (migration `0007_run_in_flight.sql`). This module only names the refusal for
 * the user; it decides nothing about money.
 */

/**
 * Locked user-facing copy, inherited from Phase 2 and MOVED here byte for byte
 * from `app/api/agent/run/route.ts` (not retyped). It now lives in exactly one
 * place; `tests/start-run-error.test.ts` pins it as an exact literal.
 */
export const INSUFFICIENT_CREDITS_COPY =
  "You are out of credits. Redeem a credit to run another research chat.";

/**
 * The GC-01 refusal. Names the condition in plain language and tells the user
 * the one thing they can do about it. Deliberately says nothing about runs
 * rows, indexes, or SQLSTATE codes.
 */
export const RUN_IN_FLIGHT_COPY =
  "That chat already has a run in progress. Wait for it to finish, then ask again.";

/** An SSE `error` frame's payload: a stable machine code plus fixed copy. */
export interface StartRunRefusal {
  /** The SSE error code the client switches on. */
  code: string;
  /** Fixed, non-interpolated user-facing copy. */
  message: string;
}

/**
 * Maps a `start_run` SQLSTATE code to a client-safe refusal, or `null` when the
 * code is not one this route has classified.
 *
 * `null` is the important half: the caller must then fall through to its
 * existing generic `debit_error` response, which also logs. Inventing copy for
 * an unclassified failure would hide a real defect behind a plausible sentence.
 *
 * @param code `debitErr?.code` — a bare SQLSTATE string. NEVER an error object.
 */
export function mapStartRunError(
  code: string | null | undefined,
): StartRunRefusal | null {
  if (code === "P0001") {
    return { code: "insufficient_credits", message: INSUFFICIENT_CREDITS_COPY };
  }
  if (code === "P0002") {
    return { code: "run_in_flight", message: RUN_IN_FLIGHT_COPY };
  }
  return null;
}
