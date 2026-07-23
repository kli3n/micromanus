/**
 * lib/agent/tools/fetch-page.ts — the `fetch_page` agent tool (AGENT-04).
 *
 * Fetches an arbitrary web page (URL chosen by the model from search results),
 * extracts readable text with @mozilla/readability over a linkedom DOM, and
 * returns a truncated, token-budgeted observation. Server-only (Node runtime).
 *
 * SSRF is the headline threat (T-02-05-01): `isSafeUrl` runs BEFORE any request
 * and rejects non-http(s) schemes and private / loopback / link-local IPv4+IPv6
 * ranges plus the cloud metadata IP (169.254.169.254) and `localhost`. A 10s
 * AbortController and a max-response-size cap bound cost. Residual DNS-rebinding
 * risk (a hostname that resolves to a private IP at request time) is ACCEPTED at
 * ASVS L1 for this phase (T-02-05-01).
 *
 * CONTRACT: on a disallowed URL or a failed fetch this THROWS `FetchPageError`
 * (a typed, human-readable reason). The agent loop (loop.ts) wraps every tool
 * dispatch in try/catch and converts the thrown reason into an observation, so a
 * failure degrades the run instead of crashing it (AGENT-05). Fetched text is
 * untrusted observation data — the loop delimits it and never treats it as
 * instructions (prompt-injection mitigation, T-02-05-02).
 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export interface FetchPageResult {
  text: string;
  domain: string;
  tokensApprox: number;
}

/** Typed failure the loop catches and turns into an observation string. */
export class FetchPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchPageError";
  }
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000; // ~2MB response cap
const MAX_CHARS = 20_000; // extracted-text budget
const CHARS_PER_TOKEN = 4; // rough token estimate (display only, not billing)

export interface FetchPageDeps {
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------- SSRF guard --

function isPrivateIPv4(host: string): boolean {
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
  return false;
}

function isPrivateIPv6(host: string): boolean {
  if (!host.includes(":")) return false;
  const x = host.toLowerCase();
  if (x === "::1" || x === "::") return true; // loopback / unspecified
  if (x.startsWith("fe80")) return true; // link-local fe80::/10
  if (x.startsWith("fc") || x.startsWith("fd")) return true; // ULA fc00::/7
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(x);
  if (mapped) return isPrivateIPv4(mapped[1]); // IPv4-mapped IPv6
  return false;
}

/** True only for a public http(s) URL — the pre-request SSRF gate (AGENT-04). */
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

// ---------------------------------------------------------------- extraction --

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractReadable(html: string): string {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as unknown as Document).parse();
    const content = article?.textContent?.trim();
    if (content && content.length > 0) return normalizeWhitespace(content);
  } catch {
    // fall through to the tag-strip fallback
  }
  return normalizeWhitespace(stripTags(html));
}

/** Read the body, capping total bytes so a huge page cannot exhaust memory. */
async function readCapped(res: Response): Promise<string> {
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        out += decoder.decode(value, { stream: true });
      }
      if (total >= MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* already closing */
        }
        break;
      }
    }
    return out;
  }
  const text = await res.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}

export async function fetchPage(
  url: string,
  deps: FetchPageDeps = {},
): Promise<FetchPageResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Pre-request SSRF gate — nothing leaves the box for a disallowed target.
  if (!isSafeUrl(url)) {
    throw new FetchPageError(
      "that link is not allowed — it must be a public http(s) address",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "MicroManus-Agent/1.0 (+research)" },
    });
    if (!res.ok) {
      throw new FetchPageError(`could not fetch the page (status ${res.status})`);
    }
    const html = await readCapped(res);
    const extracted = extractReadable(html);
    const text = extracted.slice(0, MAX_CHARS);
    return {
      text,
      domain: new URL(url).hostname,
      tokensApprox: Math.ceil(text.length / CHARS_PER_TOKEN),
    };
  } catch (err) {
    if (err instanceof FetchPageError) throw err;
    // AbortError (timeout) and network errors — map to a safe reason. Do not
    // echo the raw error (can embed internals); loop.ts turns this into an
    // observation string (AGENT-05).
    const aborted = (err as { name?: string } | null)?.name === "AbortError";
    throw new FetchPageError(
      aborted
        ? "the page took too long to load (10s timeout)"
        : "could not fetch the page",
    );
  } finally {
    clearTimeout(timer);
  }
}
