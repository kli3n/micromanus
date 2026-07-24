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
 * OQ-1: every Claude model is `selectable: false` — the Anthropic NATIVE adapter
 * (cache_control) lands in Phase 3, and the OpenAI-compat shim is forbidden for
 * Claude (drops cache usage). OpenAI/Kimi are openai-compat and selectable now.
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
  // ---- Anthropic (Claude) — selectable:false until the Phase-3 native adapter ----
  // cacheWritePer1M is the 5-minute cache-write rate from the CLAUDE.md table.
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    inputPer1M: 5.0,
    outputPer1M: 25.0,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    contextTokens: 1_000_000,
    selectable: false,
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
    selectable: false,
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
    selectable: false,
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
  //   (2) These exact ids could NOT be verified live in this slice — confirm or
  //       swap them against https://openrouter.ai/models before relying on one.
  //   (3) DeepSeek V3.1, Qwen3 235B, and Mistral Small 3.2 are the ones EXPECTED
  //       to support OpenAI-style tool calling for the web_search / fetch_page
  //       agent loop; DeepSeek V3.1 is the recommended agent-loop candidate.
  //       Ling 3.0 Flash is retained as a lightweight free fallback. (The retired
  //       llama-3.3-70b-instruct:free id from the 2026-07-24 debug is NOT re-added.)
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
    id: "deepseek/deepseek-chat-v3.1:free",
    provider: "openrouter",
    label: "DeepSeek V3.1 (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "qwen/qwen3-235b-a22b:free",
    provider: "openrouter",
    label: "Qwen3 235B (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "mistralai/mistral-small-3.2-24b-instruct:free",
    provider: "openrouter",
    label: "Mistral Small 3.2 (free · OpenRouter)",
    inputPer1M: 0,
    outputPer1M: 0,
    cacheReadPer1M: 0,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
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
