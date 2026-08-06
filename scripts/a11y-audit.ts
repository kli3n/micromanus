/**
 * scripts/a11y-audit.ts — the D-69 accessibility gate (SC-5, plan 04-02).
 *
 * Drives Lighthouse's accessibility category over the six key surfaces the
 * UI-SPEC locks, records one JSON report per surface under `.a11y/`, prints each
 * score, and fails if any surface scores below THRESHOLD (95).
 *
 * WHY LIGHTHOUSE AND NOT axe-core: D-69 names a Lighthouse *score* of >=95.
 * That is a weighted aggregate of axe audits; a raw axe run yields violation
 * COUNTS, not a score, so choosing axe would mean reinterpreting a locked
 * threshold. And `npx lighthouse` keeps it out of package.json entirely, which
 * is how this repo already runs one-off probes (test:rls, test:money,
 * eval:offline). `@axe-core/playwright` was declined: it would add Playwright, a
 * browser-automation dependency plus a second test runner, for a gate that runs
 * a handful of times.
 *
 * ── DELIBERATELY OUT OF THE COMPOSITE GATE (plan 04-14) ───────────────────────
 * Registered as `npm run audit:a11y:deployed` and NOT a member of
 * `npm run audit:gate`. The other four gates (unit suite, typecheck, token gate,
 * built-CSS gate, contrast) run from source and a local build with no external
 * provisioning; this one needs a running debug browser, TWO provisioned accounts
 * and a DEPLOYED url (see PREREQUISITES below). Folding it into the composite
 * gate would make that gate fail for environmental reasons on every ordinary
 * run — and a gate that fails for the wrong reason gets ignored, which silently
 * removes every OTHER member's protection too. The `:deployed` suffix in the
 * script name carries the same warning at the call site; package.json is JSON
 * and admits no comment, so this header is where the reason lives.
 *
 * ── PREREQUISITES ─────────────────────────────────────────────────────────────
 * 1. A signed-in debug Chrome, launched BEFORE this script:
 *
 *      chrome --remote-debugging-port=9222 --user-data-dir=/tmp/mm-a11y-profile
 *
 *    Then sign in through real OAuth in that window. Lighthouse attaches to it
 *    over --port=9222 and inherits the session.
 * 2. Env: A11Y_BASE_URL (the deployed https origin; NEXT_PUBLIC_SITE_HOST is
 *    accepted as a fallback) and A11Y_CHAT_ID (a chat owned by the signed-in
 *    account with a COMPLETED research run, so the rail, sources and artifact
 *    card are all on screen).
 * 3. TWO ACCOUNTS, and they cannot be the same one. `/app` renders the paywall
 *    only at balance <= 0 (app/app/page.tsx:52-53), so a credited account audits
 *    a screen the reviewer will never see, and a zero-credit account owns no
 *    completed research chat. Each surface therefore declares which session it
 *    needs in `requires`, and the operator re-signs-in between the two groups.
 *
 * ── WHY NOT --extra-headers ───────────────────────────────────────────────────
 * Passing the session as a Cookie header works in general, and is DECLINED here.
 * This app's Supabase session cookie is CHUNKED across `sb-<ref>-auth-token.N`
 * (recorded in STATE.md for Phase 03), so every chunk would have to be
 * reassembled by hand; the header form also OVERRIDES all other cookies, so
 * Vercel Deployment Protection's `_vercel_jwt` would have to be folded in too;
 * and the JWT expires mid-session. Worse, it puts a live credential into shell
 * history and into this process's argv. The debug-profile route avoids all four:
 * the session never leaves the browser's throwaway --user-data-dir, and this
 * script never reads a cookie value. No code path below uses --extra-headers.
 *
 * ── WHAT THIS GATE CANNOT SEE ─────────────────────────────────────────────────
 * axe evaluates the RESTING state only, so `:hover` and `:focus` contrast are
 * invisible to it — including the 4.36:1 --accent-on---surface-3 sidebar hover.
 * It also cannot always resolve a computed background over a gradient, and the
 * app canvas is a radial gradient (components/AppShell.tsx:333-336), so some
 * /app/* text may come back "incomplete" rather than measured. Focus ORDER, the
 * drawer trap/restore, prefers-reduced-motion behaviour, screen-reader
 * <details> semantics and non-text UI-boundary contrast (WCAG 1.4.11) are all
 * outside its reach. `tests/contrast.test.ts` is the contrast AUTHORITY; this
 * score is a coarse aggregate on top of it, and D-69's manual half is
 * load-bearing rather than ceremonial.
 *
 * ── IF >=95 IS UNREACHABLE ────────────────────────────────────────────────────
 * Do NOT lower THRESHOLD. Record the score, read the enumerated failing audits
 * with their weights (this script prints them), and escalate the residual to the
 * user as a documented exception. A Lighthouse a11y score is a weighted average
 * of binary audits, so it moves in large steps: one failing weighted audit can
 * drop a page from 100 to the high 80s, which makes >=95 effectively "no failing
 * audit of meaningful weight".
 *
 * ── REPORTS ARE EVIDENCE, NEVER COMMITS ───────────────────────────────────────
 * `.a11y/` is gitignored. A Lighthouse JSON report can embed request headers and
 * this audit runs against a signed-in session, so the reports are to be read and
 * discarded, never committed.
 *
 * Run: `node --env-file-if-exists=.env.local scripts/a11y-audit.ts [--only=<slug>]`
 * Exits non-zero on any surface below THRESHOLD, on a missing prerequisite, or on
 * an unreadable report; exits 0 and prints one PASSED line otherwise.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, '.a11y');

/**
 * The locked D-69 number. NEVER lower this. If a surface cannot reach it, the
 * documented route is to record the score, enumerate the failing audits with
 * their weights, and escalate as an exception — not to edit this line.
 */
