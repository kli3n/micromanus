/**
 * scripts/audit-css-classes.ts — the built-CSS presence gate (Phase 4, plan 04-01).
 *
 * Phase 3 established that an unrecognised Tailwind utility is dropped SILENTLY:
 * a green build proves nothing about an arbitrary-value class. This gate proves
 * the class actually shipped, by reading the built stylesheet.
 *
 * Three specifics are load-bearing, and every one of them is a way this gate
 * would otherwise fail OPEN:
 *
 *   1. Location. Under Next 16 + Turbopack the stylesheet is emitted into
 *      `.next/static/chunks/` (NOT the `.next/static/` + `css/` path that older
 *      Next versions used), and the filename is content-hashed — the current
 *      artifact is `1aokduc7khae_.css`. The directory is therefore GLOBBED; a
 *      hard-coded filename would silently stop matching on the next build.
 *   2. Escaping. Tailwind CSS-escapes the brackets and colons in the emitted
 *      selector, so a naive substring search for `min-h-[132px]` finds NOTHING
 *      for a class that DID ship (the emitted selector is `.min-h\[132px\]`).
 *      Every backslash is stripped from the CSS text before matching. Shell
 *      equivalent, validated in research:
 *        cat .next/static/chunks/*.css | tr -d '\134' | grep -c -F ".$1"
 *   3. Staleness. `.next/` goes stale on every source change, and an empty glob
 *      would make a "zero classes absent" result vacuous. Missing build output
 *      is a hard FAILURE, never a pass.
 *
 * PREREQUISITE: `npm run build` must have been run against the current tree.
 *
 * The checked class list is DERIVED by scanning every .tsx file under app/ and
 * components/ for bracketed-arbitrary-value and variant-prefixed utilities —
 * never hand-maintained. A hand-maintained array would make this one file a
 * shared write target for eight later plans across six waves, and a class a plan
 * forgot to register would slip through the gate exactly when it mattered.
 * KNOWN_ABSENT is the escape hatch for genuine false positives, each entry
 * carrying a written justification.
 *
 * Run: `node scripts/audit-css-classes.ts` (node runs this .ts directly via
 * type-stripping). Requires no env, no secret, no network and no subprocess.
 * Run: `node scripts/audit-css-classes.ts --selftest` for the two-sided proof
 * that the matcher discriminates — a fabricated class must be reported ABSENT
 * and three known-present classes must be reported PRESENT. A gate that has
 * never been observed to discriminate is not a gate.
 *
 * Exits non-zero on any derived class absent from the built CSS, any stale
 * KNOWN_ABSENT entry, any missing required media query, or missing build output.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CSS_GLOB_DIR = path.join(ROOT, '.next', 'static', 'chunks');
const SCAN_DIRS = ['app', 'components'] as const;

/**
 * Media queries that MUST be present in the built CSS today.
 * Tailwind v4 emits breakpoints in rem: `sm` = 40rem; `lg` = 64rem — the
 * drawer breakpoint, promoted from PENDING_MEDIA by plan 04-06 (D-68) when
 * the drawer landed. NOTE: the media-presence check alone is coarse (Tailwind
 * also emits `(min-width:64rem)` for the `.container` ramp); the per-class
 * assertion over every derived `lg:` utility is what actually proves the
 * drawer's grid change compiled.
 */
const REQUIRED_MEDIA = [
  '@media (min-width:40rem)',
  '@media (min-width:64rem)',
] as const;

/**
 * Media queries that are the TARGET but not yet emitted. Reported as
 * informational so the gate stays green while still recording the goal.
 * Empty since plan 04-06 promoted the `lg` drawer breakpoint into
 * REQUIRED_MEDIA.
 */
const PENDING_MEDIA: readonly string[] = [];

/**
 * Genuine false positives: tokens this file's extractor reads as a utility that
 * Tailwind legitimately never emits. Every entry needs a written justification,
 * in the same spirit as scripts/audit-tokens-allowlist.json. An entry that no
 * longer matches any extracted candidate is STALE and fails the run, so this
 * list cannot quietly grow wider than the code.
 */
const KNOWN_ABSENT: ReadonlyArray<{ class: string; justification: string }> = [];

/** The two-sided proof set. */
const SELFTEST_PRESENT = ['min-h-[132px]', 'sm:grid-cols-2', 'group-open:rotate-90'] as const;
const SELFTEST_ABSENT = 'NOPE-[999px]';

const failures: string[] = [];

function fail(msg: string): void {
  failures.push(msg);
}

