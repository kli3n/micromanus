import { describe, expect, it } from "vitest";
import { formatElapsed, meterLabel } from "@/components/chat/RunMeter";

/**
 * RunMeter pure helpers (STAT-06 / D-55, D-56 — 03-03 Task 2).
 *
 * Locked copy (03-UI-SPEC Copywriting Contract, 🔒 — do not reword):
 *   running:  "iteration {n}/12 · {m}:{ss} elapsed"
 *   terminal: "{n} iterations · {m}:{ss}"
 *
 * The terminal form renders the SUPPLIED elapsedMs — the server-computed
 * ended_at - started_at from the meter carrier payload — never a value
 * recomputed from the client clock (D-56, RESEARCH C2).
 */

describe("formatElapsed (STAT-06 meter math)", () => {
  it('formats 0 as "0:00"', () => {
    expect(formatElapsed(0)).toBe("0:00");
  });

  it('formats 112000 ms as "1:52"', () => {
    expect(formatElapsed(112_000)).toBe("1:52");
  });

  it('formats 221000 ms as "3:41"', () => {
    expect(formatElapsed(221_000)).toBe("3:41");
  });

  it("zero-pads seconds below 10", () => {
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(9_000)).toBe("0:09");
  });

  it('clamps negative values to "0:00"', () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });

  it('renders NaN and non-finite input as "0:00" (never "NaN:NaN")', () => {
    expect(formatElapsed(Number.NaN)).toBe("0:00");
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0:00");
  });

  it("floors sub-second remainders (no rounding up)", () => {
    expect(formatElapsed(59_999)).toBe("0:59");
  });
});

describe("meterLabel (locked copy — 🔒 do not reword)", () => {
  it('running: "iteration {n}/12 · {m}:{ss} elapsed"', () => {
    expect(meterLabel({ running: true, iterations: 4, elapsedMs: 112_000 })).toBe(
      "iteration 4/12 · 1:52 elapsed",
    );
  });

  it('terminal: "{n} iterations · {m}:{ss}" from the SUPPLIED elapsedMs (server ended_at-started_at, never a recomputed clock)', () => {
    expect(meterLabel({ running: false, iterations: 7, elapsedMs: 221_000 })).toBe(
      "7 iterations · 3:41",
    );
  });

  it("terminal with a defensive missing elapsedMs (NaN) settles to 0:00, never NaN", () => {
    expect(meterLabel({ running: false, iterations: 3, elapsedMs: Number.NaN })).toBe(
      "3 iterations · 0:00",
    );
  });
});
