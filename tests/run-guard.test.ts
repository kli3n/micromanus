import { describe, expect, it } from "vitest";
import {
  canStartRun,
  isRunInFlight,
  sendDisabled,
  type RunOwnershipSignals,
} from "@/lib/chat/run-guard";

/**
 * REGRESSION: review WR-01 (money correctness).
 *
 * One user question must never produce two `start_run` debits. The server-side
 * atomic debit RPC and the ledger's Postgres invariants remain the authority on
 * money; this guard closes the CLIENT path that asks for a second debit.
 *
 * The pre-fix rule, reproduced verbatim from `components/ChatThread.tsx` as it
 * stood before this plan:
 *
 *     if (!text || !canSend || streamingRef.current) return;
 *
 * — it consulted `streamingRef` ONLY. `preFixAllows` below is that exact rule,
 * kept as a live counter-example so the two cases it gets wrong stay
 * demonstrably wrong forever, not just at the moment this plan ran. A guard
 * consulting `streamingRef` + `pendingRef` (the obvious half-fix) is modelled by
 * `halfFixAllows`, and it still gets the REOPENED-TAB case wrong — `pendingRef`
 * is deliberately FALSE on a refreshed/reopened tab (the contract comment at
 * `components/ChatThread.tsx:540-545`), so `pendingAssistantId` is the only one
 * of the three signals that survives a reload.
 */

const preFixAllows = (
  text: string,
  sendingAllowed: boolean,
  s: RunOwnershipSignals,
): boolean => Boolean(text.trim()) && sendingAllowed && !s.streaming;

const halfFixAllows = (
  text: string,
  sendingAllowed: boolean,
  s: RunOwnershipSignals,
): boolean =>
  Boolean(text.trim()) && sendingAllowed && !s.streaming && !s.pending;

/** No run in flight at all. */
const idle: RunOwnershipSignals = {
  streaming: false,
  pending: false,
  pendingAssistantId: null,
};

const TEXT = "compare the two proposals";

describe("isRunInFlight — the single authority over all three ownership signals (WR-01)", () => {
  it("is TRUE on a REOPENED tab, where only pendingAssistantId is set", () => {
    // A refreshed/reopened tab is seeded with initialPendingAssistantId while the
    // server loop is still executing under waitUntil. streaming and pending are
    // both false there BY DESIGN, so this is the case a pendingRef-only guard
    // misses entirely — and it is a full second debit for the same question.
    const reopened: RunOwnershipSignals = {
      streaming: false,
      pending: false,
      pendingAssistantId: "9f1c2d3e-0000-4000-8000-000000000001",
    };

    expect(isRunInFlight(reopened)).toBe(true);
    expect(canStartRun({ text: TEXT, sendingAllowed: true, runInFlight: true })).toBe(
      false,
    );
    expect(
      canStartRun({
        text: TEXT,
        sendingAllowed: true,
        runInFlight: isRunInFlight(reopened),
      }),
    ).toBe(false);

    // Both the pre-fix rule AND the streaming+pending half-fix would have
    // allowed this send. That is exactly the harm WR-01 left open.
    expect(preFixAllows(TEXT, true, reopened)).toBe(true);
    expect(halfFixAllows(TEXT, true, reopened)).toBe(true);
  });

  it("is TRUE after a DROPPED stream, where only the pending flag is set", () => {
    // streamRun's finally already cleared streamingRef; the server loop is still
    // running under waitUntil and pendingRef still marks this tab as the owner.
    const dropped: RunOwnershipSignals = {
      streaming: false,
      pending: true,
      pendingAssistantId: null,
    };

    expect(isRunInFlight(dropped)).toBe(true);
    expect(
      canStartRun({
        text: TEXT,
        sendingAllowed: true,
        runInFlight: isRunInFlight(dropped),
      }),
    ).toBe(false);

    // The pre-fix rule allowed it — the original WR-01 double-debit window.
    expect(preFixAllows(TEXT, true, dropped)).toBe(true);
  });

  it("is TRUE while the SSE stream is live, where only streaming is set", () => {
    const live: RunOwnershipSignals = {
      streaming: true,
      pending: false,
      pendingAssistantId: null,
    };

    expect(isRunInFlight(live)).toBe(true);
    expect(
      canStartRun({
        text: TEXT,
        sendingAllowed: true,
        runInFlight: isRunInFlight(live),
      }),
    ).toBe(false);
    // This is the ONE case the pre-fix rule got right.
    expect(preFixAllows(TEXT, true, live)).toBe(false);
  });

  it("is FALSE only when all three signals are clear", () => {
    expect(isRunInFlight(idle)).toBe(false);
  });
});

describe("canStartRun — text and send-eligibility gates, independent of the in-flight signal", () => {
  it("refuses empty or whitespace-only text even when nothing is in flight", () => {
    for (const text of ["", "   ", "\n\t "]) {
      expect(
        canStartRun({ text, sendingAllowed: true, runInFlight: false }),
        `refuses ${JSON.stringify(text)}`,
      ).toBe(false);
    }
  });

  it("refuses when sending is not allowed (zero balance or no model picked)", () => {
    expect(
      canStartRun({ text: TEXT, sendingAllowed: false, runInFlight: false }),
    ).toBe(false);
  });

  it("permits ONLY with non-empty text, sending allowed, and every in-flight signal clear", () => {
    expect(
      canStartRun({
        text: TEXT,
        sendingAllowed: true,
        runInFlight: isRunInFlight(idle),
      }),
    ).toBe(true);
  });
});

describe("sendDisabled — the button surface consumes the same in-flight value", () => {
  it("is true whenever the in-flight value is true, with non-empty input", () => {
    expect(sendDisabled({ inputEmpty: false, runInFlight: true })).toBe(true);
  });

  it("is true on empty input regardless of the in-flight value", () => {
    expect(sendDisabled({ inputEmpty: true, runInFlight: false })).toBe(true);
    expect(sendDisabled({ inputEmpty: true, runInFlight: true })).toBe(true);
  });

  it("is false only when input is non-empty and nothing is in flight", () => {
    expect(sendDisabled({ inputEmpty: false, runInFlight: false })).toBe(false);
  });
});

describe("the two wired surfaces cannot diverge (T-03-12-01)", () => {
  // Table-driven over the THREE signals themselves — not over two differently
  // shaped parameter lists — because a divergence between submit() and the
  // button is only detectable if both are driven from the same signal triple.
  const combos: RunOwnershipSignals[] = [false, true].flatMap((streaming) =>
    [false, true].flatMap((pending) =>
      [null, "a1"].map((pendingAssistantId) => ({
        streaming,
        pending,
        pendingAssistantId,
      })),
    ),
  );

  it("covers all eight combinations of the three in-flight signals", () => {
    expect(combos).toHaveLength(8);
  });

  it.each(combos)(
    "canStartRun permits exactly when sendDisabled does not (streaming=$streaming pending=$pending pendingAssistantId=$pendingAssistantId)",
    (signals) => {
      const runInFlight = isRunInFlight(signals);
      const allowed = canStartRun({
        text: TEXT,
        sendingAllowed: true,
        runInFlight,
      });
      const disabled = sendDisabled({ inputEmpty: false, runInFlight });
      expect(allowed).toBe(!disabled);
      // And exactly one combination — all-clear — may permit a send.
      expect(allowed).toBe(signals === combos[0]);
    },
  );
});
