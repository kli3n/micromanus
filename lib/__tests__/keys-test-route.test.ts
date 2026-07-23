import { describe, expect, it } from "vitest";
import { probeErrorCopy, isTestableProvider } from "@/lib/keys/probe";

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

describe("isTestableProvider (OQ-1)", () => {
  it("is true for openai, kimi, custom", () => {
    expect(isTestableProvider("openai")).toBe(true);
    expect(isTestableProvider("kimi")).toBe(true);
    expect(isTestableProvider("custom")).toBe(true);
  });

  it("is false for anthropic (Claude non-runnable this phase)", () => {
    expect(isTestableProvider("anthropic")).toBe(false);
  });
});
