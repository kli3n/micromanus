import { describe, expect, it } from "vitest";
import { savingsUsd } from "@/lib/pricing";

/**
 * STAT-05 cache-savings math (D-53).
 *
 * savings = cacheReadTokens / 1e6 * (inputPricePer1M - cacheReadPricePer1M),
 * clamped >= 0, never NaN, computed ONLY from stored event-time prices — the
 * caller passes usage_events columns, never lib/registry.ts values.
 */
describe("savingsUsd (STAT-05 cache savings, D-53)", () => {
  it("prices 8000 cache-read tokens at (5.00 - 0.50) as 0.036 USD (A3/A7 case)", () => {
    expect(savingsUsd(8000, 5.0, 0.5)).toBeCloseTo(0.036, 12);
  });

  it("returns 0 for zero cache-read tokens regardless of prices", () => {
    expect(savingsUsd(0, 5.0, 0.5)).toBe(0);
    expect(savingsUsd(0, 123.45, 0.01)).toBe(0);
  });

  it("clamps to 0 when the stored cache-read price exceeds the input price", () => {
    // An odd hand-edited price pair must render $0.000, never a negative saving.
    expect(savingsUsd(1000, 0.1, 5.0)).toBe(0);
  });

  it("coerces NaN/undefined/Infinity in any argument to 0 — never NaN out", () => {
    expect(savingsUsd(Number.NaN, 5.0, 0.5)).toBe(0);
    expect(savingsUsd(8000, Number.NaN, 0.5)).toBe(0);
    expect(savingsUsd(8000, 5.0, Number.NaN)).toBe(0);
    expect(
      savingsUsd(undefined as unknown as number, 5.0, 0.5),
    ).toBe(0);
    expect(
      savingsUsd(8000, undefined as unknown as number, 0.5),
    ).toBe(0);
    expect(
      savingsUsd(8000, 5.0, undefined as unknown as number),
    ).toBe(0);
    expect(savingsUsd(Number.POSITIVE_INFINITY, 5.0, 0.5)).toBe(0);
    expect(savingsUsd(8000, Number.POSITIVE_INFINITY, 0.5)).toBe(0);
    expect(savingsUsd(8000, 5.0, Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("prices 1M cache-read tokens at (3.00 - 0.30) as 2.70 USD (claude-sonnet-4-6 arithmetic)", () => {
    expect(savingsUsd(1_000_000, 3.0, 0.3)).toBeCloseTo(2.7, 12);
  });
});
