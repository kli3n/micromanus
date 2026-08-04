/**
 * scripts/audit-contrast.ts — the SC-5 forbidden-pair co-occurrence gate (plan 04-02).
 *
 * `tests/contrast.test.ts` pins WHAT the ratios are. This script asks the only
 * other question that can be answered from source alone: does any single element
 * apply BOTH halves of a pair that measures below the 4.5:1 normal-text bar?
 *
 * The three pairs, computed in 04-RESEARCH.md § Color math and pinned in
 * tests/contrast.test.ts:
 *   --warning  on --warning-soft  → 2.92
 *   --accent   on --surface-3     → 4.36
 *   --success  on --success-soft  → 4.47
 *
 * It scans every .tsx file under app/ and components/, splits each file into JSX
 * opening-tag attribute spans, and looks for a foreground application
 * (`text-[var(--X)]`, or an inline `color: …var(--X)`) together with a background
 * application (`bg-[var(--Y)]`, or an inline `background`/`backgroundColor`) on
 * the SAME span.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO, so nobody over-builds it:
 *   - It does not resolve the CSS cascade. A violation split across a parent
 *     (the background) and a child (the text colour) is invisible here. The
 *     paywall's --success/--success-soft banner is exactly that shape and is
 *     recorded in tests/contrast.test.ts instead (SUCCESS_ON_SUCCESS_SOFT_VERDICT).
 *   - It does not evaluate `:hover` pairs written as separate declarations.
 *     Those live in the pinned matrix plus the D-69 manual pass.
 *   A half-working cascade resolver would be a gate that fails open, which is
 *   worse than a narrow gate with its blind spots written down.
 *
 * IT ALSO OVER-REPORTS IN ONE DIRECTION, on purpose. Within one element it takes
 * the UNION of every foreground and every background it finds, so two arms of a
 * `cond ? "…" : "…"` className are treated as co-occurring even though only one
 * is ever live. That is the safe direction for a gate; such a hit is dismissed by
 * a KNOWN_PAIRS entry that says so in its `reason`.
 *
 * KNOWN_PAIRS is the 04-01 allowlist pattern (scripts/audit-tokens-allowlist.json):
 * keyed on { file, fg, bg } and never on a line number, and a STALE entry — one
 * that now matches nothing — is itself a FAILURE. That is what makes the contrast
 * sweep converge: plan 04-04 / 04-11 / 04-12 must delete its entry in the same
 * commit that fixes the markup, or this gate goes red on the stale entry.
 *
 * ANTI-FAIL-OPEN FLOOR. A gate that reports PASSED because its extractor found
 * nothing is worse than no gate (04-01's --selftest was green while its class
 * derivation was blind). So the run FAILS if the scan finds no elements, no
 * foreground token application, or no background token application anywhere in
 * the tree — states that are structurally impossible for this codebase and can
 * therefore only mean the extractor broke.
 *
 * It also fails if tests/contrast.test.ts is missing or empty: this gate must not
 * be able to pass while its own ratio authority has been deleted.
 *
 * Run: `node scripts/audit-contrast.ts` (node runs this .ts directly via
 * type-stripping). No env var, no secret, no network, no subprocess — repo-local
 * file reads only.
 *
 * Exits non-zero on any co-occurrence that is not a known pair, any stale or
 * malformed known-pair entry, an empty extraction, or a missing ratio authority;
 * exits 0 and prints one PASSED line otherwise.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const SCAN_DIRS = ['app', 'components'] as const;
const SCAN_EXT = '.tsx';

/** The ratio authority. This gate is void without it. */
const RATIO_AUTHORITY_REL = 'tests/contrast.test.ts';

interface ForbiddenPair {
  /** Foreground token, leading `--` included. */
  fg: string;
  /** Background token, leading `--` included. */
  bg: string;
  /** The pinned ratio from tests/contrast.test.ts, for the failure message. */
  ratio: number;
}

