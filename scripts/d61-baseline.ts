/**
 * scripts/d61-baseline.ts — drive the D-61 replay harness over CDP and record
 * the five baseline numbers (04-03 Task 3).
 *
 * WHY THIS SCRIPT EXISTS AT ALL. The harness in `components/chat/stream-replay.ts`
 * is triggerable by hand from a devtools console, and for one measurement that
 * would be enough. It is not enough for this measurement, for two reasons:
 *
 *   1. Plan 04-05 re-measures on THIS fixture and plan 04-07 takes or declines
 *      the rung-3 escalation on the delta between the two numbers. A procedure
 *      that lives in a SUMMARY paragraph is a procedure that drifts; a procedure
 *      that lives in a script re-runs unchanged. `npm run d61:baseline` is the
 *      whole contract.
 *   2. Numbers read off a console and retyped into a document are numbers with a
 *      transcription error in their future. This writes JSON.
 *
 * ── PREREQUISITES ─────────────────────────────────────────────────────────────
 * 1. The dev server running (`npm run dev`). The harness is gated on
 *    `NODE_ENV !== "production"`, so a production build produces nothing — that
 *    is the point of GATE 1, not an obstacle to work around.
 * 2. A browser listening for CDP, launched by the operator and SIGNED IN:
 *
 *      chrome --remote-debugging-port=9222 --user-data-dir=/tmp/mm-d61-profile
 *
 *    then sign in at http://localhost:3000 in that window. This mirrors the
 *    documented prerequisite of `scripts/a11y-audit.ts`: the session never
 *    leaves the browser's own profile and this script never reads a cookie.
 *
 * ── INVOCATION ────────────────────────────────────────────────────────────────
 *      node --env-file-if-exists=.env.local scripts/d61-baseline.ts
 *
 * Deliberately NOT an npm script yet: plan 04-14 owns the phase's npm script
 * aliases, and `package.json` is a shared write target this plan is prohibited
 * from touching. 04-14 registers `d61:baseline`; until then the full command
 * above IS the reproducible invocation, and plan 04-05 must re-run it unchanged
 * for its after-numbers to be comparable.
 * 3. NO env var is required. The default target is `/app/c/new`, which renders
 *    `ChatThread` with no chat and no history (`app/app/c/[chatId]/page.tsx:57`)
 *    — the cleanest possible baseline, since a pre-existing thread would add
 *    unrelated rows to every commit and make two runs on different accounts
 *    incomparable. The fixture replays into a LOCAL-ONLY assistant row: nothing
 *    is persisted, no run starts, no credit moves.
 *    Optional: `D61_CHAT_ID` (measure inside a real chat instead — record it
 *    alongside the numbers, because the thread contents become part of the
 *    experiment), `D61_BASE_URL` (default http://localhost:3000), `D61_PORT`
 *    (default 9222), `D61_LABEL` (default BEFORE).
 *
 * ── THE TWO LESSONS THIS SCRIPT IS BUILT AROUND ──────────────────────────────
 * Both were paid for in plan 04-02 and both apply here exactly.
 *
 * (a) A MEASUREMENT TOOL'S PREREQUISITE CHECK IS PART OF THE MEASUREMENT.
 *     04-02's port probe accepted port 9222 on the presence of a `Browser`
 *     string alone and attached Lighthouse to LENOVO VANTAGE's embedded WebView,
 *     then reported a confident 100. `Browser` proves the PROTOCOL answered;
 *     `User-Agent` names the COUNTERPARTY. This script asserts on the
 *     User-Agent, rejects embedded WebViews by name, and PRINTS the identity it
 *     found either way — an unprinted identity check is a check nobody audits.
 *
 * (b) VERIFY THE ARTEFACT UNDER TEST IS YOURS BEFORE BELIEVING A NUMBER ABOUT
 *     IT. 04-02 scored a stranger's deployment for a while. Here the tell is
 *     free: `window.__mmReplay` is a function ONLY if this repo's bundle is
 *     loaded AND both harness gates passed. If it is missing, the script says
 *     which of the three possible causes to check rather than reporting a zero.
 */

import { writeFileSync, mkdirSync } from "node:fs";

