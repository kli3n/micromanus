import { describe, expect, it } from "vitest";
import { filterForwardedCookies } from "@/lib/net/forward-cookie";

/**
 * REGRESSION: 03-REVIEW-FIX.md residual #2.
 *
 * The deferred-render self-fetch POSTs the FULL report markdown to
 * /api/render-pdf and used to carry the caller's ENTIRE `Cookie` header with it.
 * CR-04 already closed WHERE that credential can go (the origin allowlist); this
 * closes WHAT rides along.
 *
 * The narrowing was previously DECLINED because an allowlist here is a plausible
 * way to break authenticated PDF rendering in production: the header carries
 * both Vercel Deployment Protection's `_vercel_jwt` and Supabase's CHUNKED
 * `sb-*-auth-token.N` cookies. A prefix filter that keeps `_vercel_jwt` and
 * everything beginning `sb-` is superset-preserving for both mechanisms BY
 * CONSTRUCTION — it can only drop cookies neither one uses. These tests pin that
 * property from both directions: the two families survive byte-for-byte, and a
 * lookalike name cannot ride along on a substring match.
 */

describe("filterForwardedCookies — the two families the render route needs survive", () => {
  it("keeps a CHUNKED sb-*-auth-token pair and _vercel_jwt intact, in order, byte-unchanged", () => {
    const chunk0 =
      "base64-eyJhY2Nlc3NfdG9rZW4iOiJleUpoYkdjaU9pSklVekkxTmlJc0luUjVjQ0k2SWtwWFZDSjku";
    const chunk1 = "cGFydC10d28tb2YtdGhlLXNwbGl0LXNlc3Npb24tcGF5bG9hZA==";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2ZXJjZWwifQ.sIgNaTuRe-_x";
    const header = [
      `sb-abc-auth-token.0=${chunk0}`,
      `sb-abc-auth-token.1=${chunk1}`,
      `_vercel_jwt=${jwt}`,
    ].join("; ");

    const out = filterForwardedCookies(header);

    // Order preserved, values byte-for-byte, nothing re-encoded.
    expect(out).toBe(header);
    expect(out).toContain(`sb-abc-auth-token.0=${chunk0}`);
    expect(out).toContain(`sb-abc-auth-token.1=${chunk1}`);
    expect(out).toContain(`_vercel_jwt=${jwt}`);
    // Both chunks are present — dropping either breaks the session read (D-40).
    expect(out.split("; ").filter((p) => p.startsWith("sb-"))).toHaveLength(2);
  });

  it("keeps every sb- prefixed cookie, including non-auth ones, and preserves their relative order", () => {
    const header = "sb-abc-auth-token=one; sb-provider-token=two; sb-refresh=three";
    expect(filterForwardedCookies(header)).toBe(header);
  });

  it("keeps the two families and drops everything else from a realistic mixed header", () => {
    const header = [
      "_ga=GA1.1.1234567890.1699999999",
      "sb-abc-auth-token.0=chunk-zero",
      "ajs_anonymous_id=aaaa-bbbb",
      "_vercel_jwt=vjwt-value",
      "sb-abc-auth-token.1=chunk-one",
      "intercom-session-xyz=nope",
    ].join("; ");

    expect(filterForwardedCookies(header)).toBe(
      "sb-abc-auth-token.0=chunk-zero; _vercel_jwt=vjwt-value; sb-abc-auth-token.1=chunk-one",
    );
  });
});

describe("filterForwardedCookies — everything else is dropped", () => {
  it("drops unrelated first- and third-party cookies", () => {
    for (const c of [
      "foo=bar",
      "_ga=GA1.1.1",
      "ajs_user_id=42",
      "csrftoken=abc",
      "session=whatever",
    ]) {
      expect(filterForwardedCookies(c)).toBe("");
    }
  });

  it("drops a name that merely CONTAINS sb- but does not start with it (prefix, not substring)", () => {
    for (const c of [
      "not-sb-auth-token=x",
      "xsb-abc-auth-token=x",
      "my_sb-token=x",
      "asb-=x",
      "tracker-sb-auth-token.0=x",
    ]) {
      expect(filterForwardedCookies(c), `must drop ${c}`).toBe("");
    }
  });

  it("matches _vercel_jwt by EXACT name, so a lookalike is dropped", () => {
    for (const c of [
      "_vercel_jwt_shadow=x",
      "x_vercel_jwt=x",
      "_vercel_jwtx=x",
      "vercel_jwt=x",
    ]) {
      expect(filterForwardedCookies(c), `must drop ${c}`).toBe("");
    }
    expect(filterForwardedCookies("_vercel_jwt=keep")).toBe("_vercel_jwt=keep");
  });
});

describe("filterForwardedCookies — parsing is total and never throws", () => {
  it("returns an empty string for a null, undefined or empty header", () => {
    expect(filterForwardedCookies(null)).toBe("");
    expect(filterForwardedCookies(undefined)).toBe("");
    expect(filterForwardedCookies("")).toBe("");
    expect(filterForwardedCookies("   ")).toBe("");
    expect(filterForwardedCookies(";;; ; ")).toBe("");
  });

  it("tolerates whitespace around pairs and reassembles a valid '; '-joined header", () => {
    const out = filterForwardedCookies(
      "  sb-abc-auth-token.0=zero ;   _vercel_jwt=vv  ;  _ga=drop  ",
    );
    expect(out).toBe("sb-abc-auth-token.0=zero; _vercel_jwt=vv");
    // No leading/trailing separator, and exactly one "; " between pairs.
    expect(out.startsWith(";")).toBe(false);
    expect(out.endsWith(";")).toBe(false);
    expect(out).not.toContain(";;");
    expect(out).not.toContain(" ;");
  });

  it("ignores a malformed segment with no '=' at all", () => {
    expect(filterForwardedCookies("sb-abc-auth-token.0=zero; garbage; _ga=x")).toBe(
      "sb-abc-auth-token.0=zero",
    );
  });
});

describe("filterForwardedCookies — values are preserved whole", () => {
  it("keeps a value containing '=' intact (only the FIRST '=' separates name from value)", () => {
    // Base64 padding and `base64-`-prefixed Supabase chunks both contain '='.
    const value = "base64-eyJhIjoiYiJ9==";
    const out = filterForwardedCookies(`sb-abc-auth-token.0=${value}; _ga=x`);
    expect(out).toBe(`sb-abc-auth-token.0=${value}`);
    expect(out.slice("sb-abc-auth-token.0=".length)).toBe(value);
  });

  it("keeps an empty value without mangling the pair", () => {
    expect(filterForwardedCookies("sb-abc-auth-token.0=; _ga=x")).toBe(
      "sb-abc-auth-token.0=",
    );
  });
});