const THRESHOLD = 95;

/** The CDP port the operator's signed-in debug Chrome listens on. */
const DEBUG_PORT = 9222;

/** A single Lighthouse run is slow; a cold `npx` fetch on top of it is slower. */
const LIGHTHOUSE_TIMEOUT_MS = 180_000;
const NPX_PROBE_TIMEOUT_MS = 120_000;

/** The exact line to hand the operator when the port check fails. */
const CHROME_LAUNCH_LINE =
  `chrome --remote-debugging-port=${DEBUG_PORT} --user-data-dir=/tmp/mm-a11y-profile`;

/** The documented manual route. The DevTools panel never clears cookies, so it needs no storage flag. */
const DEVTOOLS_FALLBACK =
  'Manual fallback: open the surface in the signed-in window and run DevTools > Lighthouse > ' +
  'Accessibility. The panel reuses the live session and never clears cookies, so it needs no ' +
  'storage flag — record the score by hand and note the route in the SUMMARY.';

/** Which signed-in state a surface must be audited in. */
type SessionClass = 'anon' | 'zero-credit-session' | 'credited-session';

interface Surface {
  /** Report filename stem under .a11y/. */
  slug: string;
  /** Path (with query) appended to the base URL. */
  path: string;
  requires: SessionClass;
  /** What the audit is actually looking at, for the operator's benefit. */
  what: string;
}

/**
 * The six D-69 surfaces, verbatim from 04-UI-SPEC.md § Accessibility & Motion.
 *
 * Note the sixth: there is NO separate auth-error route. The D-07 banner renders
 * INLINE on the landing page behind `?error` (app/page.tsx:83-84), so the surface
 * is `/?error=access_denied`, not a path that would 404.
 */
