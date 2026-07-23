import { describe, expect, it } from "vitest";
import { costUsd, type ModelPrices } from "@/lib/pricing";
import type { NormalizedUsage } from "@/lib/agent/adapter";

const PRICES: ModelPrices = {
  inputPer1M: 5,
  outputPer1M: 25,
  cacheReadPer1M: 0.5,
  cacheWritePer1M: 6.25,
};

const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe("costUsd (STAT-01 cost math)", () => {
  it("prices 1e6 input tokens at inputPer1M=5 as exactly 5 USD", () => {
    const cost = costUsd({ ...ZERO_USAGE, inputTokens: 1_000_000 }, PRICES);
    expect(cost).toBe(5);
  });

  it("sums all four columns", () => {
    const cost = costUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      PRICES,
    );
    expect(cost).toBeCloseTo(5 + 25 + 0.5 + 6.25, 10);
  });

  it("returns a finite 0 for all-zero usage", () => {
    const cost = costUsd(ZERO_USAGE, PRICES);
    expect(cost).toBe(0);
    expect(Number.isFinite(cost)).toBe(true);
  });

  it("never NaN when usage fields are undefined", () => {
    const cost = costUsd({} as NormalizedUsage, PRICES);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBe(0);
  });

  it("never NaN when price fields are undefined", () => {
    const cost = costUsd(
      { ...ZERO_USAGE, inputTokens: 1_000_000 },
      {} as ModelPrices,
    );
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBe(0);
  });
});
