/**
 * lib/chat/run-guard.ts — pure send-eligibility predicates for the composer
 * (WR-01; requirement PAY-05).
 *
 * ZERO IMPORTS by design, following the `lib/registry-view.ts` precedent: a
 * node-env Vitest run can pin these without pulling in the `"use client"`
 * ChatThread component or any React/Next module.
 *
 * WHY THIS EXISTS — money correctness. One user question must produce exactly
 * one `start_run` debit. The server's atomic debit RPC and the append-only
 * ledger's Postgres invariants remain the AUTHORITY on money; this module is
 * the client-side layer that stops the browser from ASKING for a second debit
 * while the first run is still executing under `waitUntil`.
 *
 * `isRunInFlight` is the SINGLE authority on "a run this tab must not race".
 * Both consumers — `submit()`'s early return and the send button's `disabled`
 * — MUST be handed the SAME computed value; neither may recompute or
 * reimplement the rule. `canStartRun` and `sendDisabled` therefore TAKE the
 * in-flight boolean as a parameter rather than deriving it. `tests/
 * run-guard.test.ts` pins their agreement across all eight combinations of the
 * three signals, so the two wired surfaces cannot drift apart.
 *
 * ALL THREE signals are required, and the third is the one that must not be
 * forgotten:
 *   - `streaming`  — an SSE reader is live in this tab.
 *   - `pending`    — this tab OWNS an in-flight run; survives a broken stream,
 *                    but is deliberately FALSE on a refreshed/reopened tab
 *                    (see the contract comment in `components/ChatThread.tsx`
 *                    beside `pendingAssistantId`).
 *   - `pendingAssistantId` — the assistant placeholder still awaiting a
 *                    terminal run status. The ONLY signal that survives a
 *                    reload, so without it a reopened tab happily fires a
 *                    second run while the first is still going: two debits for
 *                    one question.
 *
 * Note the two sampling points are legitimately different and that is not a
 * divergence in the RULE: `submit()` samples the REFS at call time (mutating a
 * ref does not re-render, so a render-time snapshot would be stale exactly
 * during a double-tap), while the button's `disabled` reads the state-backed
 * signals during render (a ref change produces no re-render, which is precisely
 * why `submit()` — not the button — is the authoritative gate, and why the
 * textarea's Enter path delegates to `submit()`).
 */

/** The three run-ownership signals. */
export interface RunOwnershipSignals {
  /**
   * `streamingRef.current` at call time (in `submit()`), or `streamingId !==
   * null` during render (for the button).
   */
  streaming: boolean;
  /** `pendingRef.current`. FALSE on a reopened tab by design. */
  pending: boolean;
  /** The pending assistant placeholder id — the only reload-surviving signal. */
  pendingAssistantId: string | null;
}

/**
 * TRUE when ANY ownership signal is set. The single authority: compute it once
 * per surface and pass the result to the predicates below.
 */
export function isRunInFlight(signals: RunOwnershipSignals): boolean {
  return (
    signals.streaming || signals.pending || Boolean(signals.pendingAssistantId)
  );
}

/**
 * Whether `submit()` may start a run. `sendingAllowed` folds the balance-> 0 and
 * no-model-picked gates (PAY-05); `runInFlight` MUST come from
 * `isRunInFlight` — never recomputed here.
 */
export function canStartRun(args: {
  text: string;
  sendingAllowed: boolean;
  runInFlight: boolean;
}): boolean {
  return (
    args.text.trim().length > 0 && args.sendingAllowed && !args.runInFlight
  );
}

/**
 * Whether the send button renders disabled. Takes the SAME `runInFlight` value
 * `canStartRun` is given, so the button and `submit()` can never disagree.
 */
export function sendDisabled(args: {
  inputEmpty: boolean;
  runInFlight: boolean;
}): boolean {
  return args.inputEmpty || args.runInFlight;
}