/** The three pairs that fail WCAG 1.4.3 normal text (4.5:1). */
const FORBIDDEN_PAIRS: readonly ForbiddenPair[] = [
  { fg: '--warning', bg: '--warning-soft', ratio: 2.92 },
  { fg: '--accent', bg: '--surface-3', ratio: 4.36 },
  { fg: '--success', bg: '--success-soft', ratio: 4.47 },
];

interface KnownPair {
  /** Repo-relative posix path. */
  file: string;
  fg: string;
  bg: string;
  /**
   * How many elements in that file carry this pair TODAY, measured. Never a line
   * number (line numbers drift; 04-01's rule), but the count is what stops a
   * `{file, fg, bg}` key from masking a SECOND occurrence added later to an
   * already-baselined file — a fail-open that was observed during this plan's
   * two-sided validation. A mismatch in EITHER direction fails: more means a new
   * violation slipped in, fewer means the markup was partly fixed and the entry
   * must be narrowed (or deleted) in the same commit.
   */
  count: number;
  /** Why this hit exists today, and whether it is a real violation. Never blank. */
  reason: string;
  /** The plan that must fix the markup AND delete this entry, `NN-NN`. */
  fixed_by: string;
}

/**
 * Co-occurrences that exist in the tree TODAY, each owned by a named plan.
 *
 * This is a baseline, not an exemption: every entry is a debt with a due date,
 * and because a stale entry fails the gate, the debt cannot be quietly rolled
 * forward. Populated from a measured run at plan 04-02, never by guesswork.
 */
const KNOWN_PAIRS: readonly KnownPair[] = [
  {
    file: 'components/BalanceBadge.tsx',
    fg: '--warning',
    bg: '--warning-soft',
    count: 1,
    reason:
      'REAL text violation. The zero-balance D-21 pill puts border-[var(--warning-border)] ' +
      'bg-[var(--warning-soft)] text-[var(--warning)] on one span, so the credit count reads ' +
      'at 2.92:1. Remedy per tests/contrast.test.ts: keep --warning for the dot glyph against ' +
      'the surface and move the words to --text-2 (5.16:1). 04-11 names this as "the ' +
      'zero-credit balance badge".',
    fixed_by: '04-11',
  },
  {
    file: 'components/ChatThread.tsx',
    fg: '--warning',
    bg: '--warning-soft',
    count: 1,
    reason:
      'REAL text violation, and the one on the demo path — the out-of-credits composer notice ' +
      '(role="note") sets bg-[var(--warning-soft)] with text-[var(--warning)] at 13px/550 on ' +
      'the same div, so the words a blocked reviewer must read sit at 2.92:1. The copy is ' +
      'byte-pinned: 04-11 must change the classes and never the string.',
    fixed_by: '04-11',
  },
  {
    file: 'components/chat/ArtifactCard.tsx',
    fg: '--warning',
    bg: '--warning-soft',
    count: 1,
    reason:
      'REAL, but a NON-TEXT violation: the degraded 40x40 icon tile colours a <WarnTileIcon /> ' +
      'glyph via currentColor, not words. It still fails, because 2.92:1 is below even the 3:1 ' +
      'WCAG 1.4.11 bar — which is why RESEARCH conclusion 4 says to pair the warning glyph ' +
      'against the surface (3.30:1) rather than against its own soft fill.',
    fixed_by: '04-11',
  },
  {
    file: 'components/AppShell.tsx',
    fg: '--accent',
    bg: '--surface-3',
    count: 3,
    reason:
      'REAL, and three sites in one file: the Settings nav link, the Stats nav link and the ' +
      'sign-out button each carry hover:bg-[var(--surface-3)] + hover:text-[var(--accent)] on ' +
      'the same element, so both halves are genuinely live together at 4.36:1. Remedy: ' +
      'hover:text-[var(--accent-hover)] (6.22:1). Worth noting because axe evaluates the ' +
      'RESTING state only and cannot see this pair at all — a same-element hover pair is the ' +
      'one slice of :hover contrast a source scan CAN prove, so this entry is load-bearing ' +
      'evidence rather than a duplicate of the Lighthouse gate.',
    fixed_by: '04-11',
  },
];

