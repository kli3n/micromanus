import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { originOf } from "@/app/api/agent/run/route";

/**
 * REGRESSION: review CR-04.
 *
 * `originOf` picks the origin the deferred-render self-fetch POSTs to, and that
 * POST carries the caller's ENTIRE Cookie header — including the live Supabase
 * session token — plus the full report markdown. The old implementation was:
 *
 *     const host = h.get("x-forwarded-host") ?? h.get("host");
 *     const proto = h.get("x-forwarded-proto") ?? "https";
 *     if (host) return `${proto}://${host}`;
 *
 * i.e. the destination of a credential was read straight out of a
 * client-settable header with no allowlist — textbook host-header injection.
 *
 * The fix must NOT regress Correction C3: the origin still has to come from the
 * incoming request (never VERCEL_URL, never VERCEL_PROJECT_PRODUCTION_URL) or
 * Deployment Protection and preview isolation break. So the request stays the
 * SOURCE; the result just has to be vouched for.
 */

const SELF = "https://micromanus.vercel.app/api/agent/run";

function reqWith(headers: Record<string, string>, url = SELF): Request {
  return new Request(url, { headers });
}

beforeEach(() => {
  // Deterministic: these are the only allowlist inputs from the environment.
  for (const k of [
    "NEXT_PUBLIC_SITE_HOST",
    "VERCEL_BRANCH_URL",
    "VERCEL_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
  ]) {
    vi.stubEnv(k, "");
  }
  // The refusal path logs; keep the suite output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("CR-04: an un-vouched forwarded host never receives the session cookie", () => {
  it("ignores an attacker-supplied x-forwarded-host", () => {
    const o = originOf(reqWith({ "x-forwarded-host": "attacker.example" }));
    expect(o).toBe("https://micromanus.vercel.app");
    expect(o).not.toContain("attacker.example");
  });

  it("ignores an attacker-supplied Host on an attached domain", () => {
    const o = originOf(reqWith({ host: "attacker.example" }));
    expect(o).toBe("https://micromanus.vercel.app");
  });

  it("ignores a look-alike suffix that only LOOKS like a vercel host", () => {
    for (const bad of [
      "vercel.app.attacker.example",
      "notvercel.app",
      "micromanus.vercel.app.attacker.example",
      "attacker.example#micromanus.vercel.app",
      "attacker.example/micromanus.vercel.app",
    ]) {
      expect(originOf(reqWith({ "x-forwarded-host": bad }))).toBe(
        "https://micromanus.vercel.app",
      );
    }
  });

  it("takes only the FIRST value of a comma-joined x-forwarded-host", () => {
    // An attacker appending a value must not be able to win the parse...
    expect(
      originOf(reqWith({ "x-forwarded-host": "micromanus.vercel.app, attacker.example" })),
    ).toBe("https://micromanus.vercel.app");
    // ...nor by prepending one, which now simply fails the allowlist.
    expect(
      originOf(reqWith({ "x-forwarded-host": "attacker.example, micromanus.vercel.app" })),
    ).toBe("https://micromanus.vercel.app");
  });

  it("logs the refusal so a probe is visible server-side", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    originOf(reqWith({ "x-forwarded-host": "attacker.example" }));
    expect(spy).toHaveBeenCalled();
  });

  it("refuses a THIRD-PARTY *.vercel.app deployment — the platform suffix vouches for nothing (WR-03)", () => {
    // Any Vercel customer — including an attacker — can deploy under
    // *.vercel.app. A wildcard on the suffix made millions of third-party
    // deployments valid destinations for the session cookie; only self.host,
    // loopback, and the explicit env allowlist may vouch for a candidate.
    for (const foreign of [
      "attacker-project.vercel.app",
      "evil.vercel.app",
      "micromanus-lookalike.vercel.app",
      "a.b.vercel.app",
      "attacker.vercel.app:443",
    ]) {
      expect(originOf(reqWith({ "x-forwarded-host": foreign })), foreign).toBe(
        "https://micromanus.vercel.app",
      );
    }
  });
});

describe("CR-04: Correction C3 is preserved — the origin still comes from the request", () => {
  it("honours the host the client actually requested on a preview deployment", () => {
    // A preview must render against ITSELF, not production. This is the case the
    // C3 correction exists for, and it must keep working.
    expect(
      originOf(
        reqWith(
          { "x-forwarded-host": "micromanus-git-feat-x.vercel.app" },
          "https://micromanus-git-feat-x.vercel.app/api/agent/run",
        ),
      ),
    ).toBe("https://micromanus-git-feat-x.vercel.app");
  });

  it("does NOT substitute VERCEL_PROJECT_PRODUCTION_URL for a preview host", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "micromanus.vercel.app");
    const o = originOf(
      reqWith(
        { "x-forwarded-host": "micromanus-git-feat-x.vercel.app" },
        "https://micromanus-git-feat-x.vercel.app/api/agent/run",
      ),
    );
    expect(o).toBe("https://micromanus-git-feat-x.vercel.app");
  });

  it("accepts a host that matches the invoked origin exactly", () => {
    expect(
      originOf(reqWith({ "x-forwarded-host": "micromanus.vercel.app" })),
    ).toBe("https://micromanus.vercel.app");
  });

  it("accepts an explicitly configured NEXT_PUBLIC_SITE_HOST", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_HOST", "micromanus.example.com");
    expect(
      originOf(reqWith({ "x-forwarded-host": "micromanus.example.com" })),
    ).toBe("https://micromanus.example.com");
  });

  it("accepts an explicitly configured VERCEL_BRANCH_URL", () => {
    vi.stubEnv("VERCEL_BRANCH_URL", "micromanus-git-main.vercel.app");
    expect(
      originOf(reqWith({ "x-forwarded-host": "micromanus-git-main.vercel.app" })),
    ).toBe("https://micromanus-git-main.vercel.app");
  });
});

describe("CR-04: local dev keeps working", () => {
  it("uses the req.url origin when no forwarding headers are present", () => {
    expect(originOf(reqWith({}, "http://localhost:3000/api/agent/run"))).toBe(
      "http://localhost:3000",
    );
  });

  it("allows plaintext http for a loopback host (vercel dev / next dev)", () => {
    for (const h of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(originOf(reqWith({ host: h }, "http://localhost:3000/api/agent/run"))).toBe(
        `http://${h}`,
      );
    }
  });
});

describe("CR-04: no plaintext downgrade off-box", () => {
  it("forces https for a vouched non-local host even if x-forwarded-proto says http", () => {
    expect(
      originOf(
        reqWith({
          "x-forwarded-host": "micromanus.vercel.app",
          "x-forwarded-proto": "http",
        }),
      ),
    ).toBe("https://micromanus.vercel.app");
  });

  it("never emits a non-http(s) scheme from x-forwarded-proto", () => {
    const o = originOf(
      reqWith({
        "x-forwarded-host": "micromanus.vercel.app",
        "x-forwarded-proto": "javascript",
      }),
    );
    expect(o.startsWith("https://")).toBe(true);
  });
});