function relposix(abs: string): string {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// The built stylesheet
// ---------------------------------------------------------------------------

/** Glob the content-hashed stylesheet(s). Never hard-code a filename. */
function findCssFiles(): string[] {
  let names: string[];
  try {
    names = readdirSync(CSS_GLOB_DIR);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.css')).map((n) => path.join(CSS_GLOB_DIR, n));
}

interface Haystack {
  /** CSS text with every backslash stripped — the escaping fix (specific 2). */
  unescaped: string;
  /** Same text with all whitespace removed, for media-query matching. */
  compact: string;
  files: string[];
}

function loadCss(): Haystack | null {
  const files = findCssFiles();
  if (files.length === 0) return null;
  const raw = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const unescaped = raw.replaceAll('\\', '');
  return { unescaped, compact: unescaped.replace(/\s+/g, ''), files };
}

function isPresent(hay: Haystack, className: string): boolean {
  return hay.unescaped.includes(`.${className}`);
}

// ---------------------------------------------------------------------------
// Deriving the class list from source
// ---------------------------------------------------------------------------

function walkTsx(dir: string, out: string[]): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walkTsx(abs, out);
    } else if (e.name.endsWith('.tsx')) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * String-literal and template-chunk contents — where class names live. The
 * `\\.` alternatives matter: a literal containing a backslash escape would
 * otherwise terminate the match early and shift every subsequent quote pairing
 * by one, so the "literals" found after it would actually be the CODE between
 * them (which is how `gap-[10px]">` shows up as a candidate).
 */
const STRING_LITERALS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** Stray syntax that can cling to a token once a literal boundary is crossed. */
const STRAY_EDGE = /^[\s"'`<>=;,:.+\\/|)]+|[\s"'`<>=;,+\\|(]+$/g;

/**
 * The Tailwind VARIANT vocabulary. Declaring this closed set is what makes the
 * derivation trustworthy: object keys and CSS declarations in this codebase look
 * exactly like variant-prefixed utilities to a naive splitter (`color:var(--x)`,
 * `display:none`, `overflow-x:auto`, `m:ss`, `role:note`), and there is no way to
 * tell them apart from the token shape alone. Variants are a fixed Tailwind
 * vocabulary, unlike utilities — so the CLASS LIST stays derived from source
 * (which is the point: no later plan has to register its classes here) while only
 * this framework-level vocabulary is stated.
 *
 * If a later plan uses a variant absent from this set, its class is skipped
 * rather than asserted — so add the variant here when you add a new kind.
 */
const KNOWN_VARIANT_NAMES = new Set([
  'sm', 'md', 'lg', 'xl', '2xl', 'max-sm', 'max-md', 'max-lg', 'max-xl',
  'hover', 'focus', 'focus-visible', 'focus-within', 'active', 'visited', 'target',
  'disabled', 'enabled', 'checked', 'indeterminate', 'required', 'invalid', 'valid',
  'read-only', 'placeholder-shown', 'autofill', 'default', 'optional',
  'first', 'last', 'only', 'odd', 'even', 'first-of-type', 'last-of-type',
  'empty', 'open', 'closed', 'dark', 'light', 'print', 'rtl', 'ltr',
  'motion-safe', 'motion-reduce', 'contrast-more', 'contrast-less',
  'forced-colors', 'inverted-colors', 'portrait', 'landscape',
  'before', 'after', 'placeholder', 'selection', 'marker', 'file',
  'first-line', 'first-letter', 'backdrop', 'details-content',
  'starting', 'hover-none', 'pointer-fine', 'pointer-coarse', 'any-pointer-fine',
]);

/** Variant families that take a suffix or a bracket argument. */
const KNOWN_VARIANT_PREFIXES = [
  'group-', 'peer-', 'has-', 'not-', 'in-', 'nth-', 'aria-', 'data-',
  'supports-', 'min-', 'max-', '@',
] as const;

function isKnownVariant(name: string): boolean {
  if (KNOWN_VARIANT_NAMES.has(name)) return true;
  return KNOWN_VARIANT_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);
}

/**
 * Split a candidate on top-level colons only (a colon inside brackets, e.g.
 * `bg-[var(--x)]` or `data-[state=open]`, is part of the value, not a separator).
 */
function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of token) {
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    if (ch === ':' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Does this token look like a Tailwind utility worth asserting?
 *
 * Deliberately strict, because the extractor sees every string literal in the
 * file — URLs (`https://…`), timestamps (`…T08:47:26.212Z`), channel names
 * (`chat:${id}`) and CSS values all contain colons or brackets. Rejecting them
 * here is what keeps the gate about classes.
 */
function isUtilityCandidate(token: string): boolean {
  if (token.length < 2 || token.length > 120) return false;
  if (token.includes('//')) return false; // a URL, not a class

  // Balanced brackets/parens — an unbalanced token is a fragment, not a class.
  let depth = 0;
  for (const ch of token) {
    if (ch === '[' || ch === '(') depth += 1;
    else if (ch === ']' || ch === ')') depth -= 1;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;

  const segments = splitVariants(token);
  const base = segments[segments.length - 1] ?? '';
  const variants = segments.slice(0, -1);
  if (base === '') return false;

  // Every variant segment must be a REAL Tailwind variant. This is the single
  // check that separates `sm:grid-cols-2` from `overflow-x:auto`.
  for (const v of variants) {
    const name = (v.startsWith('!') ? v.slice(1) : v).replace(/\[[^\]]*\]$/, '');
    if (!isKnownVariant(name)) return false;
  }

  // Scope: bracketed arbitrary values, or variant-prefixed utilities.
  const bracketArgs = [...base.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]);
  const hasBracketWithContent = bracketArgs.some((a) => a.length > 0);
  if (variants.length === 0 && !hasBracketWithContent) return false;
  if (bracketArgs.some((a) => a.length === 0)) return false; // `foo-[]`

  // Base shape. Uppercase is deliberately ALLOWED here: Tailwind's registered
  // utilities are all lowercase, so an uppercase letter means the class cannot
  // compile — which is precisely the silent drop this gate exists to catch. An
  // earlier revision rejected uppercase bases to filter out timestamps and code
  // identifiers, and that made the gate fail OPEN on the acceptance criterion's
  // own fabricated class (`NOPE-[999px]` was skipped, not reported). The variant
  // vocabulary and the `-[` rule below do that filtering without the blind spot.
  if (!/^-?[A-Za-z[]/.test(base)) return false;
  // An arbitrary-PROPERTY base is `[color:red]` — it must carry a colon inside.
  // This rejects CSS-ish fragments such as `[/app/stats]`.
  if (base.startsWith('[') && !bracketArgs.some((a) => a.includes(':'))) return false;
  // A Tailwind arbitrary VALUE is always `utility-[value]` — the bracket is
  // preceded by a hyphen (`min-h-[132px]`, `bg-[var(--accent)]`). A bracket that
  // follows a letter is a CSS attribute selector from the server-rendered
  // <style> blocks (`.stats-row[open]`), not a class.
  for (let i = 1; i < base.length; i += 1) {
    if (base[i] === '[' && base[i - 1] !== '-') return false;
  }
  const outsideBrackets = base.replace(/\[[^\]]*\]/g, '');
  // No parens or quoting syntax outside brackets: `var(--accent)` and
  // `rotate(90deg)` are CSS values, never utility names.
  if (!/^[-A-Za-z0-9./%!*&#$~_]*$/.test(outsideBrackets)) return false;
  return true;
}

interface Candidate {
  class: string;
  sites: Set<string>;
}

function deriveCandidates(): { candidates: Map<string, Candidate>; fileCount: number } {
  const candidates = new Map<string, Candidate>();
  let fileCount = 0;
  for (const dir of SCAN_DIRS) {
    for (const abs of walkTsx(path.join(ROOT, dir), [])) {
      fileCount += 1;
      const rel = relposix(abs);
      const text = readFileSync(abs, 'utf8');
      STRING_LITERALS.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STRING_LITERALS.exec(text)) !== null) {
        const body = m[0].slice(1, -1);
        for (const rawToken of body.split(/[\s${}]+/)) {
          STRAY_EDGE.lastIndex = 0;
          const token = rawToken.replace(STRAY_EDGE, '');
          if (!isUtilityCandidate(token)) continue;
          const existing = candidates.get(token);
          if (existing) existing.sites.add(rel);
          else candidates.set(token, { class: token, sites: new Set([rel]) });
        }
      }
    }
  }
  return { candidates, fileCount };
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function selftest(hay: Haystack): void {
  console.log('selftest — proving the matcher discriminates:');
  for (const c of SELFTEST_PRESENT) {
    if (isPresent(hay, c)) {
      console.log(`  PASS: '${c}' correctly reported PRESENT in the built CSS`);
    } else {
      fail(
        `selftest: '${c}' is known to ship but was reported ABSENT — the matcher is broken ` +
          `(most likely the backslash strip regressed, or .next/ is stale)`,
      );
      console.error(`  FAIL: '${c}' reported ABSENT (it is known to ship)`);
    }
  }
  if (isPresent(hay, SELFTEST_ABSENT)) {
    fail(
      `selftest: fabricated class '${SELFTEST_ABSENT}' was reported PRESENT — the matcher ` +
        `passes vacuously and proves nothing`,
    );
    console.error(`  FAIL: fabricated '${SELFTEST_ABSENT}' reported PRESENT`);
  } else {
    console.log(`  PASS: fabricated '${SELFTEST_ABSENT}' correctly reported ABSENT`);
  }
}

function auditDerived(hay: Haystack): void {
  const { candidates, fileCount } = deriveCandidates();
  const knownAbsent = new Map(KNOWN_ABSENT.map((k) => [k.class, k]));
  const usedKnownAbsent = new Set<string>();

  let present = 0;
  const absent: Candidate[] = [];
  for (const c of candidates.values()) {
    if (isPresent(hay, c.class)) {
      present += 1;
      continue;
    }
    if (knownAbsent.has(c.class)) {
      usedKnownAbsent.add(c.class);
      continue;
    }
    absent.push(c);
  }

  console.log(
    `derived ${candidates.size} candidate utilit(ies) from ${fileCount} .tsx file(s) under ` +
      `${SCAN_DIRS.join('/, ')}/ — ${present} present, ${absent.length} absent, ` +
      `${usedKnownAbsent.size} justified as KNOWN_ABSENT`,
  );

  for (const c of absent) {
    fail(
      `class '${c.class}' appears in ${[...c.sites].sort().join(', ')} but is ABSENT from the ` +
        `built CSS — Tailwind dropped it silently (typo, unsupported utility, or a class ` +
        `assembled at runtime); fix it or add a justified KNOWN_ABSENT entry`,
    );
  }

  for (const k of KNOWN_ABSENT) {
    if (!k.justification.trim()) {
      fail(`KNOWN_ABSENT entry '${k.class}' has no justification`);
    }
    if (!usedKnownAbsent.has(k.class)) {
      fail(
        `stale KNOWN_ABSENT entry '${k.class}': it matches no absent candidate in the tree — ` +
          `remove it (the class now ships, or no longer exists in source)`,
      );
    }
  }

  for (const q of REQUIRED_MEDIA) {
    const needle = q.replace(/\s+/g, '');
    if (hay.compact.includes(needle)) {
      console.log(`  PASS: required media query '${q}' is emitted`);
    } else {
      fail(`required media query '${q}' is NOT emitted in the built CSS`);
    }
  }
  for (const q of PENDING_MEDIA) {
    const needle = q.replace(/\s+/g, '');
    const seen = hay.compact.includes(needle);
    console.log(
      `  INFO: pending media query '${q}' ${seen ? 'IS' : 'is not yet'} emitted ` +
        `(the owning plan promotes this to a hard assertion once its feature lands)`,
    );
  }
}

async function main(): Promise<void> {
  const selftestOnly = process.argv.includes('--selftest');

  const hay = loadCss();
  if (hay === null) {
    console.error(
      `CSS CLASS AUDIT FAILED (1 assertion(s)):\n` +
        ` - no built stylesheet found under ${relposix(CSS_GLOB_DIR)}/*.css — run \`npm run build\` first. ` +
        `Refusing to report "0 classes absent" against no input, because that would pass vacuously.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`built CSS: ${hay.files.map(relposix).join(', ')} (${hay.unescaped.length} chars, backslashes stripped)`);

  if (selftestOnly) {
    selftest(hay);
  } else {
    auditDerived(hay);
  }

  if (failures.length > 0) {
    console.error(`\nCSS CLASS AUDIT FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
    return;
  }
  if (selftestOnly) {
    console.log(
      `\nCSS CLASS AUDIT PASSED (selftest): the matcher reports the fabricated class ` +
        `'${SELFTEST_ABSENT}' absent and all ${SELFTEST_PRESENT.length} known-shipping classes ` +
        `present — it discriminates rather than failing open.`,
    );
    return;
  }
  console.log(
    `\nCSS CLASS AUDIT PASSED: every bracketed-arbitrary-value and variant-prefixed utility ` +
      `derived from app/ and components/ is present in the built CSS, no KNOWN_ABSENT entry is ` +
      `stale, and every required media query is emitted.`,
  );
}

main().catch((err: unknown) => {
  console.error('CSS CLASS AUDIT ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
