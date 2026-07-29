import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as promptModule from "@/lib/agent/prompt";
import { DEEP_RESEARCH_SYSTEM } from "@/lib/agent/prompt";

/**
 * Pinned content hash (D-49). The system prompt is cache breakpoint 1: a single
 * changed byte silently invalidates prompt caching with no error and no symptom
 * other than cache_read = 0 forever. ANY edit to DEEP_RESEARCH_SYSTEM must be a
 * deliberate, reviewed diff that also updates this literal.
 */
const PINNED_SHA256 =
  "0000000000000000000000000000000000000000000000000000000000000000";

describe("DEEP_RESEARCH_SYSTEM (D-49 byte-stable cached prefix)", () => {
  it("(a) sha256 of the prompt equals the pinned hex literal — edits must be deliberate", () => {
    const hash = createHash("sha256")
      .update(DEEP_RESEARCH_SYSTEM, "utf8")
      .digest("hex");
    expect(hash).toBe(PINNED_SHA256);
  });

  it("(b) clears the cache-minimum proxy: length >= 4000 chars (Assumption A4 / C1)", () => {
    expect(DEEP_RESEARCH_SYSTEM.length).toBeGreaterThanOrEqual(4000);
  });

  it("(c) contains no year-like or slash-date-like substring — the single most common cache killer", () => {
    expect(DEEP_RESEARCH_SYSTEM).not.toMatch(/(19|20)\d{2}/);
    expect(DEEP_RESEARCH_SYSTEM).not.toMatch(/\d{1,2}\/\d{1,2}\//);
  });

  it("(d) the module exports exactly one binding and it is a string", () => {
    expect(Object.keys(promptModule)).toEqual(["DEEP_RESEARCH_SYSTEM"]);
    expect(typeof DEEP_RESEARCH_SYSTEM).toBe("string");
  });
});
