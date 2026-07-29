import { describe, expect, it } from "vitest";
import { fromAnthropic, fromOpenAI, type NormalizedUsage } from "@/lib/agent/adapter";
import { costUsd } from "@/lib/pricing";
import { getModel } from "@/lib/registry";

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

  it("normalizes a realistic cached-turn payload (openai@6.48.0 CompletionUsage shape)", () => {
    // Verbatim realistic cached turn — 03-RESEARCH.md Example 4.
    const u = fromOpenAI({
      prompt_tokens: 9200,
      completion_tokens: 420,
      total_tokens: 9620,
      prompt_tokens_details: { cached_tokens: 8000 },
    });
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 1200,
      outputTokens: 420,
      cacheReadTokens: 8000,
      cacheWriteTokens: 0,
    });
  });
});

describe("fromAnthropic (RSCH-05 usage seam — fixtures A1-A7, D-48/D-51)", () => {
  it("A1: verbatim message_start usage — cache-less turn maps 1:1", () => {
    const u = fromAnthropic({
      input_tokens: 2679,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
    });
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 2679,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("A2: cache WRITE maps to cacheWriteTokens and inputTokens stays 1200 (no subtraction)", () => {
    const u = fromAnthropic({
      input_tokens: 1200,
      cache_creation_input_tokens: 8000,
      cache_read_input_tokens: 0,
      output_tokens: 420,
    });
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 1200,
      outputTokens: 420,
      cacheReadTokens: 0,
      cacheWriteTokens: 8000,
    });
  });

  it("A3: cache READ maps to cacheReadTokens and inputTokens stays 1200 — the no-subtraction rule", () => {
    // The single most important assertion in the phase: input_tokens is ALREADY
    // the uncached remainder; subtracting would silently understate billable input.
    const u = fromAnthropic({
      input_tokens: 1200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8000,
      output_tokens: 420,
    });
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 1200,
      outputTokens: 420,
      cacheReadTokens: 8000,
      cacheWriteTokens: 0,
    });
  });

  it("A4: the variably-shaped message_delta payload ({output_tokens: 89} only) → absent fields are 0", () => {
    const u = fromAnthropic({ output_tokens: 89 });
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 0,
      outputTokens: 89,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("A5: null cache fields coerce to 0 (never null, never NaN)", () => {
    const u = fromAnthropic({
      input_tokens: 100,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: 5,
    });
    expect(u).toEqual<NormalizedUsage>({
      inputTokens: 100,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("A6: empty/undefined usage → all zeros, all finite (mirrors the fromOpenAI empty case)", () => {
    for (const input of [{}, undefined]) {
      const u = fromAnthropic(input);
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
    }
  });

  it("A7: A3 priced via costUsd with claude-opus-4-8 registry prices", () => {
    const u = fromAnthropic({
      input_tokens: 1200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8000,
      output_tokens: 420,
    });
    const spec = getModel("claude-opus-4-8")!;
    const cost = costUsd(u, {
      inputPer1M: spec.inputPer1M,
      outputPer1M: spec.outputPer1M,
      cacheReadPer1M: spec.cacheReadPer1M,
      cacheWritePer1M: spec.cacheWritePer1M,
    });
    const expected =
      (1200 / 1e6) * 5.0 + (420 / 1e6) * 25.0 + (8000 / 1e6) * 0.5;
    expect(cost).toBeCloseTo(expected, 12);
    expect(Number.isNaN(cost)).toBe(false);
  });

  it("cross-provider contrast: both adapters reach inputTokens 1200 by OPPOSITE arithmetic", () => {
    // OpenAI: prompt_tokens INCLUDES cached_tokens → subtract (9200 - 8000 = 1200).
    const openai = fromOpenAI({
      prompt_tokens: 9200,
      prompt_tokens_details: { cached_tokens: 8000 },
      completion_tokens: 420,
    });
    // Anthropic: input_tokens EXCLUDES cache tokens → no subtraction (1200 stays 1200).
    const anthropic = fromAnthropic({
      input_tokens: 1200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 8000,
      output_tokens: 420,
    });
    expect(openai.inputTokens).toBe(1200);
    expect(anthropic.inputTokens).toBe(1200);
    expect(openai.cacheReadTokens).toBe(8000);
    expect(anthropic.cacheReadTokens).toBe(8000);
    // Same NormalizedUsage from structurally different provider payloads.
    expect(openai).toEqual(anthropic);
  });
});