const BASE_URL = (process.env.D61_BASE_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const PORT = process.env.D61_PORT ?? "9222";
const CHAT_ID = process.env.D61_CHAT_ID ?? "";
const LABEL = process.env.D61_LABEL ?? "BEFORE";
const OUT_DIR = ".d61";

/** Generous: the fixture is ~8 650 deltas at 120/sec ≈ 72 s, and the whole
 *  point of the measurement is that the render path might not keep up. */
const REPLAY_TIMEOUT_MS = 300_000;

/**
 * Fail with a diagnosis. THROWS rather than calling `process.exit`: an
 * immediate exit while undici's keep-alive socket or the CDP WebSocket is still
 * open aborts libuv on Windows ("Assertion failed: !(handle->flags &
 * UV_HANDLE_CLOSING)"), which prints a crash dump UNDERNEATH the diagnosis and
 * makes a correctly-detected prerequisite failure look like a broken script.
 * Same family as 04-02's chrome-launcher EPERM teardown: the tool's own exit
 * path is part of the tool. The top-level catch sets `process.exitCode` and lets
 * node close its handles.
 */
class PrereqFailure extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "PrereqFailure";
    this.hint = hint;
  }
}

function die(message: string, hint?: string): never {
  throw new PrereqFailure(message, hint);
}

/**
 * Embedded WebViews that answer CDP on a shared port. Named rather than
 * pattern-guessed, because the failure mode is a CONFIDENT number from the wrong
 * process and a vague heuristic would let the next one through silently.
 */
const WEBVIEW_MARKERS = [
  "LenovoVantage",
  "Teams",
  "Electron",
  "Slack",
  "Discord",
  "WebView2",
  "HeadlessChrome/0",
];

async function cdpVersion(): Promise<{ browser: string; userAgent: string }> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  } catch {
    die(
      `nothing is listening for CDP on port ${PORT}`,
      "Launch a debug browser first:\n" +
        `  chrome --remote-debugging-port=${PORT} --user-data-dir=/tmp/mm-d61-profile\n` +
        `then sign in at ${BASE_URL} in that window.`,
    );
  }
  const body = (await res.json()) as Record<string, string>;
  const browser = body.Browser ?? "";
  const userAgent = body["User-Agent"] ?? "";
  // ALWAYS printed — see lesson (a) in the header.
  console.log(`CDP counterparty on :${PORT}`);
  console.log(`  Browser:    ${browser || "(absent)"}`);
  console.log(`  User-Agent: ${userAgent || "(absent)"}`);
  if (!userAgent) {
    die(
      `the endpoint on port ${PORT} reports no User-Agent`,
      "A CDP endpoint that will not name itself is not a browser this script " +
        "will measure. `Browser` alone proves only that something answered.",
    );
  }
  const marker = WEBVIEW_MARKERS.find((m) => userAgent.includes(m));
  if (marker) {
    die(
      `port ${PORT} is an embedded WebView (User-Agent contains "${marker}"), not a real browser`,
      "This is the exact 04-02 trap: an embedded WebView answers CDP and " +
        "produces a confident number about a page nobody is looking at. " +
        "Close it or launch the debug browser on a different port (D61_PORT).",
    );
  }
  return { browser, userAgent };
}

interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

async function resolvePageTarget(url: string): Promise<CdpTarget> {
  const list = (await (
    await fetch(`http://127.0.0.1:${PORT}/json/list`)
  ).json()) as CdpTarget[];
  const existing = list.find(
    (t) => t.type === "page" && t.url.startsWith(BASE_URL) && t.webSocketDebuggerUrl,
  );
  if (existing) return existing;
  const created = (await (
    await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, {
      method: "PUT",
    })
  ).json()) as CdpTarget;
  if (!created.webSocketDebuggerUrl) {
    die("could not open a page target on the debug browser");
  }
  return created;
}

/** Minimal CDP client over the global WebSocket (Node 22+). No new dependency. */
class Cdp {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof msg.id !== "number") return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message));
      else slot.resolve(msg.result);
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  close(): void {
    this.ws.close();
  }
}

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evaluate(
  cdp: Cdp,
  expression: string,
  awaitPromise = false,
): Promise<unknown> {
  const res = (await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  })) as EvalResult;
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ??
        res.exceptionDetails.text ??
        "evaluation threw",
    );
  }
  return res.result?.value;
}

