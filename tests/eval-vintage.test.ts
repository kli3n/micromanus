import { describe, expect, it } from "vitest";
import {
  isPreNumberingVintage,
  vintageVerdict,
  PRE_NUMBERING_VINTAGE_FLAG_REASON,
  PRE_NUMBERING_VINTAGE_SKIP_REASON,
  type RunVintageInput,
} from "@/lib/eval/vintage";

/**
 * tests/eval-vintage.test.ts — the vintage predicate that lets `eval:offline`
 * SKIP (rather than FAIL-critical) a run written before 03-04 minted citation
 * numbers server-side and 03-07 persisted page extractions.
 *
 * MOST of these tests pin the SAFE direction: a run carrying ANY 03-04/03-07
 * marker must never be skippable. That direction is the whole risk surface —
 * a predicate satisfiable by a current run would silently disarm a Critical
 * gate, which is strictly worse than the red herring being removed
 * (threat T-03-11-01, and its GW-05 sharpening: threat T-03-16-01).
 *
 * The joint-absence case below is the one GW-05 found missing: a CURRENT run
 * whose meter-carrier insert was swallowed AND whose every fetch threw hits
 * `hasMeterCarrier=false, registrySize=0, toolRowCount>=1` — the exact shape
 * the pre-GW-05 three-conjunct predicate skipped. The fourth conjunct
 * (`hasPostNumberingPayload`) and the FLAG verdict close it from both sides.
 */

/** The 2026-07-27 row's exact signature: no meter carrier, no registry, tools ran. */
const STALE_VINTAGE: RunVintageInput = {
  hasMeterCarrier: false,
  registrySize: 0,
  toolRowCount: 4,
  hasPostNumberingPayload: false,
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
        hasPostNumberingPayload: false,
      }),
    ).toBe(false);
  });

  it("never skips a run with a NON-EMPTY registry, even with no meter carrier (a current run whose meter insert failed must still be audited)", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: false,
        registrySize: 6,
        toolRowCount: 9,
        hasPostNumberingPayload: false,
      }),
    ).toBe(false);
  });

  it("never skips the ordinary current-run case — meter carrier present AND registry size 6 (the EC-04 phantom-[7] shape, which must keep FAILing EV-01)", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: true,
        registrySize: 6,
        toolRowCount: 9,
        hasPostNumberingPayload: false,
      }),
    ).toBe(false);
  });

  it("never skips a run with ZERO tool rows — that is a plain answer, not an old vintage, and skipping it would hide a real numbering break", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: false,
        registrySize: 0,
        toolRowCount: 0,
        hasPostNumberingPayload: false,
      }),
    ).toBe(false);
  });

  it("never skips the JOINT-ABSENCE-on-a-current-run shape — no meter carrier, empty registry, tool rows ran, but a post-03-04 payload key IS present (GW-05: the case the suite was missing)", () => {
    expect(
      isPreNumberingVintage({
        hasMeterCarrier: false,
        registrySize: 0,
        toolRowCount: 3,
        hasPostNumberingPayload: true,
      }),
    ).toBe(false);
  });

  it("never skips when hasPostNumberingPayload is not a clean boolean false — a malformed input falls to 'audit this run', like every other conjunct", () => {
    expect(
      isPreNumberingVintage({
        ...STALE_VINTAGE,
        hasPostNumberingPayload: undefined as unknown as boolean,
      }),
    ).toBe(false);
  });
});

describe("vintageVerdict — a Critical check never vanishes on a citation-bearing answer", () => {
  it("returns AUDIT whenever the run is not a pre-numbering vintage, whatever the answer cites", () => {
    const current: RunVintageInput = {
      hasMeterCarrier: true,
      registrySize: 6,
      toolRowCount: 9,
      hasPostNumberingPayload: true,
    };
    expect(vintageVerdict(current, { answerHasCitations: true })).toBe("AUDIT");
    expect(vintageVerdict(current, { answerHasCitations: false })).toBe("AUDIT");
  });

  it("returns FLAG on a vintage run whose answer DOES carry citations — the numbers are printed with their reason rather than dropped", () => {
    expect(vintageVerdict(STALE_VINTAGE, { answerHasCitations: true })).toBe("FLAG");
  });

  it("returns SKIP on a vintage run whose answer carries NO citations — there is genuinely nothing to resolve", () => {
    expect(vintageVerdict(STALE_VINTAGE, { answerHasCitations: false })).toBe("SKIP");
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

describe("PRE_NUMBERING_VINTAGE_FLAG_REASON", () => {
  it("is a non-empty string that names the vintage and 03-04, so a reader knows the printed numbers came from a pre-03-04 row rather than a current regression", () => {
    expect(typeof PRE_NUMBERING_VINTAGE_FLAG_REASON).toBe("string");
    expect(PRE_NUMBERING_VINTAGE_FLAG_REASON.trim().length).toBeGreaterThan(0);
    expect(PRE_NUMBERING_VINTAGE_FLAG_REASON).toMatch(/vintage/i);
    expect(PRE_NUMBERING_VINTAGE_FLAG_REASON).toMatch(/03-04/);
  });
});

describe("scripts/eval-run.ts consumes the SHARED predicate (no duplicated copy)", () => {
  it("imports isPreNumberingVintage from lib/eval/vintage.ts by relative .ts path and never redeclares it inline", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../scripts/eval-run.ts", import.meta.url),
      "utf8",
    );
    // The shared-module route was taken (the relative .ts specifier resolves
    // under node type-stripping). If a future edit ever falls back to the
    // documented-duplication route used for lib/pricing.ts, this assertion is
    // the place to add the parity test the IN-05 remedy calls for.
    expect(src).toMatch(
      /import\s*\{[^}]*isPreNumberingVintage[^}]*\}\s*from\s*"\.\.\/lib\/eval\/vintage\.ts"/s,
    );
    expect(src).toMatch(/PRE_NUMBERING_VINTAGE_SKIP_REASON/);
    // No inline redeclaration — one implementation, one tested source of truth.
    expect(src).not.toMatch(/function\s+isPreNumberingVintage/);
    // The gate must never key on the condition EV-01 audits.
    expect(src).toMatch(/isPreNumberingVintage\(\{/);
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