// ---------------------------------------------------------------------------
// JSX opening-tag attribute spans.
// ---------------------------------------------------------------------------

interface Span {
  /** 1-based line of the `<`. */
  line: number;
  /** The tag text from `<` up to (not including) the closing `>`. */
  text: string;
}

/**
 * Yield one span per JSX opening tag. Brace depth, string literals and comments
 * are tracked so a multi-line `className={cond ? "…" : "…"}` stays one span and
 * a `>` inside an expression does not end the tag early.
 *
 * A nested element inside an attribute expression is NOT yielded separately —
 * its classes are attributed to the enclosing tag. That coarsens the reported
 * line, never the detection.
 *
 * TypeScript generics (`useState<Foo>`) and comparisons also match `<` + letter;
 * they yield harmless spans that carry no token utility.
 */
function spans(text: string): Span[] {
  const out: Span[] = [];
  // Prefix line index for O(1) line lookup.
  const lineAt: number[] = new Array(text.length + 1);
  let line = 1;
  for (let k = 0; k < text.length; k++) {
    lineAt[k] = line;
    if (text[k] === '\n') line += 1;
  }
  lineAt[text.length] = line;

  let i = 0;
  while (i < text.length) {
    if (text[i] !== '<' || !/[A-Za-z]/.test(text[i + 1] ?? '')) {
      i += 1;
      continue;
    }
    const start = i;
    let j = i + 1;
    let depth = 0;
    let quote: string | null = null;
    let closed = false;
    while (j < text.length) {
      const c = text[j];
      if (quote !== null) {
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) quote = null;
        j += 1;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        j += 1;
        continue;
      }
      if (c === '/' && text[j + 1] === '/') {
        while (j < text.length && text[j] !== '\n') j += 1;
        continue;
      }
      if (c === '/' && text[j + 1] === '*') {
        const end = text.indexOf('*/', j + 2);
        j = end === -1 ? text.length : end + 2;
        continue;
      }
      if (c === '{') {
        depth += 1;
        j += 1;
        continue;
      }
      if (c === '}') {
        depth -= 1;
        j += 1;
        continue;
      }
      if (depth === 0 && c === '>') {
        closed = true;
        break;
      }
      if (depth === 0 && c === '<') {
        // Not a tag after all (a comparison, or malformed). Re-scan from the
        // next character so the inner `<` still gets its chance.
        break;
      }
      j += 1;
    }
    if (!closed) {
      i = start + 1;
      continue;
    }
    out.push({ line: lineAt[start], text: text.slice(start, j) });
    i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Foreground / background token applications within one span.
// ---------------------------------------------------------------------------

/** Tailwind arbitrary text colour, with or without variant prefixes. */
const FG_CLASS_RE = /text-\[var\(--([a-z0-9-]+)\)\]/g;
/** Tailwind arbitrary background colour. */
const BG_CLASS_RE = /bg-\[var\(--([a-z0-9-]+)\)\]/g;
/**
 * Inline `color:` — the negative lookbehind is what keeps `backgroundColor:`
 * (and `borderColor:`, `outlineColor:`) out of the foreground set.
 */
const FG_STYLE_RE = /(?<![A-Za-z-])color\s*:\s*[^;,}]*var\(--([a-z0-9-]+)\)/gi;
/** Inline `background` / `backgroundColor` / `background-color`. */
const BG_STYLE_RE = /\bbackground(?:-?color)?\s*:\s*[^;,}]*var\(--([a-z0-9-]+)\)/gi;

