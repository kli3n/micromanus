import { describe, expect, it } from "vitest";
import { parseEnv } from "../env";

describe("env schema", () => {
  it("throws when NEXT_PUBLIC_SUPABASE_URL is absent (fail-fast)", () => {
    expect(() =>
      parseEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key" }),
    ).toThrow();
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is not a valid URL", () => {
    expect(() =>
      parseEnv({
        NEXT_PUBLIC_SUPABASE_URL: "not-a-url",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      }),
    ).toThrow();
  });

  it("throws when NEXT_PUBLIC_SUPABASE_ANON_KEY is empty", () => {
    expect(() =>
      parseEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      }),
    ).toThrow();
  });

  it("parses when both public vars are set (happy path)", () => {
    const env = parseEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    });
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe("https://example.supabase.co");
    expect(env.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe("anon-key");
    // Server-only vars are optional in Phase 1.
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });

  it("keeps optional server-only vars when provided", () => {
    const env = parseEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    });
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe("service-role");
    expect(env.ENCRYPTION_KEY).toBe("0123456789abcdef0123456789abcdef");
  });
});
