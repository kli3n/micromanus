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

// Phase-3 slot (do NOT implement now — reserved shape only):
// export function fromAnthropic(usage: unknown): NormalizedUsage {
//   // Anthropic native `usage.input_tokens` EXCLUDES cache tokens (no subtraction);
//   //   cache_read_input_tokens     -> cacheReadTokens
//   //   cache_creation_input_tokens -> cacheWriteTokens
// }