function collect(text: string, ...res: RegExp[]): Set<string> {
  const found = new Set<string>();
  for (const re of res) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) found.add(`--${m[1].toLowerCase()}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Scan.
// ---------------------------------------------------------------------------

const failures: string[] = [];
function fail(msg: string): void {
  failures.push(msg);
}

function relposix(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(abs, out);
      continue;
    }
    if (path.extname(entry.name) !== SCAN_EXT) continue;
    out.push(abs);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  fg: string;
  bg: string;
  ratio: number;
}

interface ScanResult {
  hits: Hit[];
  fileCount: number;
  spanCount: number;
  /** Spans carrying at least one foreground token application. */
  fgSpanCount: number;
  /** Spans carrying at least one background token application. */
  bgSpanCount: number;
}

function scan(): ScanResult {
  const hits: Hit[] = [];
  let fileCount = 0;
  let spanCount = 0;
  let fgSpanCount = 0;
  let bgSpanCount = 0;

  for (const dir of SCAN_DIRS) {
    for (const abs of walk(path.join(ROOT, dir), [])) {
      fileCount += 1;
      const rel = relposix(abs);
      const source = readFileSync(abs, 'utf8');
      for (const span of spans(source)) {
        spanCount += 1;
        const fgs = collect(span.text, FG_CLASS_RE, FG_STYLE_RE);
        const bgs = collect(span.text, BG_CLASS_RE, BG_STYLE_RE);
        if (fgs.size > 0) fgSpanCount += 1;
        if (bgs.size > 0) bgSpanCount += 1;
        if (fgs.size === 0 || bgs.size === 0) continue;
        for (const p of FORBIDDEN_PAIRS) {
          if (fgs.has(p.fg) && bgs.has(p.bg)) {
            hits.push({ file: rel, line: span.line, fg: p.fg, bg: p.bg, ratio: p.ratio });
          }
        }
      }
    }
  }
  return { hits, fileCount, spanCount, fgSpanCount, bgSpanCount };
}

function key(file: string, fg: string, bg: string): string {
  return `${file} ${fg} on ${bg}`;
}

/** A known-pair entry with no written reason or no owner legitimises nothing. */
function checkKnownShapes(): void {
  KNOWN_PAIRS.forEach((e, i) => {
    const at = `KNOWN_PAIRS[${i}] (${e.file} / ${e.fg} on ${e.bg})`;
    if (typeof e.file !== 'string' || e.file.trim() === '') fail(`${at}: missing 'file'`);
    if (!FORBIDDEN_PAIRS.some((p) => p.fg === e.fg && p.bg === e.bg)) {
      fail(`${at}: '${e.fg} on ${e.bg}' is not one of the three FORBIDDEN_PAIRS`);
    }
    if (typeof e.reason !== 'string' || e.reason.trim() === '') {
      fail(`${at}: 'reason' must say why this hit exists and whether it is real`);
    }
    if (!Number.isInteger(e.count) || e.count < 1) {
      fail(`${at}: 'count' must be a measured positive integer, got ${JSON.stringify(e.count)}`);
    }
    if (!/^\d{2}-\d{2}$/.test(e.fixed_by ?? '')) {
      fail(`${at}: 'fixed_by' must name the owning plan in the NN-NN form`);
    }
  });
}

/** The ratio authority must exist and be non-empty. */
function checkRatioAuthority(): void {
  const abs = path.join(ROOT, RATIO_AUTHORITY_REL);
  let size = -1;
  try {
    size = statSync(abs).size;
  } catch {
    fail(
      `${RATIO_AUTHORITY_REL} is missing — this gate only reports pair NAMES; the RATIOS ` +
        `are pinned there, so without it SC-5 has no automated contrast authority at all`,
    );
    return;
  }
  if (size <= 0) {
    fail(`${RATIO_AUTHORITY_REL} is empty — the ratio authority has been gutted`);
  }
}

async function main(): Promise<void> {
  checkRatioAuthority();
  checkKnownShapes();

  const { hits, fileCount, spanCount, fgSpanCount, bgSpanCount } = scan();

  // Anti-fail-open floor: an extraction that finds nothing must never report PASSED.
  if (fileCount === 0) fail(`extraction floor: scanned 0 ${SCAN_EXT} files — the walk is broken`);
  if (spanCount === 0) fail('extraction floor: found 0 JSX spans — the span scanner is broken');
  if (fgSpanCount === 0) {
    fail(
      'extraction floor: found 0 elements applying a text-[var(--…)] / inline color token — ' +
        'impossible in this tree, so the foreground matcher is broken',
    );
  }
  if (bgSpanCount === 0) {
    fail(
      'extraction floor: found 0 elements applying a bg-[var(--…)] / inline background token — ' +
        'impossible in this tree, so the background matcher is broken',
    );
  }

  const known = new Map<string, KnownPair>();
  for (const e of KNOWN_PAIRS) {
    const k = key(e.file, e.fg, e.bg);
    if (known.has(k)) fail(`KNOWN_PAIRS: duplicate entry for ${k}`);
    known.set(k, e);
  }

  const seen = new Map<string, Hit[]>();
  for (const h of hits) {
    const k = key(h.file, h.fg, h.bg);
    if (known.has(k)) {
      const list = seen.get(k);
      if (list) list.push(h);
      else seen.set(k, [h]);
      continue;
    }
    fail(
      `forbidden pair ${h.fg} on ${h.bg} (${h.ratio}:1, below 4.5:1) applied to one element ` +
        `at ${h.file}:${h.line} — split the pair (see tests/contrast.test.ts for the remedy) ` +
        `or add a justified KNOWN_PAIRS entry naming the plan that will fix it`,
    );
  }

  for (const [k, e] of known) {
    const found = seen.get(k) ?? [];
    // A stale entry means the markup moved or was fixed without the baseline being
    // narrowed — the gate would then be wider than the code it guards.
    if (found.length === 0) {
      fail(
        `stale KNOWN_PAIRS entry ${k} matches nothing in the tree — delete it (the pair was ` +
          `fixed, which is what plan ${e.fixed_by} was for) or correct its 'file' (it moved)`,
      );
      continue;
    }
    // Count drift in either direction. MORE is a new violation hiding behind an
    // existing entry; FEWER is a partial fix that must narrow or delete the entry.
    if (found.length !== e.count) {
      const at = found.map((h) => `${h.file}:${h.line}`).join(', ');
      fail(
        `KNOWN_PAIRS count drift for ${k}: baselined ${e.count}, found ${found.length} (${at}) — ` +
          (found.length > e.count
            ? `a NEW occurrence of an already-baselined pair was added; fix it, do not raise the count`
            : `the pair was partly fixed (plan ${e.fixed_by}); narrow 'count' to ${found.length} ` +
              `or delete the entry once it reaches 0`),
      );
    }
  }

  console.log(
    `scanned ${fileCount} ${SCAN_EXT} file(s) under ${SCAN_DIRS.join('/, ')}/ — ` +
      `${spanCount} JSX span(s), ${fgSpanCount} with a foreground token, ${bgSpanCount} with a background token`,
  );
  console.log(
    `forbidden pairs checked: ${FORBIDDEN_PAIRS.map((p) => `${p.fg}/${p.bg} (${p.ratio})`).join(', ')}`,
  );
  console.log(`co-occurrences found: ${hits.length}; known baseline entries: ${KNOWN_PAIRS.length}`);
  for (const e of KNOWN_PAIRS) {
    console.log(`  baseline: ${e.file} — ${e.fg} on ${e.bg} x${e.count} — fixed_by ${e.fixed_by}`);
  }

  if (failures.length > 0) {
    console.error(`\nCONTRAST AUDIT FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nCONTRAST AUDIT PASSED: no element applies an un-baselined forbidden foreground/background ` +
      `pair; all ${KNOWN_PAIRS.length} baseline entr(ies) still match and carry an owning plan; ` +
      `${RATIO_AUTHORITY_REL} is present as the ratio authority.`,
  );
}

main().catch((err: unknown) => {
  console.error('CONTRAST AUDIT ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
