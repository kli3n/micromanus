import { describe, expect, it } from "vitest";
import { RUN_WEDGE_CEILING_MS, isRunWedged } from "@/lib/chat/run-staleness";

/**
 * REGRESSION: review GW-02 (a wedged run permanently disables the composer).
 *
 * WR-01 made `pendingAssistantId` a reload-surviving in-flight signal, re-seeded
 * from the server on every load while the latest run reads `'running'`. That is
 * correct for money, but a run that NEVER reaches a terminal status — a hard
 * kill at the 300s Fluid Compute ceiling, an evicted `waitUntil` task, or a
 * Postgres refusal that survives both terminal-write attempts — then holds the
 * chat's composer disabled forever, with a spinner that never stops.
 *
 * `isRunWedged` is the bound. These cases pin BOTH sides of the ceiling as named
 * tests, plus the fail-safe direction: an unestablishable start releases the
 * guard, because an immortal in-flight signal from a malformed row is exactly
 * the defect being closed.
 */

const T0 = Date.parse("2026-08-03T05:00:00.000Z");
const START = new Date(T0).toISOString();

describe("RUN_WEDGE_CEILING_MS — a pinned platform fact, not a tuning knob", () => {
  it("is exactly 330_000 ms (330s > the 300s Fluid Compute maxDuration)", () => {
    expect(RUN_WEDGE_CEILING_MS).toBe(330_000);
  });
});

describe("isRunWedged — a running run is wedged only past the platform ceiling", () => {
  it("is FALSE at zero age — the run just started", () => {
    expect(isRunWedged({ status: "running", startedAt: START, now: T0 })).toBe(
      false,
    );
  });

  it("is FALSE at exactly 329_999 ms of age (one ms inside the ceiling)", () => {
    expect(
      isRunWedged({ status: "running", startedAt: START, now: T0 + 329_999 }),
    ).toBe(false);
  });

  it("is TRUE at exactly 330_000 ms of age (the ceiling itself)", () => {
    expect(
      isRunWedged({ status: "running", startedAt: START, now: T0 + 330_000 }),
    ).toBe(true);
  });

  it("is TRUE at 600_000 ms of age (long past any live run)", () => {
    expect(
      isRunWedged({ status: "running", startedAt: START, now: T0 + 600_000 }),
    ).toBe(true);
  });
});

describe("isRunWedged — a terminal run is not 'wedged' at any age", () => {
  const ages = [0, 329_999, 330_000, 600_000, 86_400_000];
  const statuses = [
    "succeeded",
    "failed",
    "budget_exhausted",
    "queued",
    "",
    null,
    undefined,
  ];

  it("is FALSE for every non-running status at every age", () => {
    for (const status of statuses) {
      for (const age of ages) {
        expect(
          isRunWedged({ status, startedAt: START, now: T0 + age }),
          `status=${JSON.stringify(status)} age=${age}`,
        ).toBe(false);
      }
    }
  });

  it("is FALSE for a non-running status even with an unparseable started_at", () => {
    expect(
      isRunWedged({ status: "succeeded", startedAt: null, now: T0 }),
    ).toBe(false);
  });
});

describe("isRunWedged — fail-safe: an unestablishable start RELEASES the guard", () => {
  it("is TRUE when started_at is null on a running row", () => {
    expect(isRunWedged({ status: "running", startedAt: null, now: T0 })).toBe(
      true,
    );
  });

  it("is TRUE when started_at is undefined on a running row", () => {
    expect(
      isRunWedged({ status: "running", startedAt: undefined, now: T0 }),
    ).toBe(true);
  });

  it("is TRUE when started_at is the empty string on a running row", () => {
    expect(isRunWedged({ status: "running", startedAt: "", now: T0 })).toBe(
      true,
    );
  });

  it("is TRUE when started_at is unparseable on a running row", () => {
    for (const bad of ["not-a-date", "  ", "2026-13-45T99:99:99Z", "NaN"]) {
      expect(
        isRunWedged({ status: "running", startedAt: bad, now: T0 }),
        `startedAt=${JSON.stringify(bad)}`,
      ).toBe(true);
    }
  });
});

describe("isRunWedged — clock skew must not create an immortal signal", () => {
  it("is TRUE when started_at is in the future by MORE than the ceiling", () => {
    expect(
      isRunWedged({ status: "running", startedAt: START, now: T0 - 330_001 }),
    ).toBe(true);
  });

  it("is FALSE for modest future skew (inside the ceiling), so a real run survives", () => {
    expect(
      isRunWedged({ status: "running", startedAt: START, now: T0 - 60_000 }),
    ).toBe(false);
    expect(
      isRunWedged({ status: "running", startedAt: START, now: T0 - 330_000 }),
    ).toBe(false);
  });
});
