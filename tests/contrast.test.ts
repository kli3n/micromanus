import { describe, expect, it } from "vitest";

/**
 * tests/contrast.test.ts — the phase's WCAG contrast AUTHORITY (SC-5, D-69).
 *
 * This file, not Lighthouse, is where the contrast facts live. Two reasons,
 * both from 04-RESEARCH.md § Pattern 5:
 *   - axe evaluates the RESTING state only, so it cannot see a `:hover` pair
 *     (the 4.36:1 `--accent` on `--surface-3` sidebar hover is invisible to it);
 *   - axe cannot always resolve a computed background over a gradient, and the
 *     app canvas is a radial gradient (`components/AppShell.tsx:333-336`), so
 *     some text on `/app/*` is reported "incomplete" rather than measured.
 *
 * So the ratios are computed here, from the verbatim `:root` values in
 * `app/globals.css:5-46`, and PINNED to 2 decimal places. A token value edit
 * therefore breaks named assertions instead of silently re-deriving.
 *
 * `contrastRatio` and `TOKENS` live INSIDE this test on purpose: nothing in the
 * app consumes them at runtime, and the house rule is to keep a decision where
 * it is pinned rather than to invent a `lib/` module for the test's benefit.
 *
 * What this file does NOT claim: it says nothing about WHICH pairs the markup
 * actually applies. That is `scripts/audit-contrast.ts` (single-element
 * co-occurrence) plus the D-69 manual pass. Later plans change the markup;
 * they must never change the token values, and this test is what enforces that.
 */

// ---------------------------------------------------------------------------
// WCAG 2.x relative luminance + contrast ratio (§1.4.3 formula, verbatim).
// ---------------------------------------------------------------------------

/** sRGB channel (0-255) → linear-light value. */
function channelLuminance(component: number): number {
  const s = component / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance L of a `#RRGGBB` colour. */
function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`relativeLuminance expects #RRGGBB, got ${JSON.stringify(hex)}`);
  }
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/**
 * Contrast ratio between two colours, rounded to 2 dp — the precision the
 * RESEARCH matrix is stated at, and the precision this file pins.
 * Symmetric by construction: the lighter luminance is always the numerator.
 */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const a = relativeLuminance(fgHex);
  const b = relativeLuminance(bgHex);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// The tokens, copied VERBATIM from app/globals.css:5-46.
// Upper-cased for legibility; contrastRatio is case-insensitive on the hex.
// ---------------------------------------------------------------------------

export const TOKENS = {
  // Surfaces & neutrals
  "--bg": "#FBF9F6",
  "--surface": "#FFFFFF",
  "--surface-2": "#F4F1EC",
  "--surface-3": "#EFEBE3",
  "--border": "#E9E4DB",
  "--border-strong": "#DDD6CA",
  "--text": "#211D18",
  "--text-2": "#6C6459",
  "--text-3": "#9C9385",
  // Accent & semantic
  "--accent": "#C2410C",
  "--accent-hover": "#9A3210",
  "--accent-soft": "#FBEAE0",
  "--success": "#3B7A4B",
  "--success-soft": "#E8F1EA",
  "--warning": "#C77D0E",
  "--warning-soft": "#FBF0DC",
  "--error": "#B4302A",
} as const;

type TokenName = keyof typeof TOKENS;

/** Plain white, which is not a token but IS a foreground (button/bubble text). */
const WHITE = "#FFFFFF";

/** WCAG 1.4.3 — normal-size text. */
const AA_TEXT = 4.5;
/** WCAG 1.4.11 — non-text contrast (UI components, graphical objects). */
const AA_NON_TEXT = 3.0;

// ---------------------------------------------------------------------------
// The 8x5 regression matrix — 04-RESEARCH.md § Color math, cell for cell.
// A table literal, so a token edit yields ONE named failing assertion per
// affected cell rather than a wall of anonymous ones.
// ---------------------------------------------------------------------------

