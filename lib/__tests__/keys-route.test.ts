import { describe, expect, it, vi } from "vitest";
import { toKeyMetadata } from "@/lib/keys/metadata";

// The route module is imported below for the WR-07 provider-enum assertions. Its
// only next/** reachable dependency is the server Supabase client, mocked here so
// this file keeps running cleanly under node-env (the render-pdf-contract
// precedent). Hoisted by Vitest — it does not affect the pure-projection tests.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-1" } } }) },
  }),
}));

import { POST, bodySchema } from "@/app/api/keys/route";

/**
 * KEY-03 / T-02key-01 security contract test: the /api/keys responses must NEVER
 * leak ciphertext (iv/ct/tag) or plaintext (apiKey). Every response is routed
 * through the pure `toKeyMetadata` projection, so asserting the projection's
 * output shape is the automated guarantee that no internal field can escape.
 *
 * This test lives under lib/** (the Vitest include glob). It imports the plain
 * projection module plus the route's zod boundary; the route's one next/**
 * dependency (the server Supabase client) is mocked, so the file still runs
 * cleanly under node-env with no next/headers on the graph.
 *
 * WR-07 additions at the bottom: the provider enum no longer accepts the
 * OpenAI-compatible escape hatch, at the validator as well as in the UI.
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

function post(body: unknown): Request {
  return new Request("http://localhost/api/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/keys provider enum (WR-07 — no unreachable provider)", () => {
  it("rejects a provider:'custom' body with status 400", async () => {
    const res = await POST(
      post({
        provider: "custom",
        base_url: "https://api.example.com/v1",
        apiKey: "sk-test",
      }),
    );
    expect(res.status).toBe(400);
  });

  it("does not accept 'custom' at the zod boundary", () => {
    const parsed = bodySchema.safeParse({
      provider: "custom",
      base_url: "https://api.example.com/v1",
      apiKey: "sk-test",
    });
    expect(parsed.success).toBe(false);
  });

  it("still accepts the four offerable providers", () => {
    for (const provider of ["openai", "anthropic", "kimi", "openrouter"]) {
      const parsed = bodySchema.safeParse({
        provider,
        base_url: "https://api.example.com/v1",
        apiKey: "sk-test",
      });
      expect(parsed.success, provider).toBe(true);
    }
  });

  it("keeps the CR-03 base-URL SSRF gate wired after the enum edit", () => {
    for (const base_url of [
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "http://localhost:8080/v1",
    ]) {
      const parsed = bodySchema.safeParse({
        provider: "openai",
        base_url,
        apiKey: "sk-test",
      });
      expect(parsed.success, base_url).toBe(false);
    }
  });
});
