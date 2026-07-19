/**
 * scripts/auth-guard.test.ts — AUTH-03 redirect regression (Wave 0 test infra).
 *
 * Asserts, against a running app, that a request to a session-guarded (app)
 * path WITHOUT any auth cookie is redirected to the landing page `/`. This is
 * the automated half of AUTH-03 (the authoritative guard lives in the (app)
 * layout, app/app/layout.tsx); the manual proof on the deployed URL is Plan
 * 01-05's D-10 gate.
 *
 * Run: `npm run test:guard` (node runs this .ts directly via type-stripping).
 * Config from env (never hard-coded secrets):
 *   - BASE_URL   — origin of the running app (default http://localhost:3000)
 *   - GUARD_PATH — the (app)-group path to probe (default /app)
 *
 * DEFERRED: cannot pass until a dev/preview/deployed server is running
 * (Plan 01-02 provisioning + `next dev`/Plan 01-05 deploy). Exits non-zero on a
 * failed assertion, zero on the expected unauthenticated redirect.
 */

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);
const GUARD_PATH = process.env.GUARD_PATH ?? "/app";

// Next.js issues 307 (temporary) for redirect(); accept the full redirect set so
// the assertion is resilient to the exact status code the runtime picks.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function fail(message: string): never {
  console.error(`AUTH-03 guard check FAILED: ${message}`);
  process.exit(1);
}

async function main() {
  const target = `${BASE_URL}${GUARD_PATH}`;
  console.log(`AUTH-03 guard check: GET ${target} with no session cookie…`);

  let res: Response;
  try {
    // redirect: "manual" so fetch surfaces the 3xx itself instead of following
    // it to the landing page (which would return 200 and hide the redirect).
    res = await fetch(target, { redirect: "manual", headers: {} });
  } catch (err) {
    fail(
      `could not reach ${target} — is the app running? ` +
        `Set BASE_URL to a live dev/preview/deployed origin. (${String(err)})`,
    );
  }

  // undici returns the real 3xx (status + Location) under redirect:"manual";
  // some runtimes instead return an opaque redirect (status 0 / type
  // "opaqueredirect"). Treat either as a redirect and, when readable, verify the
  // Location resolves to the landing page "/".
  const isOpaque = res.status === 0 || res.type === "opaqueredirect";
  const isRedirectStatus = REDIRECT_STATUSES.has(res.status);

  if (!isOpaque && !isRedirectStatus) {
    fail(
      `expected a redirect to "/" but got HTTP ${res.status}. An unauthenticated ` +
        `request to a guarded path must not receive a 200.`,
    );
  }

  const location = res.headers.get("location");
  if (location !== null) {
    const resolved = new URL(location, BASE_URL);
    if (resolved.pathname !== "/") {
      fail(
        `redirect Location resolved to "${resolved.pathname}", expected "/".`,
      );
    }
  }

  console.log(
    `AUTH-03 guard check PASSED: unauthenticated ${GUARD_PATH} → redirect to /` +
      (location ? ` (Location: ${location})` : " (opaque redirect)"),
  );
  process.exit(0);
}

void main();