async function main(): Promise<void> {
  // `new` renders ChatThread with no chat and no history, which is the cleanest
  // baseline available: an existing thread contributes unrelated rows to every
  // commit, so two runs against two different chats are not comparable.
  const chatSegment = CHAT_ID || "new";

  // Prerequisite 1: the dev server. Checked before the browser so a missing
  // server is not diagnosed as a browser problem.
  try {
    const probe = await fetch(BASE_URL, { redirect: "manual" });
    console.log(`Dev server at ${BASE_URL}: HTTP ${probe.status}`);
  } catch {
    die(
      `no server is answering at ${BASE_URL}`,
      "Start it with `npm run dev`. A production build cannot be measured: the " +
        "harness is gated on NODE_ENV !== 'production' by design.",
    );
  }

  await cdpVersion();

  const target = await resolvePageTarget(BASE_URL);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl as string);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const url = `${BASE_URL}/app/c/${chatSegment}?mmReplay=1`;
  console.log(`\nNavigating to ${url}`);
  await cdp.send("Page.navigate", { url });
  // The harness arms in a post-hydration effect, so poll for it rather than
  // guessing a settle delay.
  let armed = false;
  const landedAt = Date.now();
  let landedUrl = "";
  while (Date.now() - landedAt < 30_000) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      landedUrl = String(await evaluate(cdp, "location.href"));
      armed = (await evaluate(cdp, "typeof window.__mmReplay === 'function'")) === true;
    } catch {
      /* still navigating */
    }
    if (armed) break;
  }
  console.log(`Landed on: ${landedUrl}`);

  // Lesson (b): prove the artefact under test is ours before believing a number.
  if (!armed) {
    const signedOut = !landedUrl.includes(`/app/c/${chatSegment}`);
    die(
      "window.__mmReplay is not a function — the harness is not armed",
      signedOut
        ? `The browser landed on ${landedUrl} instead of the chat, so that ` +
            "profile is NOT signed in. Sign in at " +
            `${BASE_URL} in the debug browser window and re-run.`
        : "Three possible causes, in order of likelihood:\n" +
            "  1. the page is served by a PRODUCTION build (GATE 1 returns false)\n" +
            "  2. ?mmReplay=1 was stripped from the URL (GATE 2)\n" +
            "  3. the bundle loaded is not this repo's — check the tab's origin",
    );
  }
  console.log("Harness armed (both gates passed on this bundle).\n");

  console.log("Replaying the fixture — this takes ~75s at the declared cadence…");
  const report = (await Promise.race([
    evaluate(cdp, "window.__mmReplay()", true),
    new Promise((_r, reject) =>
      setTimeout(
        () => reject(new Error("replay did not finish within the timeout")),
        REPLAY_TIMEOUT_MS,
      ),
    ),
  ])) as Record<string, unknown>;

  cdp.close();

  const record: Record<string, unknown> = {
    ...report,
    label: LABEL,
    measuredAt: new Date().toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const out = `${OUT_DIR}/${String(LABEL).toLowerCase()}.json`;
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`\n──── D-61 ${LABEL} baseline ────`);
  console.log(
    `fixture              ${record.fixture} (${record.fixtureChars} chars) on /app/c/${chatSegment}`,
  );
  console.log(
    `cadence              ${record.targetDeltasPerSecond}/s declared, ${record.chunkChars} chars/delta`,
  );
  console.log(`deltas received      ${record.deltas}`);
  console.log(`deltas per second    ${record.deltasPerSecond} (achieved)`);
  console.log(`React commits        ${record.commits}  (deltas/commit ${record.deltasPerCommit})`);
  console.log(
    `commit ms, final 3rd median ${record.medianCommitMs} · p95 ${record.p95CommitMs}  (n=${record.finalThirdSamples} of ${record.paintSamples})`,
  );
  console.log(`total long-task ms   ${record.longTaskMs}  (${record.longTasks} tasks)`);
  console.log(`elapsed              ${record.elapsedMs} ms`);
  console.log(`\nwritten to ${out}`);

  const median = Number(record.medianCommitMs);
  console.log(
    median > 16
      ? `\nThreshold: median ${median} ms EXCEEDS the locked 16 ms bar.`
      : `\nThreshold: median ${median} ms is within the locked 16 ms bar.`,
  );
}

try {
  await main();
} catch (err) {
  if (err instanceof PrereqFailure) {
    console.error(`\nFAILED: ${err.message}`);
    if (err.hint) console.error(`\n${err.hint}`);
  } else {
    console.error(`\nFAILED: ${(err as Error).message}`);
  }
  process.exitCode = 1;
}
