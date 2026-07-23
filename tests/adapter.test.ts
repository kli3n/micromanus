import { describe, expect, it } from "vitest";
import { fromOpenAI, type NormalizedUsage } from "@/lib/agent/adapter";

describe("fromOpenAI (STAT-01 usage seam)", () => {
  it("subtracts cached tokens from prompt_tokens so cache is not double-counted", () => {
    const u = fromOpenAI({
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 70,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
  });

  it("returns all zeros (never NaN/negative) for empty usage", () => {
    const u = fromOpenAI({});
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    for (const v of Object.values(u)) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("never yields negative input when cached exceeds prompt_tokens", () => {
    const u = fromOpenAI({
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 40 },
    });
    expect(u.inputTokens).toBe(0);
    expect(u.cacheReadTokens).toBe(40);
  });

  it("cache columns default to 0 when details are absent", () => {
    const u = fromOpenAI({ prompt_tokens: 42, completion_tokens: 7 });
    expect(u.inputTokens).toBe(42);
    expect(u.outputTokens).toBe(7);
    expect(u.cacheReadTokens).toBe(0);
    expect(u.cacheWriteTokens).toBe(0);
  });
});
