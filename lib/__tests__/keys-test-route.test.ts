import { describe, expect, it, vi } from "vitest";
import { probeErrorCopy, isTestableProvider } from "@/lib/keys/probe";

// The route module is imported below for the WR-07 provider-enum assertions. Its
// only next/** reachable dependency is the server Supabase client, mocked here so
// this file keeps running cleanly under node-env (the render-pdf-contract
// precedent). Hoisted by Vitest — it does not affect the pure-helper tests, and
// every assertion below returns BEFORE the lazily-imported provider SDKs, so no
// outbound probe is ever dialled.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-1" } } }) },
  }),
}));

import { POST, bodySchema } from "@/app/api/keys/test/route";

/**
 * KEY-02 / UX-01 / T-02key-02: the test-probe never echoes a raw provider error
 * body. Failure copy is drawn from a small fixed set keyed on the numeric status.
 * These pure helpers are the automated guarantee; they import no next/react/SDK,
 * so this node-env test loads neither next/headers nor the openai SDK.
 */

// A sentinel that would only appear if raw provider detail leaked into the copy.
const RAW_BODY_MARKER = "sk-leaked-provider-body-0xDEADBEEF";

describe("probeErrorCopy (UX-01 fixed failure copy)", () => {
  it("maps 401 to a fixed 'key rejected' message", () => {
    const copy = probeErrorCopy(401);
    expect(copy.toLowerCase()).toContain("rejected");
  });

  it("maps 429 to a fixed 'rate limited' message", () => {
    const copy = probeErrorCopy(429);
    expect(copy.toLowerCase()).toContain("rate");
  });

  it("maps 500 / unknown to a fixed generic 'could not verify' message", () => {
    expect(probeErrorCopy(500).toLowerCase()).toContain("verify");
    expect(probeErrorCopy(0).toLowerCase()).toContain("verify");
    expect(probeErrorCopy(418).toLowerCase()).toContain("verify");
  });

  it("never contains an injected raw provider-body marker", () => {
    for (const status of [401, 429, 500, 0, 403, 502]) {
      expect(probeErrorCopy(status)).not.toContain(RAW_BODY_MARKER);
    }
  });

  it("draws every output from a small fixed set (no interpolation)", () => {
    const outputs = new Set(
      [401, 429, 500, 0, 403, 418, 502, 503].map((s) => probeErrorCopy(s)),
    );
    // 401, 429, and everything-else => at most three distinct strings.
    expect(outputs.size).toBeLessThanOrEqual(3);
  });
});

describe("isTestableProvider (OQ-1 resolved — D-48)", () => {
  // NOTE (WR-07): this stays TRUE on purpose and must not be inverted. It tests
  // lib/keys/probe.ts, whose isTestableProvider returns true unconditionally as a
  // deliberate seam for future non-probeable providers — a question about PROBE
  // CAPABILITY, not about which providers the request schema accepts. The schema
  // answer is the separate describe block below.
  it("is true for openai, kimi, custom", () => {
    expect(isTestableProvider("openai")).toBe(true);
    expect(isTestableProvider("kimi")).toBe(true);
    expect(isTestableProvider("custom")).toBe(true);
  });

  it("is true for anthropic (Claude probed via the native Messages API since Phase 3)", () => {
    expect(isTestableProvider("anthropic")).toBe(true);
  });
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/keys/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/keys/test provider enum (WR-07 — no unreachable provider)", () => {
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

  it("still accepts the four probeable providers", () => {
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
