/**
 * lib/registry.ts — verified model registry (KEY-04).
 *
 * Source of truth: the "Verified Model Registry (FR-13)" table in .claude/CLAUDE.md
 * (HIGH-confidence, cross-checked against each provider's public pricing page as of
 * 2026-07-18: platform.claude.com/docs pricing, developers.openai.com/api/docs/pricing,
 * platform.kimi.ai/docs/pricing). Prices are USD per 1,000,000 tokens.
 *
 * D-24 per-model check: each value below was reconciled against the CLAUDE.md
 * verified table row-by-row; no live delta was found versus that table, so the
 * table values are used verbatim. (This slice has no live web-fetch tooling; any
 * future provider price change should be reflected here with a dated delta comment.)
 *
 * OQ-1 (RESOLVED by Phase 3 / D-48): the Claude models are now `selectable: true`
 * — the Anthropic NATIVE adapter (lib/agent/models/anthropic.ts, cache_control
 * breakpoints + finalMessage usage merge) landed in Phase 3. The OpenAI-compat
 * shim remains forbidden for Claude (drops cache usage — CM-3). OpenAI/Kimi/
 * OpenRouter stay openai-compat.
 */

export type Provider = "anthropic" | "openai" | "kimi" | "openrouter" | "custom";

export interface ModelSpec {
  id: string;
  provider: Exclude<Provider, "custom">;
  label: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M: number;
  cacheWritePer1M: number; // all four ALWAYS present, never null
  contextTokens: number | null;
  selectable: boolean;
}

export const MODEL_REGISTRY: ModelSpec[] = [
  // ---- Anthropic (Claude) — unlocked by the Phase-3 native adapter (D-48) ----
  // cacheWritePer1M is the 5-minute cache-write rate from the CLAUDE.md table
  // (prices verified consistent with the 1.25x write / 0.1x read multipliers).
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    contextTokens: 1_000_000,
    selectable: true,
  },
  {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 3.75,
    contextTokens: 1_000_000,
    selectable: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    inputPer1M: 1.0,
    outputPer1M: 5.0,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 1.25,
    contextTokens: 200_000,
    selectable: true,
  },

  // ---- OpenAI — openai-compat; cacheWritePer1M = 0 (no separate write charge) ----
  {
    id: "gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    inputPer1M: 5.0,
    outputPer1M: 30.0,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    inputPer1M: 2.5,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.25,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    inputPer1M: 1.0,
    outputPer1M: 6.0,
    cacheReadPer1M: 0.1,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "gpt-5.4-mini",
    provider: "openai",
    label: "GPT-5.4 Mini",
    inputPer1M: 0.75,
    outputPer1M: 4.5,
    cacheReadPer1M: 0.075,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },

  // ---- Kimi (Moonshot) — openai-compat; cacheWritePer1M = 0 ----
  {
    id: "kimi-k3",
    provider: "kimi",
    label: "Kimi K3",
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 0,
    contextTokens: 1_000_000,
    selectable: true,
  },
  {
    id: "kimi-k2.7-code",
    provider: "kimi",
    label: "Kimi K2.7 Code",
    inputPer1M: 0.95,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.19,
    cacheWritePer1M: 0,
    contextTokens: 256_000,
    selectable: true,
  },
  {
    id: "kimi-k2.6",
    provider: "kimi",
    label: "Kimi K2.6",
    inputPer1M: 0.95,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.16,
    cacheWritePer1M: 0,
    contextTokens: 256_000,
    selectable: true,
  },

  // ---- OpenRouter — openai-compat (base URL https://openrouter.ai/api/v1) ----
  // All are FREE models, so all four per-1M prices are 0 (never null) — each
  // prices to a NaN-safe $0 through lib/pricing.ts.
  //
  // NOTE ON ":free" IDS:
  //   (1) OpenRouter rotates its ":free" model ids and retires them over time,
  //       so treat these as CONFIG, not verified constants — the wiring (provider
  //       seam + base URL) is what is permanent, not any specific id.
  //   (2) The six ids below are a CURATED, verified free + tool-capable set listed
  //       in saturation-fallback PRIORITY ORDER (see OPENROUTER_FREE_FALLBACK).
  //       When one is saturated (429 "upstream saturated"), the agent loop offers
  //       the next id in this list — so order is the contract, not a nicety.
  //       Re-confirm against https://openrouter.ai/models if a free id is retired.
  //       (The three unverified guesses — DeepSeek V3.1, Qwen3 235B, Mistral Small
  //       3.2 — and the retired llama-3.3-70b-instruct:free are intentionally gone.)
  {
    id: "inclusionai/ling-3.0-flash:free",
    provider: "openrouter",
    label: "Ling 3.0 Flash (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    provider: "openrouter",
    label: "Nemotron 3 Ultra 550B (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    provider: "openrouter",
    label: "Nemotron 3 Nano Omni 30B (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "poolside/laguna-s-2.1:free",
    provider: "openrouter",
    label: "Laguna S 2.1 (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "cohere/north-mini-code:free",
    provider: "openrouter",
    label: "North Mini Code (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "poolside/laguna-xs-2.1:free",
    provider: "openrouter",
    label: "Laguna XS 2.1 (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
];

/**
 * OPENROUTER_FREE_FALLBACK — the single shared saturation-fallback priority list.
 *
 * The server (lib/agent/loop.ts) slices the ids AFTER the saturated one to build
 * the `rate_limited` SSE fallback set; the client (components/ChatThread.tsx)
 * defaults its chooser to `OPENROUTER_FREE_FALLBACK[0]`. Kept as an explicit
 * string-literal array (NOT derived from MODEL_REGISTRY) so the tests pin it as a
 * contract; its order MUST equal the openrouter entry order in MODEL_REGISTRY.
 */
export const OPENROUTER_FREE_FALLBACK: string[] = [
  "inclusionai/ling-3.0-flash:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "poolside/laguna-s-2.1:free",
  "cohere/north-mini-code:free",
  "poolside/laguna-xs-2.1:free",
];

const REGISTRY_BY_ID: Map<string, ModelSpec> = new Map(
  MODEL_REGISTRY.map((m) => [m.id, m]),
);

export function getModel(id: string): ModelSpec | undefined {
  return REGISTRY_BY_ID.get(id);
}

/** KEY-01 base-URL pre-fill. `custom` is empty — the user supplies their own. */
export const DEFAULT_BASE_URLS: Record<Provider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  kimi: "https://api.moonshot.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  custom: "",
};
