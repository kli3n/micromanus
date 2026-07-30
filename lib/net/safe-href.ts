/**
 * lib/net/safe-href.ts — THE single RENDER-boundary href scheme allow-list.
 *
 * DELIBERATELY SEPARATE FROM lib/net/safe-url.ts — DO NOT MERGE THE TWO.
 * They answer different questions and must keep different answers:
 *
 *   - `safe-url.ts` is the SSRF NETWORK-TARGET gate: may the SERVER fetch this?
 *     It additionally rejects localhost, private / loopback / link-local / CGNAT
 *     and reserved IPv4+IPv6 space, including the cloud metadata IP.
 *   - `safe-href.ts` is the RENDER gate: may this string become an href the USER
 *     clicks? Only the scheme matters. A link to http://192.168.1.10/router is a
 *     perfectly legitimate page for a human to open, so running a display link
 *     through the SSRF predicate would wrongly refuse to LINK it.
 *
 * Reusing either one for the other's job is a bug in both directions. The
 * CR-01/CR-02 lesson was that FORKED predicates rot, so this split is stated
 * here rather than left implicit — and, being stated, the predicate itself exists
 * exactly ONCE and is imported by both render surfaces (the chat Sources list and
 * the PDF bibliography), which is what stops those two from drifting apart.
 *
 * WHY IT IS NEEDED (review WR-08): the urls in a numbered Sources row come off a
 * PERSISTED `role='tool'` row, written by an earlier deploy from a model-supplied
 * value. Every other Phase-3 read treats such rows as untrusted (T-3-60), yet at
 * the anchor only React's built-in URL heuristic stood between a persisted
 * `javascript:` value and a click.
 *
 * PLAIN module with ZERO imports on purpose: the PDF renderer lives behind the
 * Chromium quarantine (D-12) and a client component may not reach into it, so the
 * shared seam has to be importable from both sides with nothing attached.
 */

/**
 * True only for an explicit http: or https: url.
 *
 * Whitespace is trimmed BEFORE matching and the scheme is matched
 * case-insensitively, and the `//` is required — those are the three standard
 * bypasses (`"  javascript:…"`, `"JavaScript:…"`, `"//evil.example/x"`), each
 * pinned by a named test in tests/safe-href.test.ts. Everything else — data:,
 * vbscript:, file:, ftp:, protocol-relative, bare paths, the empty string —
 * is rejected, and the caller renders inert text instead of an anchor.
 */
export function isSafeHref(url: string): boolean {
  if (typeof url !== "string") return false;
  return /^https?:\/\//i.test(url.trim());
}