const MATRIX_BACKGROUNDS = [
  "--surface",
  "--bg",
  "--surface-2",
  "--surface-3",
  "--warning-soft",
] as const satisfies readonly TokenName[];

/** fg → the five expected ratios, in MATRIX_BACKGROUNDS order. */
export const CONTRAST_MATRIX: Record<string, readonly number[]> = {
  "--text": [16.75, 15.94, 14.87, 14.09, 14.84],
  "--text-2": [5.83, 5.54, 5.17, 4.9, 5.16],
  "--text-3": [3.03, 2.89, 2.69, 2.55, 2.69],
  "--accent": [5.18, 4.93, 4.6, 4.36, 4.59],
  "--accent-hover": [7.4, 7.04, 6.57, 6.22, 6.55],
  "--success": [5.16, 4.91, 4.58, 4.34, 4.57],
  "--warning": [3.3, 3.14, 2.93, 2.77, 2.92],
  "--error": [6.18, 5.88, 5.49, 5.2, 5.48],
};

/** 04-RESEARCH.md § Color math "Additional pairs". */
export const ADDITIONAL_PAIRS: readonly {
  fg: string;
  bg: string;
  ratio: number;
  note: string;
}[] = [
  {
    fg: WHITE,
    bg: TOKENS["--accent"],
    ratio: 5.18,
    note: "white on --accent — the user bubble and every primary button",
  },
  {
    fg: WHITE,
    bg: TOKENS["--accent-hover"],
    ratio: 7.4,
    note: "white on --accent-hover — primary button hover",
  },
  {
    fg: TOKENS["--accent-soft"],
    bg: TOKENS["--surface"],
    ratio: 1.17,
    note:
      "--accent-soft on --surface — the LEGACY focus ring. 1.17:1 was never " +
      "AA-visible at all, which is Amendment A3's whole rationale for moving " +
      "to an --accent outline.",
  },
  {
    fg: TOKENS["--success"],
    bg: TOKENS["--success-soft"],
    ratio: 4.47,
    note:
      "--success on --success-soft — a MARGINAL text fail (4.47 < 4.5). " +
      "See SUCCESS_ON_SUCCESS_SOFT_VERDICT below for what the markup does.",
  },
  {
    fg: TOKENS["--border"],
    bg: TOKENS["--surface"],
    ratio: 1.27,
    note:
      "--border on --surface — WCAG 1.4.11 judgement call, NOT a hard fail: " +
      "controls here also carry fills and labels, and the D-70 ring supplies " +
      "the focus indicator. Neither axe nor Lighthouse tests 1.4.11.",
  },
  {
    fg: TOKENS["--border-strong"],
    bg: TOKENS["--surface"],
    ratio: 1.44,
    note: "--border-strong on --surface — same 1.4.11 note; keep it for load-bearing boundaries",
  },
];

// ---------------------------------------------------------------------------
// The three classes: what is forbidden, what is sanctioned, and the remedies.
// ---------------------------------------------------------------------------

/**
 * OPEN QUESTION 5, RESOLVED BY READING THE SOURCE.
 *
 * `components/Paywall.tsx:129` applies `bg-[var(--success-soft)]` +
 * `border-[var(--success-border)]` to the banner container — so far, non-text.
 * But `components/Paywall.tsx:157-166` renders the banner TITLE as
 * `<strong className="... text-[var(--success)]">` INSIDE that container, at
 * `13.5px` / `font-[650]`. 13.5px bold is not WCAG "large text" (that needs
 * 18.66px bold or 24px), so the 4.5:1 normal-text bar applies and 4.47:1 FAILS.
 *
 * Verdict: this pair DOES carry text. It stays in FORBIDDEN_TEXT_PAIRS.
 * Fixer: plan 04-04 (the paywall is 04-04's tracer surface).
 *
 * Note for whoever runs `scripts/audit-contrast.ts`: that gate looks for both
 * halves on ONE element, and this violation is split across a parent (the bg)
 * and a child (the fg). The gate deliberately does not resolve the cascade, so
 * this specific instance is recorded HERE and fixed by 04-04 — it is not
 * something the co-occurrence scanner can or should find.
 */
