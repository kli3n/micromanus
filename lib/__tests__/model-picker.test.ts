import { describe, expect, it } from "vitest";
import { buildRegistryView } from "@/lib/registry-view";
import type { ModelSpec } from "@/lib/registry";

/**
 * KEY-05 / D-22 / OQ-1: the pure registry-view builder decides grey-out +
 * selectability. Tested in node-env by importing only the plain helper (no
 * next/react, so the "use client" ModelPicker is never pulled in).
 */

const fixture: ModelSpec[] = [
  {
    id: "gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    inputPer1M: 2.5,
    outputPer1M: 15,
    cacheReadPer1M: 0.25,
    cacheWritePer1M: 0,
    contextTokens: null,
    selectable: true,
  },
  {
    id: "kimi-k3",
    provider: "kimi",
    label: "Kimi K3",
    inputPer1M: 3,
    outputPer1M: 15,
    cacheReadPer1M: 0.3,
    cacheWritePer1M: 0,
    contextTokens: 1_000_000,
    selectable: true,
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
    inputPer1M: 5,
    outputPer1M: 25,
    cacheReadPer1M: 0.5,
    cacheWritePer1M: 6.25,
    contextTokens: 1_000_000,
    selectable: true, // unlocked by Phase 3 (D-48)
  },
];

describe("buildRegistryView (D-22 grey-out / OQ-1)", () => {
  it("returns one row per model — nothing hidden (D-22)", () => {
    expect(buildRegistryView(fixture, ["openai"])).toHaveLength(fixture.length);
  });

  it("projects the four price columns onto each row", () => {
    const [openai] = buildRegistryView(fixture, ["openai"]);
    expect(openai).toMatchObject({
      id: "gpt-5.6-terra",
      provider: "openai",
      inputPrice: 2.5,
      outputPrice: 15,
      cacheReadPrice: 0.25,
      cacheWritePrice: 0,
    });
  });

  it("unlocks + makes selectable a saved non-anthropic provider", () => {
    const view = buildRegistryView(fixture, ["openai"]);
    const openai = view.find((r) => r.id === "gpt-5.6-terra")!;
    expect(openai.locked).toBe(false);
    expect(openai.selectable).toBe(true);
    expect(openai.nudge).toBeUndefined();
  });

  it("locks a missing-key provider with an 'add key' nudge", () => {
    const view = buildRegistryView(fixture, ["openai"]);
    const kimi = view.find((r) => r.id === "kimi-k3")!;
    expect(kimi.locked).toBe(true);
    expect(kimi.selectable).toBe(false);
    expect(kimi.nudge).toBe("add key");
  });

  it("marks an anthropic model selectable once its key is saved (OQ-1 resolved — D-48)", () => {
    const view = buildRegistryView(fixture, ["anthropic", "openai"]);
    const claude = view.find((r) => r.id === "claude-opus-4-8")!;
    expect(claude.selectable).toBe(true);
    expect(claude.locked).toBe(false);
    // Row still present (D-22 shows, never hides).
    expect(view).toHaveLength(fixture.length);
  });

  it("still locks an anthropic model when no anthropic key is saved", () => {
    const view = buildRegistryView(fixture, ["openai"]);
    const claude = view.find((r) => r.id === "claude-opus-4-8")!;
    expect(claude.selectable).toBe(false);
    expect(claude.locked).toBe(true);
    expect(claude.nudge).toBe("add key");
  });

  it("locks everything when no provider key is saved", () => {
    const view = buildRegistryView(fixture, []);
    expect(view.every((r) => r.locked)).toBe(true);
    expect(view.every((r) => !r.selectable)).toBe(true);
  });
});
