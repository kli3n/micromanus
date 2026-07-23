import { describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URLS,
  getModel,
  MODEL_REGISTRY,
  type ModelSpec,
} from "@/lib/registry";

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

  it("marks all anthropic models non-selectable and all openai/kimi selectable", () => {
    for (const m of MODEL_REGISTRY) {
      if (m.provider === "anthropic") {
        expect(m.selectable, `${m.id} selectable`).toBe(false);
      } else {
        expect(m.selectable, `${m.id} selectable`).toBe(true);
      }
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
