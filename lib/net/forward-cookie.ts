/**
 * lib/net/forward-cookie.ts — narrow the `Cookie` header forwarded on the
 * deferred-render self-fetch (03-REVIEW-FIX.md residual #2 / T-03-12-02).
 *
 * ZERO IMPORTS, pure string work — a node-env Vitest run pins it directly.
 *
 * WHAT THIS IS NOT. This is the THIRD distinct question about a URL in this
 * codebase and must not be conflated with the other two:
 *   - `lib/net/safe-url.ts`  — the SSRF gate on network targets the SERVER fetches.
 *   - `lib/net/safe-href.ts` — the render-boundary predicate for hrefs the USER clicks.
 *   - here                   — WHICH CREDENTIALS ride along on a request whose
 *                              destination `originOf` has already vouched for.
 * `originOf` (CR-04) decides WHERE the report body may go; this decides WHAT
 * goes with it. Neither weakens the other.
 *
 * WHY IT IS ONLY NOW SAFE. This narrowing was DELIBERATELY DECLINED in
 * 03-REVIEW-FIX.md ("Two hardening notes deliberately not taken") on the stated
 * grounds that an allowlist here is a plausible way to break authenticated PDF
 * rendering in production, because the incoming header does double duty (D-47)
 * and carries two mechanisms whose shapes are easy to get wrong:
 *
 *   1. Supabase's auth cookie is CHUNKED. @supabase/ssr splits a session that
 *      exceeds the ~4KB per-cookie limit across `sb-<ref>-auth-token.0`,
 *      `.1`, … and the server client needs EVERY chunk to reassemble the
 *      session — the render route's own auth check (D-40) 401s on a partial
 *      set. The project ref is also deployment-specific. So an exact-name
 *      allowlist would break authenticated rendering exactly as warned; the
 *      family is therefore matched by the `sb-` PREFIX, which is a superset of
 *      every chunk of every project ref.
 *   2. `_vercel_jwt` is Vercel Deployment Protection's bypass credential. Drop
 *      it and Standard Protection 401s the self-call (the Correction C3 failure
 *      mode) — so it is kept by exact name.
 *
 * Because the filter KEEPS a superset of both known mechanisms, it cannot break
 * the path the fixer was protecting: it can only drop cookies neither mechanism
 * uses (analytics, third-party, unrelated app cookies). That is what makes the
 * previously-declined narrowing safe to take now, and
 * `tests/forward-cookie.test.ts` pins both directions.
 *
 * Matching is by PREFIX / EXACT NAME, never substring — a lookalike such as
 * `not-sb-auth-token` must not ride along. Order and values are preserved
 * byte-for-byte: no re-encoding, no trimming of values, and only the FIRST `=`
 * separates a name from its value.
 *
 * Never log the input, the output, or any individual cookie value.
 */

/** Cookie-name prefixes that are forwarded (covers the chunked Supabase set). */
const ALLOWED_PREFIXES = ["sb-"] as const;

/** Cookie names forwarded by exact match. */
const ALLOWED_EXACT = ["_vercel_jwt"] as const;

/** Whether a cookie NAME is one the render route provably needs. */
function isForwardable(name: string): boolean {
  if (ALLOWED_EXACT.includes(name as (typeof ALLOWED_EXACT)[number])) return true;
  return ALLOWED_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Narrow a raw incoming `Cookie` header to the allowlisted families.
 * Returns `""` for a missing, empty or fully-filtered header — never throws.
 */
export function filterForwardedCookies(header: string | null | undefined): string {
  if (!header) return "";
  const kept: string[] = [];
  for (const segment of header.split(";")) {
    // Trim only the SEGMENT's surrounding whitespace (the `; ` separator's own
    // padding). The value itself is taken verbatim after the first `=`.
    const pair = segment.trim();
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue; // no name, or no `=` at all — malformed, skip
    const name = pair.slice(0, eq);
    if (!isForwardable(name)) continue;
    kept.push(pair);
  }
  return kept.join("; ");
}
