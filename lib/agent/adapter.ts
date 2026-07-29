/**
 * lib/agent/adapter.ts — the normalized usage seam (STAT-01, KEY-04).
 *
 * Every model call is reduced to a 4-column usage object. Cache columns ALWAYS
 * default to 0 (never null/undefined) so the stats-page cost math can never NaN
 * on a short, failed, or cache-less turn (RESEARCH Pitfall 2).
 *
 * openai-compat providers (OpenAI, Kimi, custom base URLs) route through
 * `fromOpenAI`. The Anthropic-native shape is a Phase-3 slot (reserved as a
 * comment below) because Anthropic's OpenAI-compat shim silently drops
 * cache_control + cache usage — the exact trap this seam isolates.
 */

export interface NormalizedUsage {
  /** FULL-PRICE (uncached) input only = prompt_tokens - cached_tokens. */
  inputTokens: number;
  outputTokens: number;
  /** Default 0, never null. */
  cacheReadTokens: number;
  /** Default 0 — openai-compat providers have no separate cache-write charge. */
  cacheWriteTokens: number;
}

interface OpenAIUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/**
 * Normalize an OpenAI/Kimi (openai-compat) `usage` object.
 *
 * IMPORTANT (RESEARCH Pitfall 1): `prompt_tokens` INCLUDES `cached_tokens`, so we
 * subtract to avoid pricing the cached portion twice (once at input rate, once at
 * cache-read rate). Anthropic-native is the opposite (input_tokens already
 * excludes cache) — hence the seam.
 */
export function fromOpenAI(usage: unknown): NormalizedUsage {
  const u = (usage ?? {}) as OpenAIUsageShape;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cached),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

interface AnthropicUsageShape {
  input_tokens?: number; // EXCLUDES cache tokens (unlike OpenAI's prompt_tokens)
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Normalize an Anthropic-native `usage` object (RSCH-05, D-48).
 *
 * INVARIANT (the mirror image of fromOpenAI): total prompt size =
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * `input_tokens` is the UNCACHED REMAINDER ONLY, so there is NOTHING to
 * subtract. Subtracting here would silently understate billable input.
 * fromOpenAI must subtract because OpenAI's `prompt_tokens` INCLUDES
 * `prompt_tokens_details.cached_tokens`.
 *
 * Cache fields can be absent OR null when caching is unused — coerce both to 0
 * so the stats-page math can never NaN (Pitfall 2 from Phase 2).
 *
 * Deliberately UNMAPPED (double-count / no-column risks):
 *   - usage.cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}
 *     (a sub-split of cache_creation_input_tokens — mapping both double-counts)
 *   - usage.output_tokens_details.thinking_tokens (no NormalizedUsage column;
 *     thinking is never enabled on this request shape)
 */
export function fromAnthropic(usage: unknown): NormalizedUsage {
  const u = (usage ?? {}) as AnthropicUsageShape;
  const n = (x: number | null | undefined): number =>
    typeof x === "number" && Number.isFinite(x) ? Math.max(0, x) : 0;
  return {
    inputTokens: n(u.input_tokens), // NO subtraction
    outputTokens: n(u.output_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
  };
}