const SURFACES: readonly Surface[] = [
  { slug: 'landing', path: '/', requires: 'anon', what: 'landing + hero (D-62/63)' },
  {
    slug: 'auth-error',
    path: '/?error=access_denied',
    requires: 'anon',
    what: 'the D-07 inline auth-error banner on the landing page — NOT a separate route',
  },
  {
    slug: 'paywall',
    path: '/app',
    requires: 'zero-credit-session',
    what: 'the paywall, which renders ONLY at balance <= 0 (app/app/page.tsx:52-53)',
  },
  {
    slug: 'settings',
    path: '/app/settings',
    requires: 'credited-session',
    what: 'settings + BYOK keys',
  },
  {
    slug: 'chat',
    path: '', // filled from A11Y_CHAT_ID below
    requires: 'credited-session',
    what: 'a chat with a COMPLETED research run: rail + sources + artifact card',
  },
  { slug: 'stats', path: '/app/stats', requires: 'credited-session', what: 'per-chat cost breakdown' },
];

// ---------------------------------------------------------------------------
// Env. requireEnv is the rls-probe.ts helper: it already handles the quote/CR
// papercut that `vercel env pull` + node --env-file leaves behind on Windows.
// ---------------------------------------------------------------------------

function requireEnv(...names: string[]): string {
  for (const n of names) {
    const raw = process.env[n];
    if (raw == null) continue;
    const v = raw.trim().replace(/^(['"])([\s\S]*)\1$/, '$2').trim();
    if (v.length > 0) return v;
  }
  throw new Error(
    `Missing required env var (one of: ${names.join(', ')}). ` +
      `Set it in .env.local before running the a11y gate.`,
  );
}

/** Normalise a base URL: accept a bare host (NEXT_PUBLIC_SITE_HOST) or a full origin. */
function normaliseBase(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// Failure accumulator (rls-probe.ts idiom).
// ---------------------------------------------------------------------------

const failures: string[] = [];
function fail(msg: string): void {
  failures.push(msg);
  console.error(`  FAIL: ${msg}`);
}
function pass(msg: string): void {
  console.log(`  PASS: ${msg}`);
}

// ---------------------------------------------------------------------------
// Subprocess. This is the one part with no in-repo analog: no existing script
// spawns an external binary or writes an output artifact.
// ---------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

/**
 * Characters that CANNOT be made safe by quoting on cmd.exe. `%` still expands
 * inside double quotes, `!` expands under delayed expansion, and a newline ends
 * the command outright. The base URL and the chat id both arrive from env, so
 * this is a real injection boundary rather than a hypothetical one — refuse to
 * spawn rather than concatenate something that could run.
 */
const UNQUOTABLE_RE = /[%!\r\n\0]/;

/** cmd.exe quoting: wrap in double quotes, escape any embedded double quote. */
function quoteArg(arg: string): string {
  if (UNQUOTABLE_RE.test(arg)) {
    throw new Error(
      `refusing to spawn: the argument ${JSON.stringify(arg)} contains a character that cannot ` +
        `be safely quoted for a Windows command line (% ! CR LF NUL). Check A11Y_BASE_URL / A11Y_CHAT_ID.`,
    );
  }
  return /^[A-Za-z0-9._:/=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Run `npx <args>`.
 *
 * On Windows `npx` is a `.cmd` shim, which Node has refused to spawn directly
 * since the CVE-2024-27980 fix. The obvious workaround — `shell: true` with an
 * args ARRAY — is what Node warns about in DEP0190, because the array is
 * concatenated rather than escaped. So instead the command line is built here,
 * quoted argument by quoted argument, and handed to `cmd.exe /d /s /c` with
 * `windowsVerbatimArguments` so Node passes it through untouched. Explicit,
 * no deprecation warning, and the quoting rule is visible in one place.
 *
 * On POSIX `npx` is a normal executable, so the args array goes straight through
 * with no shell at all.
 */
function runNpx(args: string[], timeout: number): { code: number | null; out: string; spawnError?: Error } {
  const common = { cwd: ROOT, encoding: 'utf8' as const, timeout, maxBuffer: 64 * 1024 * 1024 };
  const result = isWindows
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `npx ${args.map(quoteArg).join(' ')}`], {
        ...common,
        windowsVerbatimArguments: true,
      })
    : spawnSync('npx', args, common);
  return {
    code: result.status,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    spawnError: result.error,
  };
}

// ---------------------------------------------------------------------------
// Prerequisite probes — a clear message beats a raw subprocess stack trace.
// ---------------------------------------------------------------------------

/**
 * Is an OPERATOR-LAUNCHED BROWSER listening on DEBUG_PORT — not merely something
 * that speaks CDP?
 *
 * "Something speaks CDP on 9222" is NOT the same claim, and the difference is not
 * hypothetical. On the machine this plan was executed on, port 9222 was already
 * held by **Lenovo Vantage's embedded Edge WebView** (`/json/version` reported
 * `"User-Agent": "LenovoVantage/3.0.0.191"`, and its only page target was the
 * Vantage widget). Lighthouse attached to it happily. A gate that accepts that
 * endpoint measures a vendor utility's WebView and reports the number as if it
 * were a signed-in MicroManus surface — threat T-04-08 (spoofing the audited
 * session) arriving through the front door.
 *
 * The discriminator is the CDP `User-Agent`: a real browser reports a browser UA
 * (`Mozilla/5.0 … Chrome/…`), while an embedding application reports its own
 * product string. The identity found is ALWAYS printed, so a wrong attach is
 * visible in the transcript rather than silent.
 */
async function probeDebugPort(): Promise<{ error: string | null; identity: string }> {
  let identity = 'unknown';
  try {
    const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return { error: `port ${DEBUG_PORT} answered HTTP ${res.status}, not a CDP endpoint`, identity };
    }
    const info = (await res.json()) as { Browser?: unknown; 'User-Agent'?: unknown };
    if (typeof info.Browser !== 'string') {
      return {
        error: `port ${DEBUG_PORT} answered, but the payload is not a CDP /json/version response`,
        identity,
      };
    }
    const ua = typeof info['User-Agent'] === 'string' ? info['User-Agent'] : '';
    identity = `${info.Browser} / UA ${ua || '(absent)'}`;
    if (!/^Mozilla\/5\.0\b/.test(ua) || !/\b(Chrome|Chromium)\/[\d.]+/.test(ua)) {
      return {
        error:
          `port ${DEBUG_PORT} is held by something that speaks CDP but is NOT a browser you can ` +
          `sign into — it reports ${identity}. An embedded WebView (Lenovo Vantage, Teams, an ` +
          `Electron app) will let Lighthouse attach and produce a score for a page that is not ` +
          `your app. Close it or free the port, then launch a real browser`,
        identity,
      };
    }
    return { error: null, identity };
  } catch (err: unknown) {
    return {
      error: `nothing usable is listening on port ${DEBUG_PORT} (${err instanceof Error ? err.message : String(err)})`,
      identity,
    };
  }
}

/** Does `npx lighthouse` resolve and run at all? */
function probeLighthouse(): string | null {
  const { code, out, spawnError } = runNpx(['lighthouse', '--version'], NPX_PROBE_TIMEOUT_MS);
  if (spawnError) return `could not spawn npx: ${spawnError.message}`;
  if (code !== 0) return `\`npx lighthouse --version\` exited ${code}:\n${out.trim().slice(0, 800)}`;
  return null;
}

// ---------------------------------------------------------------------------
// One surface.
// ---------------------------------------------------------------------------

interface FailingAudit {
  id: string;
  weight: number;
  title: string;
}

interface Report {
  score: number;
  failing: FailingAudit[];
}

function auditSurface(base: string, surface: Surface, selfLaunch: boolean): Report | null {
  const url = `${base}${surface.path}`;
  const outPath = `./.a11y/${surface.slug}.json`;

  const attachArgs = selfLaunch
    ? [
        // Self-launch: Lighthouse starts its own headless Chromium on an
        // ephemeral port with a fresh profile. No --port, and no
        // --disable-storage-reset — there is no session to preserve, and a fresh
        // profile is signed out by construction, which is exactly what an
        // ANONYMOUS surface wants. Guarded upstream so this can never be used on
        // a surface that requires a session.
        '--chrome-flags=--headless=new --no-sandbox',
      ]
    : [
        `--port=${DEBUG_PORT}`,
        // MANDATORY. Lighthouse clears cookies and storage by default, which signs
        // the debug profile out before the first AUTHENTICATED surface is reached —
        // the paywall, settings, chat and stats runs would then all silently audit
        // a redirect to the landing page and could even report a passing score for
        // a screen that never rendered.
        '--disable-storage-reset',
      ];

  const absOut = path.join(OUT_DIR, `${surface.slug}.json`);

  // Delete any previous report for this slug FIRST. The output path is
  // deterministic per surface, so a leftover file from an earlier run against a
  // different base URL could otherwise be read back as this run's result. The
  // requestedUrl check below is the real guard; this just removes the trap.
  rmSync(absOut, { force: true });

  const { code, out, spawnError } = runNpx(
    [
      'lighthouse',
      url,
      ...attachArgs,
      '--only-categories=accessibility',
      '--output=json',
      `--output-path=${outPath}`,
      '--quiet',
    ],
    LIGHTHOUSE_TIMEOUT_MS,
  );

  if (spawnError) {
    fail(`${surface.slug}: could not spawn npx lighthouse — ${spawnError.message}`);
    return null;
  }

  let parsed: unknown;
  let readError: string | null = null;
  try {
    parsed = JSON.parse(readFileSync(absOut, 'utf8'));
  } catch (err: unknown) {
    readError = err instanceof Error ? err.message : String(err);
  }

  const lhr = parsed as
    | {
        requestedUrl?: unknown;
        categories?: { accessibility?: { score?: unknown; auditRefs?: { id: string; weight: number }[] } };
        audits?: Record<string, { score?: unknown; title?: unknown; scoreDisplayMode?: unknown }>;
      }
    | undefined;
  const rawScore = lhr?.categories?.accessibility?.score;
  const haveScore = typeof rawScore === 'number';

  /**
   * A non-zero exit does NOT always mean "no measurement". `chrome-launcher`
   * tears its temp profile down AFTER the report is written, and on Windows that
   * `rmSync` routinely fails with EPERM because the browser still holds the
   * directory — Lighthouse then exits 1 having already produced a complete,
   * valid report. Discarding that measurement is a false negative that would
   * make this gate unrunnable on the machine it has to run on.
   *
   * So the exit code is not the authority; the REPORT is. A salvaged run must
   * still clear every check a clean run does — the file parses, it carries a
   * numeric accessibility score, and (below) its requestedUrl is the URL we
   * asked for — and the non-zero exit is surfaced as a warning either way, so a
   * genuine Lighthouse error can never pass silently.
   */
  if (!haveScore) {
    fail(
      `${surface.slug}: no usable report for ${url}. lighthouse exited ${code}` +
        (readError !== null
          ? `; ${outPath} is missing or unparseable — ${readError}`
          : `; ${outPath} has no numeric categories.accessibility.score (got ${JSON.stringify(rawScore)})`) +
        `\n${out.trim().slice(0, 1200)}`,
    );
    return null;
  }

  // The report must be ABOUT the URL we requested. This is what makes the
  // salvage path above safe, and it also catches a stale report generally.
  if (lhr?.requestedUrl !== url) {
    fail(
      `${surface.slug}: ${outPath} reports requestedUrl ${JSON.stringify(lhr?.requestedUrl)} but ` +
        `this run asked for ${JSON.stringify(url)} — refusing to record a score for a different page`,
    );
    return null;
  }

  if (code !== 0) {
    console.log(
      `  WARNING: lighthouse exited ${code} but wrote a complete report for the requested URL — ` +
        `recording the score. Tail: ${out.trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''}`,
    );
  }
  const score = Math.round(rawScore * 100);

  // Weights live on categories.accessibility.auditRefs, NOT on the audit itself.
  const weightById = new Map<string, number>();
  for (const ref of lhr.categories?.accessibility?.auditRefs ?? []) {
    weightById.set(ref.id, ref.weight);
  }
  const failing: FailingAudit[] = [];
  for (const [id, audit] of Object.entries(lhr.audits ?? {})) {
    // score === null means informative / notApplicable / manual — score-neutral.
    if (typeof audit.score !== 'number' || audit.score >= 1) continue;
    if (!weightById.has(id)) continue; // not part of the accessibility category
    failing.push({
      id,
      weight: weightById.get(id) ?? 0,
      title: typeof audit.title === 'string' ? audit.title : id,
    });
  }
  failing.sort((a, b) => b.weight - a.weight);

  return { score, failing };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function parseOnly(): string | null {
  for (const arg of process.argv.slice(2)) {
    const m = /^--only=(.+)$/.exec(arg);
    if (m) return m[1];
  }
  return null;
}

const KNOWN_FLAGS = /^(--only=.+|--self-launch)$/;

async function main(): Promise<void> {
  for (const arg of process.argv.slice(2)) {
    if (!KNOWN_FLAGS.test(arg)) {
      throw new Error(`unknown argument ${JSON.stringify(arg)}. Usage: [--only=<slug>] [--self-launch]`);
    }
  }
  const only = parseOnly();
  const selfLaunch = process.argv.slice(2).includes('--self-launch');
  const known = SURFACES.map((s) => s.slug);
  if (only !== null && !known.includes(only)) {
    throw new Error(`--only=${only} is not a known surface. Known slugs: ${known.join(', ')}`);
  }

  const base = normaliseBase(requireEnv('A11Y_BASE_URL', 'NEXT_PUBLIC_SITE_HOST'));

  // The chat surface needs an id. Resolve it lazily: a `--only=landing` probe
  // must not be blocked by an env var it does not use.
  const selected = SURFACES.filter((s) => only === null || s.slug === only);
  const surfaces: Surface[] = selected.map((s) =>
    s.slug === 'chat' ? { ...s, path: `/app/c/${requireEnv('A11Y_CHAT_ID')}` } : s,
  );

  console.log(`a11y gate — base ${base}, threshold ${THRESHOLD}`);
  console.log(
    only === null
      ? `auditing all ${surfaces.length} D-69 surface(s)`
      : `auditing 1 surface (--only=${only}) of ${SURFACES.length}`,
  );

  console.log('prerequisites:');
  if (selfLaunch) {
    // THE GUARD that keeps --self-launch from becoming a fail-open. A freshly
    // launched browser holds no session, so an authenticated surface would follow
    // the layout guard's redirect and Lighthouse would score the LANDING page
    // while the report is filed under `paywall` / `settings` / `chat` / `stats`.
    // That is threat T-04-08 exactly, and it would score WELL. Refuse instead.
    const sessioned = surfaces.filter((s) => s.requires !== 'anon');
    if (sessioned.length > 0) {
      throw new Error(
        `--self-launch audits a FRESH, signed-out browser, so it is only valid for anonymous ` +
          `surfaces. Refusing: ${sessioned.map((s) => `${s.slug} (${s.requires})`).join(', ')}. ` +
          `Those would silently audit the signed-out redirect target and report a passing score ` +
          `for a screen that never rendered. Use the debug-profile route (no --self-launch) for them.`,
      );
    }
    pass(
      `self-launch mode: lighthouse will start its own headless Chromium with a fresh, signed-out ` +
        `profile (${surfaces.length} anonymous surface(s) only)`,
    );
    if (process.env.CHROME_PATH) {
      pass(`CHROME_PATH is set — lighthouse will use ${process.env.CHROME_PATH}`);
    }
  } else {
    const port = await probeDebugPort();
    if (port.error !== null) {
      throw new Error(
        `${port.error}\n\n` +
          `Launch a debug Chrome and sign in through real OAuth in that window first:\n\n` +
          `    ${CHROME_LAUNCH_LINE}\n\n` +
          `For an ANONYMOUS surface you can skip the sign-in entirely with --self-launch.\n\n` +
          `${DEVTOOLS_FALLBACK}`,
      );
    }
    pass(`a real browser is listening on port ${DEBUG_PORT}: ${port.identity}`);
  }

  const lighthouseProblem = probeLighthouse();
  if (lighthouseProblem !== null) {
    throw new Error(
      `npx lighthouse is not runnable: ${lighthouseProblem}\n\n` +
        `Lighthouse is deliberately NOT a package.json dependency — it is fetched transiently by ` +
        `npx. Check network access, or use the DevTools panel instead.\n\n${DEVTOOLS_FALLBACK}`,
    );
  }
  pass('npx lighthouse resolves and runs');

  mkdirSync(OUT_DIR, { recursive: true });

  const scored: { surface: Surface; report: Report }[] = [];
  for (const surface of surfaces) {
    console.log(`\n${surface.slug} (${surface.requires}) — ${base}${surface.path}`);
    console.log(`  ${surface.what}`);
    if (surface.requires !== 'anon') {
      console.log(`  NOTE: the debug browser must currently hold a ${surface.requires}.`);
    }
    const report = auditSurface(base, surface, selfLaunch);
    if (report === null) continue;
    scored.push({ surface, report });

    console.log(`  score ${report.score} (threshold ${THRESHOLD}) -> .a11y/${surface.slug}.json`);
    if (report.failing.length > 0) {
      // Printed whether or not the surface passes: a weight-0 failing audit does
      // not move the score but is still a real defect worth reading.
      console.log(`  failing audits (${report.failing.length}), heaviest first:`);
      for (const a of report.failing) {
        console.log(`    - ${a.id} (weight ${a.weight}) — ${a.title}`);
      }
    }
    if (report.score < THRESHOLD) {
      fail(
        `${surface.slug} scored ${report.score}, below the locked D-69 threshold of ${THRESHOLD}. ` +
          `Failing audits: ${
            report.failing.map((a) => `${a.id}(w${a.weight})`).join(', ') || 'none reported'
          }. Do NOT lower the threshold — fix the audits, or escalate the residual as a documented exception.`,
      );
    } else {
      pass(`${surface.slug} scored ${report.score} >= ${THRESHOLD}`);
    }
  }

  console.log('');
  for (const { surface, report } of scored) {
    console.log(`  ${surface.slug.padEnd(11)} ${String(report.score).padStart(3)}  (${surface.requires})`);
  }

  if (failures.length > 0) {
    console.error(`\nA11Y AUDIT FAILED (${failures.length} assertion(s)):`);
    for (const f of failures) console.error(` - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nA11Y AUDIT PASSED: ${scored.length} surface(s) all scored >= ${THRESHOLD} on the Lighthouse ` +
      `accessibility category, driven over ` +
      (selfLaunch
        ? `a self-launched, signed-out headless Chromium (anonymous surfaces only)`
        : `the signed-in debug profile on port ${DEBUG_PORT}`) +
      `. Reports are in .a11y/ (gitignored). Remember that this score cannot see :hover/:focus ` +
      `contrast, focus order, the drawer trap or reduced-motion behaviour — D-69's manual half ` +
      `still has to be walked.`,
  );
}

main().catch((err: unknown) => {
  console.error('A11Y AUDIT ERROR:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
