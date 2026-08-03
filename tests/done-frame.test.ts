import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  doneFrameSettles,
  isStartRefusalDone,
  type DoneFramePayload,
} from "@/lib/chat/done-frame";

/**
 * REGRESSION: review RC-01 — every start-time refusal, including GC-01's new
 * `run_in_flight` copy, was erased from the screen before the user could read
 * it.
 *
 * THE SHAPE OF THE BUG. `sseErrorResponse` writes two frames into one stream:
 * `error` (the copy) and then `done { runId: null, status: "failed" }`. The
 * client's `done` handler unconditionally called `settleFromDb()`, which calls
 * `reconcileFromDb()` — a whole-list REPLACE from the `messages` table. A
 * refused `start_run` inserts NO rows, so the DB list contains neither the
 * optimistic `local-u-*` question nor the `local-a-*` refusal bubble, and
 * `reconcileFromDb` returns true whenever the chat has ANY prior message. Both
 * bubbles were therefore discarded ~one round-trip after appearing, on every
 * chat with history — and `submit()` had already cleared the textarea. Net
 * effect: the send silently did nothing.
 *
 * WHY IT SURVIVED MANUAL TESTING. On a brand-new chat there are no rows to
 * reconcile from, so `reconcileFromDb` returns false and the bubbles survive.
 * It only reproduces on a chat that already has messages.
 *
 * THIS FILE PINS BOTH HALVES, because the round-3 lesson is that a correct
 * mechanism with an unwired consumer is dead code whose suite still passes:
 *
 *   1. The RULE (`isStartRefusalDone` / `doneFrameSettles`).
 *   2. The WIRING — source assertions that `sseErrorResponse` still emits the
 *      `runId: null` discriminator, that the loop's three terminal frames still
 *      emit a real one, and that ChatThread's `done` case consults the rule
 *      BEFORE it reaches `settleFromDb`. None of those three would change a
 *      single behavioural assertion if they regressed.
 */

/** The `done` payload `sseErrorResponse` puts on the wire, verbatim. */
const REFUSAL: DoneFramePayload = { runId: null, status: "failed" };

/** The `done` payload `lib/agent/loop.ts` puts on the wire, verbatim. */
const RUN_ID = "9f1c2d3e-0000-4000-8000-000000000001";

describe("isStartRefusalDone — the refusal frame must never settle (RC-01)", () => {
  it("classifies sseErrorResponse's exact payload as a refusal", () => {
    expect(isStartRefusalDone(REFUSAL)).toBe(true);
    expect(doneFrameSettles(REFUSAL)).toBe(false);
  });

  it("classifies the loop's three terminal payloads as real runs", () => {
    for (const status of ["succeeded", "budget_exhausted", "failed"]) {
      const frame = { runId: RUN_ID, status };
      expect(isStartRefusalDone(frame), `status=${status}`).toBe(false);
      expect(doneFrameSettles(frame), `status=${status}`).toBe(true);
    }
  });

  it("cannot discriminate on `status`, which is why runId is the discriminator", () => {
    // Both a refusal and the loop's failure path send status "failed". A guard
    // written against `status` would close nothing.
    expect(REFUSAL.status).toBe("failed");
    expect(isStartRefusalDone({ runId: RUN_ID, status: "failed" })).toBe(false);
    expect(isStartRefusalDone({ runId: null, status: "failed" })).toBe(true);
  });

  it("resolves every ambiguous shape to REFUSAL — the harmless side", () => {
    // A false "refusal" on a real terminal frame costs nothing durable: the
    // Realtime runs terminal UPDATE and the 4s status poll both still call
    // settleFromDb. A false "terminal" on a refusal is the RC-01 data loss.
    for (const runId of [undefined, null, "", 0, 1, false, {}, []]) {
      expect(
        isStartRefusalDone({ runId } as DoneFramePayload),
        `runId=${JSON.stringify(runId)}`,
      ).toBe(true);
    }
    expect(isStartRefusalDone({})).toBe(true);
  });

  it("doneFrameSettles is the exact complement, so the two surfaces cannot drift", () => {
    for (const runId of [undefined, null, "", 7, RUN_ID]) {
      const frame = { runId } as DoneFramePayload;
      expect(doneFrameSettles(frame)).toBe(!isStartRefusalDone(frame));
    }
  });
});

const ROUTE = readFileSync(
  new URL("../app/api/agent/run/route.ts", import.meta.url),
  "utf8",
);
const LOOP = readFileSync(
  new URL("../lib/agent/loop.ts", import.meta.url),
  "utf8",
);
const THREAD = readFileSync(
  new URL("../components/ChatThread.tsx", import.meta.url),
  "utf8",
);

describe("the runId discriminator is still on the wire (RC-01, producer side)", () => {
  it("sseErrorResponse sends done with runId: null", () => {
    expect(ROUTE).toMatch(/s\.send\("done",\s*\{\s*runId:\s*null,/);
  });

  it("sseErrorResponse is the ONLY done frame in the route", () => {
    expect(ROUTE.match(/send\("done"/g) ?? []).toHaveLength(1);
  });

  it("all three of the loop's terminal done frames send a real runId", () => {
    const frames = LOOP.match(/send\("done",\s*\{[^}]*\}/g) ?? [];
    expect(frames).toHaveLength(3);
    for (const f of frames) {
      expect(f).toMatch(/runId,/);
      expect(f).not.toMatch(/runId:\s*null/);
    }
  });
});

describe("ChatThread consults the rule BEFORE it settles (RC-01, consumer side)", () => {
  it("imports the rule rather than reimplementing it inline", () => {
    expect(THREAD).toMatch(
      /import \{ isStartRefusalDone \} from "@\/lib\/chat\/done-frame";/,
    );
  });

  it("guards the refusal case ahead of the settleFromDb call in the done branch", () => {
    const doneAt = THREAD.indexOf('case "done":');
    expect(doneAt).toBeGreaterThan(-1);
    const guardAt = THREAD.indexOf("isStartRefusalDone(data)", doneAt);
    const settleAt = THREAD.indexOf("void settleFromDb();", doneAt);
    expect(guardAt).toBeGreaterThan(doneAt);
    expect(settleAt).toBeGreaterThan(guardAt);
    // The guard's body must break out of the switch, or the settle below still
    // runs and the wipe is unchanged.
    expect(THREAD.slice(guardAt, settleAt)).toMatch(/break;/);
  });

  it("hands the typed question back on the refusal path only", () => {
    const doneAt = THREAD.indexOf('case "done":');
    const settleAt = THREAD.indexOf("void settleFromDb();", doneAt);
    const refusalBranch = THREAD.slice(doneAt, settleAt);
    expect(refusalBranch).toMatch(
      /setInput\(\(cur\) => cur \|\| lastUserTextRef\.current\)/,
    );
    // Restoring it from the `error` handler instead would put a REAL run's
    // question back into the composer while settleFromDb re-renders it in the
    // thread — one question in two places.
    const errorAt = THREAD.indexOf('case "error": {', doneAt);
    expect(errorAt).toBeGreaterThan(settleAt);
    expect(THREAD.slice(errorAt)).not.toMatch(
      /setInput\(\(cur\) => cur \|\| lastUserTextRef\.current\)/,
    );
  });
});