export const SUCCESS_ON_SUCCESS_SOFT_VERDICT =
  "carries text: components/Paywall.tsx:157-166 renders the banner title as " +
  "text-[var(--success)] at 13.5px/650 inside the bg-[var(--success-soft)] " +
  "container declared at components/Paywall.tsx:129 — forbidden, fixed_by 04-04";

/** Foreground/background pairs that must NEVER carry normal-size text. */
export const FORBIDDEN_TEXT_PAIRS: readonly {
  fg: TokenName;
  bg: TokenName;
  ratio: number;
  where: string;
  remedy: string;
}[] = [
  {
    fg: "--warning",
    bg: "--warning-soft",
    ratio: 2.92,
    where: "the saturation / rate-limit notice and every warning banner body",
    remedy: "--text-2 on --warning-soft (5.16) — keep the --warning hue for the glyph only",
  },
  {
    fg: "--accent",
    bg: "--surface-3",
    ratio: 4.36,
    where: "the sidebar chat-row hover state",
    remedy: "--accent-hover on --surface-3 (6.22)",
  },
  {
    fg: "--success",
    bg: "--success-soft",
    ratio: 4.47,
    where: `components/Paywall.tsx:129 + :157-166 — ${SUCCESS_ON_SUCCESS_SOFT_VERDICT}`,
    remedy: "--text-2 on --success-soft, or --success as the glyph colour only (fixed_by 04-04)",
  },
];

/** The prescribed remedies. Each must clear the 4.5:1 normal-text bar. */
export const SANCTIONED_TEXT_PAIRS: readonly {
  fg: TokenName;
  bg: TokenName;
  ratio: number;
  why: string;
}[] = [
  {
    fg: "--text-2",
    bg: "--warning-soft",
    ratio: 5.16,
    why: "the remedy for --warning-on-warning-soft words",
  },
  {
    fg: "--accent-hover",
    bg: "--surface-3",
    ratio: 6.22,
    why: "the remedy for the sidebar hover row",
  },
];

/** Pairs that are legal at the 3:1 non-text bar and are used ONLY that way. */
export const SANCTIONED_NON_TEXT_PAIRS: readonly {
  fg: TokenName;
  bg: TokenName;
  ratio: number;
  why: string;
}[] = [
  {
    fg: "--accent",
    bg: "--surface",
    ratio: 5.18,
    why: "the D-70 focus ring on --surface",
  },
  {
    fg: "--accent",
    bg: "--bg",
    ratio: 4.93,
    why: "the D-70 focus ring on the page canvas",
  },
  {
    fg: "--accent",
    bg: "--surface-2",
    ratio: 4.6,
    why: "the D-70 focus ring on --surface-2",
  },
  {
    fg: "--accent",
    bg: "--surface-3",
    ratio: 4.36,
    why: "the D-70 focus ring on --surface-3 — fails as TEXT, safe as a ring",
  },
  {
    fg: "--accent",
    bg: "--warning-soft",
    ratio: 4.59,
    why: "the D-70 focus ring inside a warning banner",
  },
  {
    fg: "--warning",
    bg: "--surface",
    ratio: 3.3,
    why: "the warning GLYPH must sit on the surface, not on --warning-soft (2.92 fails 3:1)",
  },
];

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

