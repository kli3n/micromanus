import { describe, expect, it } from "vitest";
import {
  isPreNumberingVintage,
  PRE_NUMBERING_VINTAGE_SKIP_REASON,
  type RunVintageInput,
} from "@/lib/eval/vintage";

/**
 * tests/eval-vintage.test.ts — the vintage predicate that lets `eval:offline`
 * SKIP (rather than FAIL-critical) a run written before 03-04 minted citation
 * numbers server-side and 03-07 persisted page extractions.
 *
 * FOUR of these six tests pin the SAFE direction: a run carrying EITHER 03-04
 * marker must never be skippable. That direction is the whole risk surface —
 * a predicate satisfiable by a current run would silently disarm a Critical
 * gate, which is strictly worse than the red herring being removed
 * (threat T-03-11-01).
 */

/** The 2026-07-27 row's exact signature: no meter carrier, no registry, tools ran. */
const STALE_VINTAGE: RunVintageInput = {
  hasMeterCarrier: false,
  registrySize: 0,
  toolRowCount: 4,
};

describe("isPreNumberingVintage — skippable direction (exactly one shape)", () => {
  it("skips a run with NO meter carrier, an EMPTY registry, and at least one tool row (the 2026-07-27 signature)", () => {
    expect(isPreNumberingVintage(STALE_VINTAGE)).toBe(true);
  });
});

describe("isPreNumberingVintage — NOT-skippable direction (the safe direction)", () => {
  it("never skips a run whose meter carrier IS present, even at registry size 0 (a current run that fetched nothing must still be audited)", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: true,
        registrySize: 0,
        toolRowCount: 4,
      }),
    ).toBe(false);
  });

  it("never skips a run with a NON-EMPTY registry, even with no meter carrier (a current run whose meter insert failed must still be audited)", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: false,
        registrySize: 6,
        toolRowCount: 9,
      }),
    ).toBe(false);
  });

  it("never skips the ordinary current-run case — meter carrier present AND registry size 6 (the EC-04 phantom-[7] shape, which must keep FAILing EV-01)", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: true,
        registrySize: 6,
        toolRowCount: 9,
      }),
    ).toBe(false);
  });

  it("never skips a run with ZERO tool rows — that is a plain answer, not an old vintage, and skipping it would hide a real numbering break", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: false,
        registrySize: 0,
        toolRowCount: 0,
      }),
    ).toBe(false);
  });
});

describe("PRE_NUMBERING_VINTAGE_SKIP_REASON", () => {
  it("is a non-empty string that names the vintage and what is missing, so the printed line explains itself", () => {
    expect(typeof PRE_NUMBERING_VINTAGE_SKIP_REASON).toBe("string");
    expect(PRE_NUMBERING_VINTAGE_SKIP_REASON.trim().length).toBeGreaterThan(0);
    expect(PRE_NUMBERING_VINTAGE_SKIP_REASON).toMatch(/vintage/i);
    expect(PRE_NUMBERING_VINTAGE_SKIP_REASON).toMatch(/03-04/);
    expect(PRE_NUMBERING_VINTAGE_SKIP_REASON).toMatch(/meter/i);
  });
});

describe("lib/eval/vintage.ts loadability contract (node type-stripping)", () => {
  it("has zero import statements and no non-erasable TypeScript syntax", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../lib/eval/vintage.ts", import.meta.url),
      "utf8",
    );
    // Zero imports — the module must load under node --experimental-strip-types
    // from scripts/eval-run.ts, which cannot resolve the "@/" alias graph.
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
    // Erasable syntax only: no enums, no namespaces, no parameter properties.
    expect(src).not.toMatch(/\benum\s/);
    expect(src).not.toMatch(/\bnamespace\s/);
    expect(src).not.toMatch(/constructor\s*\([^)]*\b(private|public|readonly)\b/);
  });
});
