/**
 * lib/pricing.ts — provider-reported cost math (STAT-01, FR-27).
 *
 * Cost is ALWAYS derived from the provider's `usage` object (never a client-side
 * token estimate). Every token/price field is coerced to a finite 0 before the
 * multiply so the result is finite and never NaN — even on zero, missing, or
 * partially-populated usage (RESEARCH Pitfall 2).
 */
import type { NormalizedUsage } from "@/lib/agent/adapter";

export interface ModelPrices {
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number;
}

/** Coerce any missing/non-finite numeric field to 0. */
function finite(x: number | undefined | null): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** Sum `(tokens / 1e6) * pricePer1M` across the four columns. Never NaN. */
export function costUsd(
  usage: NormalizedUsage | undefined | null,
  prices: ModelPrices | undefined | null,
): number {
  const u = usage ?? ({} as Partial<NormalizedUsage>);
  const p = prices ?? ({} as Partial<ModelPrices>);
  const line = (tokens: number | undefined, price: number | undefined): number =>
    (finite(tokens) / 1_000_000) * finite(price);
  return (
    line(u.inputTokens, p.inputPer1M) +
    line(u.outputTokens, p.outputPer1M) +
    line(u.cacheReadTokens, p.cacheReadPer1M) +
    line(u.cacheWriteTokens, p.cacheWritePer1M)
  );
}
