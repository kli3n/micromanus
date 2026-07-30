import { describe, expect, it } from "vitest";
import { z } from "zod";
import { baseUrlSchema, isAllowedBaseUrl, BASE_URL_REJECTED } from "@/lib/keys/base-url";
import { DEFAULT_BASE_URLS } from "@/lib/registry";

/**
 * REGRESSION: review CR-03.
 *
 * /api/keys and /api/keys/test validated the user-supplied provider base URL
 * with a bare `z.url()`, and the probe route's header asserted "base_url
 * constrained to http(s) by zod url() (SSRF guard)". The guard did not exist.
 *
 * The first block pins the actual behaviour of the pinned zod@4.4.3 so nobody
 * re-derives that false claim; the rest pins the real gate. These routes are the
 * privileged ones — they carry the DECRYPTED BYOK key — so an SSRF here is worse
 * than one in fetch_page.
 */

describe("CR-03: the premise — bare z.url() is NOT a scheme/host gate", () => {
  const bare = z.url();

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://x.io/",
    "http://localhost:8080/v1",
  ])("z.url() accepts %s (which is why baseUrlSchema exists)", (u) => {
    expect(bare.safeParse(u).success).toBe(true);
  });
});

describe("CR-03: baseUrlSchema rejects non-http(s) schemes", () => {
  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://x.io/",
    "data:text/plain,hi",
    "gopher://x.io/",
  ])("rejects %s", (u) => {
    const r = baseUrlSchema.safeParse(u);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe(BASE_URL_REJECTED);
  });
});

describe("CR-03: baseUrlSchema rejects private / loopback / metadata hosts", () => {
  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:8080/v1",
    "http://127.0.0.1:11434/v1",
    "http://localhost:54321/rest/v1/",
    "http://10.0.0.5/v1",
    "http://172.16.4.4/v1",
    "http://192.168.1.9/v1",
    "http://0.0.0.0/v1",
    "http://[::1]:8080/v1",
    // the CR-02 hex spellings must be closed here too, since the gate is shared
    "http://[::ffff:7f00:1]/v1",
    "http://[::ffff:127.0.0.1]/v1",
    "http://[::127.0.0.1]/v1",
    "http://[febf::1]/v1",
    "http://[fd00::1]/v1",
    // IPv4 shorthands the URL parser folds to loopback
    "http://2130706433/v1",
    "http://127.1/v1",
  ])("rejects %s", (u) => {
    expect(baseUrlSchema.safeParse(u).success).toBe(false);
  });
});

describe("CR-03: baseUrlSchema still accepts every real provider base URL", () => {
  it.each([
    "https://api.openai.com/v1",
    "https://api.moonshot.ai/v1",
    "https://api.anthropic.com",
    "https://openrouter.ai/api/v1",
    "https://my-proxy.example.com/v1",
  ])("accepts %s", (u) => {
    expect(baseUrlSchema.safeParse(u).success).toBe(true);
  });

  // Registry-driven so adding a provider cannot be silently blocked by the gate.
  it("accepts every non-empty DEFAULT_BASE_URLS entry in the registry", () => {
    for (const [provider, url] of Object.entries(DEFAULT_BASE_URLS)) {
      if (url.length === 0) continue; // `custom` has no default; UI requires one
      expect(baseUrlSchema.safeParse(url).success, `${provider} -> ${url}`).toBe(true);
    }
  });

  it("trims surrounding whitespace rather than rejecting a pasted value", () => {
    const r = baseUrlSchema.safeParse("  https://api.openai.com/v1  ");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe("https://api.openai.com/v1");
  });

  it("rejects an empty base URL (the field is required, as before)", () => {
    expect(baseUrlSchema.safeParse("").success).toBe(false);
    expect(baseUrlSchema.safeParse("   ").success).toBe(false);
  });
});

describe("CR-03: isAllowedBaseUrl re-gates rows read back out of the DB", () => {
  it("allows null/empty — the run handler falls back to the provider default", () => {
    expect(isAllowedBaseUrl(null)).toBe(true);
    expect(isAllowedBaseUrl(undefined)).toBe(true);
    expect(isAllowedBaseUrl("")).toBe(true);
  });

  it("refuses a row saved before the gate existed", () => {
    expect(isAllowedBaseUrl("http://169.254.169.254/v1")).toBe(false);
    expect(isAllowedBaseUrl("http://localhost:8080/v1")).toBe(false);
    expect(isAllowedBaseUrl("file:///etc/passwd")).toBe(false);
  });

  it("allows a legitimate stored base URL", () => {
    expect(isAllowedBaseUrl("https://api.openai.com/v1")).toBe(true);
  });
});