describe("contrastRatio — the WCAG 2.x formula itself", () => {
  it("computes the anchor pair white-on---accent at 5.18", () => {
    expect(contrastRatio(TOKENS["--accent"], WHITE)).toBe(5.18);
  });

  it("is symmetric: swapping fg and bg returns the same ratio", () => {
    for (const [fg, expected] of Object.entries(CONTRAST_MATRIX)) {
      MATRIX_BACKGROUNDS.forEach((bg, i) => {
        expect(
          contrastRatio(TOKENS[bg], TOKENS[fg as TokenName]),
          `symmetry ${bg} over ${fg}`,
        ).toBe(expected[i]);
      });
    }
  });

  it("bounds: identical colours are 1.00 and black-on-white is 21.00", () => {
    expect(contrastRatio(WHITE, WHITE)).toBe(1);
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21);
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
  });

  it("rejects anything that is not a #RRGGBB literal", () => {
    expect(() => contrastRatio("#FFF", WHITE)).toThrow(/#RRGGBB/);
    expect(() => contrastRatio("var(--accent)", WHITE)).toThrow(/#RRGGBB/);
  });
});

describe("the 04-RESEARCH § Color math matrix — 40 pinned cells", () => {
  for (const [fg, expected] of Object.entries(CONTRAST_MATRIX)) {
    it(`${fg} reproduces all five background ratios`, () => {
      expect(expected, `${fg} row width`).toHaveLength(MATRIX_BACKGROUNDS.length);
      MATRIX_BACKGROUNDS.forEach((bg, i) => {
        expect(
          contrastRatio(TOKENS[fg as TokenName], TOKENS[bg]),
          `${fg} (${TOKENS[fg as TokenName]}) on ${bg} (${TOKENS[bg]})`,
        ).toBe(expected[i]);
      });
    });
  }

  it("covers exactly 8 foregrounds x 5 backgrounds = 40 cells", () => {
    const cells = Object.keys(CONTRAST_MATRIX).length * MATRIX_BACKGROUNDS.length;
    expect(cells).toBe(40);
  });
});

describe("additional pairs", () => {
  for (const p of ADDITIONAL_PAIRS) {
    it(`${p.note.split(" — ")[0]} measures ${p.ratio}`, () => {
      expect(contrastRatio(p.fg, p.bg), p.note).toBe(p.ratio);
    });
  }
});

describe("FORBIDDEN_TEXT_PAIRS — below the 4.5:1 normal-text bar", () => {
  it("names exactly the three failures the UI-SPEC does not", () => {
    expect(FORBIDDEN_TEXT_PAIRS.map((p) => `${p.fg} on ${p.bg}`)).toEqual([
      "--warning on --warning-soft",
      "--accent on --surface-3",
      "--success on --success-soft",
    ]);
  });

  for (const p of FORBIDDEN_TEXT_PAIRS) {
    it(`${p.fg} on ${p.bg} is ${p.ratio} and fails AA text`, () => {
      const measured = contrastRatio(TOKENS[p.fg], TOKENS[p.bg]);
      expect(measured, `${p.fg} on ${p.bg} (${p.where})`).toBe(p.ratio);
      expect(measured, `${p.fg} on ${p.bg} must stay BELOW ${AA_TEXT}`).toBeLessThan(AA_TEXT);
    });
  }

  it("records the --success/--success-soft text-vs-border verdict with its source line", () => {
    expect(SUCCESS_ON_SUCCESS_SOFT_VERDICT).toMatch(/components\/Paywall\.tsx:157-166/);
    expect(SUCCESS_ON_SUCCESS_SOFT_VERDICT).toMatch(/carries text/);
    expect(SUCCESS_ON_SUCCESS_SOFT_VERDICT).toMatch(/04-04/);
  });
});

describe("SANCTIONED_TEXT_PAIRS — the two prescribed remedies clear AA", () => {
  for (const p of SANCTIONED_TEXT_PAIRS) {
    it(`${p.fg} on ${p.bg} is ${p.ratio} and passes AA text`, () => {
      const measured = contrastRatio(TOKENS[p.fg], TOKENS[p.bg]);
      expect(measured, `${p.fg} on ${p.bg} (${p.why})`).toBe(p.ratio);
      expect(measured).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }
});

describe("SANCTIONED_NON_TEXT_PAIRS — clear the 3:1 bar (WCAG 1.4.11)", () => {
  for (const p of SANCTIONED_NON_TEXT_PAIRS) {
    it(`${p.fg} on ${p.bg} is ${p.ratio} and passes non-text`, () => {
      const measured = contrastRatio(TOKENS[p.fg], TOKENS[p.bg]);
      expect(measured, `${p.fg} on ${p.bg} (${p.why})`).toBe(p.ratio);
      expect(measured).toBeGreaterThanOrEqual(AA_NON_TEXT);
    });
  }
});

describe("coverage — how many contrast facts this file pins", () => {
  it("pins at least 55 distinct fg/bg ratios", () => {
    const pinned =
      Object.keys(CONTRAST_MATRIX).length * MATRIX_BACKGROUNDS.length +
      ADDITIONAL_PAIRS.length +
      FORBIDDEN_TEXT_PAIRS.length +
      SANCTIONED_TEXT_PAIRS.length +
      SANCTIONED_NON_TEXT_PAIRS.length;
    // 40 matrix cells + 6 additional + 3 forbidden + 2 remedies + 6 non-text = 57.
    expect(pinned, "distinct pinned fg/bg ratios").toBe(57);
    expect(pinned).toBeGreaterThanOrEqual(55);
  });
});

describe("the five RESEARCH § Color math conclusions, as assertions", () => {
  it("1. the D-70 focus ring clears 3:1 on EVERY warm surface (4.36 … 5.18)", () => {
    const ring = MATRIX_BACKGROUNDS.map((bg) => contrastRatio(TOKENS["--accent"], TOKENS[bg]));
    for (const r of ring) expect(r).toBeGreaterThanOrEqual(AA_NON_TEXT);
    expect(Math.min(...ring)).toBe(4.36);
    expect(Math.max(...ring)).toBe(5.18);
  });

  it("2. --accent as TEXT is not universally safe: it fails on --surface-3", () => {
    expect(contrastRatio(TOKENS["--accent"], TOKENS["--surface-3"])).toBeLessThan(AA_TEXT);
    expect(contrastRatio(TOKENS["--accent-hover"], TOKENS["--surface-3"])).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });

  it("3. --text-2 clears 4.5:1 on all five surfaces (4.90 … 5.83) — no per-surface exception", () => {
    const row = MATRIX_BACKGROUNDS.map((bg) => contrastRatio(TOKENS["--text-2"], TOKENS[bg]));
    for (const r of row) expect(r).toBeGreaterThanOrEqual(AA_TEXT);
    expect(Math.min(...row)).toBe(4.9);
    expect(Math.max(...row)).toBe(5.83);
  });

  it("3b. --text-3 fails 4.5:1 on all five surfaces (2.55 … 3.03) — decorative only", () => {
    const row = MATRIX_BACKGROUNDS.map((bg) => contrastRatio(TOKENS["--text-3"], TOKENS[bg]));
    for (const r of row) expect(r).toBeLessThan(AA_TEXT);
    expect(Math.min(...row)).toBe(2.55);
    expect(Math.max(...row)).toBe(3.03);
  });

  it("4. --warning is the worst offender: it fails as text on all five surfaces", () => {
    const row = MATRIX_BACKGROUNDS.map((bg) => contrastRatio(TOKENS["--warning"], TOKENS[bg]));
    for (const r of row) expect(r).toBeLessThan(AA_TEXT);
    // The glyph is only safe against the surface, never against its own soft fill.
    expect(contrastRatio(TOKENS["--warning"], TOKENS["--surface"])).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
    expect(contrastRatio(TOKENS["--warning"], TOKENS["--warning-soft"])).toBeLessThan(AA_NON_TEXT);
  });

  it("5. border contrast is a 1.4.11 judgement call, not a hard fail", () => {
    expect(contrastRatio(TOKENS["--border"], TOKENS["--surface"])).toBe(1.27);
    expect(contrastRatio(TOKENS["--border-strong"], TOKENS["--surface"])).toBe(1.44);
  });
});
