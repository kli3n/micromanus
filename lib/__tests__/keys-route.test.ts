import { describe, expect, it } from "vitest";
import { toKeyMetadata } from "@/lib/keys/metadata";

/**
 * KEY-03 / T-02key-01 security contract test: the /api/keys responses must NEVER
 * leak ciphertext (iv/ct/tag) or plaintext (apiKey). Every response is routed
 * through the pure `toKeyMetadata` projection, so asserting the projection's
 * output shape is the automated guarantee that no internal field can escape.
 *
 * This test lives under lib/** (the Vitest include glob) and imports only the
 * plain projection module — NO next/react — so it runs cleanly under node-env.
 */

// A stored-row fixture that DELIBERATELY includes every ciphertext field, plus
// a stray plaintext apiKey, to prove the projection drops them all.
const storedRow = {
  id: "00000000-0000-0000-0000-000000000001",
  user_id: "11111111-1111-1111-1111-111111111111",
  provider: "openai",
  base_url: "https://api.openai.com/v1",
  iv: "aXYtYmFzZTY0",
  ct: "Y2lwaGVydGV4dA==",
  tag: "YXV0aC10YWc=",
  last4: "8f2a",
  apiKey: "sk-should-never-appear",
  created_at: "2026-07-23T00:00:00Z",
  updated_at: "2026-07-23T00:00:00Z",
};

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "iv" || k === "ct" || k === "tag" || k === "apiKey") return true;
      if (hasForbiddenKey(v)) return true;
    }
  }
  return false;
}

describe("toKeyMetadata (KEY-03 projection)", () => {
  it("returns EXACTLY provider, base_url, last4 — nothing else", () => {
    expect(Object.keys(toKeyMetadata(storedRow)).sort()).toEqual(
      ["base_url", "last4", "provider"].sort(),
    );
  });

  it("carries the correct metadata values through", () => {
    const meta = toKeyMetadata(storedRow);
    expect(meta.provider).toBe("openai");
    expect(meta.base_url).toBe("https://api.openai.com/v1");
    expect(meta.last4).toBe("8f2a");
  });

  it("omits every ciphertext/plaintext field from a single row", () => {
    expect(hasForbiddenKey(toKeyMetadata(storedRow))).toBe(false);
  });

  it("omits ciphertext/plaintext when mapping a list of rows", () => {
    const list = [storedRow, { ...storedRow, provider: "kimi", last4: "9c1d" }].map(
      toKeyMetadata,
    );
    expect(list).toHaveLength(2);
    expect(hasForbiddenKey(list)).toBe(false);
    // Sanity: the walker itself would catch a forbidden key if present.
    expect(hasForbiddenKey([{ iv: "x" }])).toBe(true);
  });

  it("tolerates a null base_url (metadata still safe)", () => {
    const meta = toKeyMetadata({ ...storedRow, base_url: null });
    expect(Object.keys(meta).sort()).toEqual(
      ["base_url", "last4", "provider"].sort(),
    );
    expect(meta.base_url).toBeNull();
  });
});
