import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URLS,
  getModel,
  MODEL_REGISTRY,
  OPENROUTER_FREE_FALLBACK,
  type ModelSpec,
} from "@/lib/registry";
import { buildRegistryView } from "@/lib/registry-view";
import { costUsd, type ModelPrices } from "@/lib/pricing";

const PROVIDERS = ["anthropic", "openai", "kimi"] as const;

describe("MODEL_REGISTRY (KEY-04)", () => {
  it("lists 3-4 models for each of anthropic/openai/kimi", () => {
    for (const p of PROVIDERS) {
      const count = MODEL_REGISTRY.filter((m) => m.provider === p).length;
      expect(count, `${p} model count`).toBeGreaterThanOrEqual(3);
      expect(count, `${p} model count`).toBeLessThanOrEqual(4);
    }
  });

  it("gives every model four finite, non-negative price columns", () => {
    const cols: (keyof ModelSpec)[] = [
      "inputPer1M",
      "outputPer1M",
      "cacheReadPer1M",
      "cacheWritePer1M",
    ];
    for (const m of MODEL_REGISTRY) {
      for (const c of cols) {
        const v = m[c] as number;
        expect(typeof v, `${m.id}.${String(c)} type`).toBe("number");
        expect(Number.isFinite(v), `${m.id}.${String(c)} finite`).toBe(true);
        expect(v, `${m.id}.${String(c)} >= 0`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("has unique model ids", () => {
    const ids = MODEL_REGISTRY.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("marks EVERY registry model selectable — Claude unlocked by the Phase-3 native adapter (D-48)", () => {
    for (const m of MODEL_REGISTRY) {
      expect(m.selectable, `${m.id} selectable`).toBe(true);
    }
  });

  it("getModel returns the matching spec, or undefined for an unknown id", () => {
    const first = MODEL_REGISTRY[0];
    expect(getModel(first.id)).toEqual(first);
    expect(getModel("does-not-exist")).toBeUndefined();
  });

  it("exposes a base URL for every provider incl. custom", () => {
    expect(DEFAULT_BASE_URLS.openai).toBe("https://api.openai.com/v1");
    expect(DEFAULT_BASE_URLS.kimi).toBe("https://api.moonshot.ai/v1");
    expect(DEFAULT_BASE_URLS.anthropic).toBe("https://api.anthropic.com");
    expect(DEFAULT_BASE_URLS.custom).toBe("");
  });
});

describe("OpenRouter provider (KEY-04 / KEY-01 / STAT-01)", () => {
  const openrouterModels = MODEL_REGISTRY.filter(
    (m) => m.provider === "openrouter",
  );

  it("pre-fills the OpenRouter base URL", () => {
    expect(DEFAULT_BASE_URLS.openrouter).toBe("https://openrouter.ai/api/v1");
  });

  it("ships at least one selectable free model with four 0 prices", () => {
    const free = openrouterModels.filter(
      (m) =>
        m.inputPer1M === 0 &&
        m.outputPer1M === 0 &&
        m.cacheReadPer1M === 0 &&
        m.cacheWritePer1M === 0,
    );
    expect(free.length).toBeGreaterThanOrEqual(1);
    for (const m of free) {
      expect(m.selectable, `${m.id} selectable`).toBe(true);
    }
  });

  it("marks EVERY openrouter model free (four 0 prices) and selectable", () => {
    expect(openrouterModels.length).toBeGreaterThanOrEqual(1);
    for (const m of openrouterModels) {
      expect(m.inputPer1M, `${m.id} inputPer1M`).toBe(0);
      expect(m.outputPer1M, `${m.id} outputPer1M`).toBe(0);
      expect(m.cacheReadPer1M, `${m.id} cacheReadPer1M`).toBe(0);
      expect(m.cacheWritePer1M, `${m.id} cacheWritePer1M`).toBe(0);
      expect(m.selectable, `${m.id} selectable`).toBe(true);
    }
  });

  it("registers at least 3 selectable free OpenRouter models (ids not pinned — they rotate)", () => {
    const selectableFree = openrouterModels.filter(
      (m) =>
        m.selectable &&
        m.inputPer1M === 0 &&
        m.outputPer1M === 0 &&
        m.cacheReadPer1M === 0 &&
        m.cacheWritePer1M === 0,
    );
    expect(selectableFree.length).toBeGreaterThanOrEqual(3);
  });

  it("buildRegistryView: every openrouter row is selectable and unlocked with a saved key", () => {
    const rows = buildRegistryView(openrouterModels, ["openrouter"]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.selectable, `${r.id} selectable`).toBe(true);
      expect(r.locked, `${r.id} locked`).toBe(false);
    }
  });

  it("buildRegistryView: every openrouter row is locked with the 'add key' nudge when no key is saved", () => {
    const rows = buildRegistryView(openrouterModels, []);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) {
      expect(r.selectable, `${r.id} selectable`).toBe(false);
      expect(r.locked, `${r.id} locked`).toBe(true);
      expect(r.nudge, `${r.id} nudge`).toBe("add key");
    }
  });

  it("prices the free model to a finite $0 through lib/pricing.ts (never NaN)", () => {
    const free = openrouterModels.find(
      (m) =>
        m.inputPer1M === 0 &&
        m.outputPer1M === 0 &&
        m.cacheReadPer1M === 0 &&
        m.cacheWritePer1M === 0,
    );
    expect(free).toBeDefined();
    const prices: ModelPrices = {
      inputPer1M: free!.inputPer1M,
      outputPer1M: free!.outputPer1M,
      cacheReadPer1M: free!.cacheReadPer1M,
      cacheWritePer1M: free!.cacheWritePer1M,
    };
    const cost = costUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      prices,
    );
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBe(0);
  });
});

describe("OPENROUTER_FREE_FALLBACK (saturation priority)", () => {
  const REMOVED_IDS = [
    "deepseek/deepseek-chat-v3.1:free",
    "qwen/qwen3-235b-a22b:free",
    "mistralai/mistral-small-3.2-24b-instruct:free",
  ];

  it("is a non-empty string[] with no duplicate ids", () => {
    expect(Array.isArray(OPENROUTER_FREE_FALLBACK)).toBe(true);
    expect(OPENROUTER_FREE_FALLBACK.length).toBeGreaterThan(0);
    for (const id of OPENROUTER_FREE_FALLBACK) {
      expect(typeof id).toBe("string");
    }
    expect(new Set(OPENROUTER_FREE_FALLBACK).size).toBe(
      OPENROUTER_FREE_FALLBACK.length,
    );
  });

  it("has length 6 and starts with ling-3.0-tiny:free", () => {
    expect(OPENROUTER_FREE_FALLBACK).toHaveLength(6);
    expect(OPENROUTER_FREE_FALLBACK[0]).toBe("inclusionai/ling-3.0-tiny:free");
  });

  it("resolves every fallback id to a selectable $0 openrouter model", () => {
    for (const id of OPENROUTER_FREE_FALLBACK) {
      const m = getModel(id);
      expect(m, `${id} resolves`).toBeDefined();
      expect(m!.provider, `${id} provider`).toBe("openrouter");
      expect(m!.selectable, `${id} selectable`).toBe(true);
      expect(m!.inputPer1M, `${id} inputPer1M`).toBe(0);
      expect(m!.outputPer1M, `${id} outputPer1M`).toBe(0);
      expect(m!.cacheReadPer1M, `${id} cacheReadPer1M`).toBe(0);
      expect(m!.cacheWritePer1M, `${id} cacheWritePer1M`).toBe(0);
    }
  });

  it("no longer resolves the three unverified guessed ids", () => {
    for (const id of REMOVED_IDS) {
      expect(getModel(id), `${id} removed`).toBeUndefined();
    }
  });

  it("order equals the registry openrouter-entry order", () => {
    const registryOrder = MODEL_REGISTRY.filter(
      (m) => m.provider === "openrouter",
    ).map((m) => m.id);
    expect(registryOrder).toEqual(OPENROUTER_FREE_FALLBACK);
  });
});
