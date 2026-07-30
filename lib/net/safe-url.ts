/**
 * lib/net/safe-url.ts — THE single public-http(s) SSRF predicate.
 *
 * Hoisted out of `lib/agent/tools/fetch-page.ts` (review CR-02/CR-03) so that
 * every outbound-request boundary shares ONE implementation. The previous
 * arrangement — one copy in the tool, a prose claim of a guard on the key
 * routes — is exactly what let an unreachable dead regex sit in the tool for a
 * whole phase while `/api/keys` had no gate at all. Do not fork this file:
 * import it.
 *
 * Zero dependencies on purpose — route handlers must be able to import this
 * without dragging in linkedom / @mozilla/readability.
 *
 * WHAT IT REJECTS
 *   - any scheme other than http: / https:
 *   - `localhost` and `*.localhost`
 *   - private / loopback / link-local / CGNAT / reserved IPv4, incl. the cloud
 *     metadata IP — but NOT the documentation ranges, which are not SSRF targets
 *   - the IPv6 equivalents, range-checked NUMERICALLY (see isPrivateIPv6)
 *
 * ACCEPTED RESIDUAL RISK: DNS rebinding — a public hostname that resolves to a
 * private address at connect time still passes (T-02-05-01, ASVS L1). This is
 * a name-based gate, not a connect-time one.
 */

/**
 * Private / loopback / link-local / reserved IPv4, given a dotted-quad literal.
 *
 * The ranges below are limited to space that is either genuinely
 * routable-internal or not globally routable at all. The documentation ranges
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24) are deliberately NOT here —
 * they are not SSRF targets, and blocking them would be over-blocking.
 */
export function isPrivateIPv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) return false; // not a valid v4 literal
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  // Carrier-grade NAT (RFC 6598) — real cloud/carrier internal space, and the
  // gap that kept http://100.64.1.1/ dialable after the first round of fixes.
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
  if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
  if (a >= 240) return true; // reserved 240.0.0.0/4, incl. 255.255.255.255
  return false;
}

/**
 * Expand an IPv6 literal to its 8 numeric hextets, or null when `input` is not
 * a well-formed IPv6 literal.
 *
 * This exists because STRING matching on IPv6 does not work. `new URL()`
 * re-serialises every literal into the WHATWG canonical form before we ever
 * see `hostname`, so the human spellings an attacker types are not the ones
 * that reach the predicate:
 *
 *   http://[0:0:0:0:0:ffff:127.0.0.1]/  ->  hostname [::ffff:7f00:1]
 *   http://[::ffff:127.0.0.1]/          ->  hostname [::ffff:7f00:1]
 *   http://[::127.0.0.1]/               ->  hostname [::7f00:1]
 *
 * i.e. a dotted-quad IPv4-mapped regex is UNREACHABLE dead code. Parse, then
 * range-check integers.
 */
export function ipv6Hextets(input: string): number[] | null {
  let x = input.toLowerCase();
  if (!x.includes(":")) return null;
  if (/[^0-9a-f:.]/.test(x)) return null; // zone ids, garbage

  // Fold a trailing embedded dotted-quad into two hextets so the rest of the
  // parse only ever deals with hex groups.
  if (x.includes(".")) {
    const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(x);
    if (!dotted) return null;
    const o = dotted.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    const hi = (((o[0] << 8) | o[1]) >>> 0).toString(16);
    const lo = (((o[2] << 8) | o[3]) >>> 0).toString(16);
    x = `${x.slice(0, dotted.index)}${hi}:${lo}`;
  }

  const halves = x.split("::");
  if (halves.length > 2) return null; // "::" may appear at most once
  const groups = (s: string): string[] => (s.length > 0 ? s.split(":") : []);

  let parts: string[];
  if (halves.length === 2) {
    const head = groups(halves[0]);
    const tail = groups(halves[1]);
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null; // "::" must stand for >= 1 zero group
    parts = [...head, ...(Array<string>(fill).fill("0")), ...tail];
  } else {
    parts = groups(x);
  }
  if (parts.length !== 8) return null;

  const out: number[] = [];
  for (const p of parts) {
    if (p.length === 0 || p.length > 4) return null;
    const n = Number.parseInt(p, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    out.push(n);
  }
  return out;
}

/** Private / loopback / link-local IPv6, range-checked numerically. */
export function isPrivateIPv6(host: string): boolean {
  const g = ipv6Hextets(host);
  if (!g) return false;

  if (g.every((n) => n === 0)) return true; // :: (unspecified)
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1

  // fe80::/10 spans fe80–febf — the FULL range, not the "fe80" string prefix
  // (http://[febf::1]/ used to sail straight through).
  if ((g[0] & 0xffc0) === 0xfe80) return true;
  // fc00::/7 — unique local (fc.. and fd..).
  if ((g[0] & 0xfe00) === 0xfc00) return true;

  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 — delegate the
  // embedded v4 address to the v4 predicate so the two stay in agreement.
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const embedded = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPrivateIPv4(embedded);
  }
  return false;
}

/**
 * True only for a public http(s) URL. The gate in front of EVERY outbound
 * request built from user- or model-supplied input.
 */
export function isSafeUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;

  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;

  // URL.hostname keeps IPv6 in brackets — strip them before range checks.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isPrivateIPv4(bare)) return false;
  if (isPrivateIPv6(bare)) return false;

  return true;
}
