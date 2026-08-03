/**
 * lib/agent/tools/fetch-page.ts — the `fetch_page` agent tool (AGENT-04).
 *
 * Fetches an arbitrary web page (URL chosen by the model from search results),
 * extracts readable text with @mozilla/readability over a linkedom DOM, and
 * returns a truncated, token-budgeted observation. Server-only (Node runtime).
 *
 * SSRF is the headline threat (T-02-05-01): `isSafeUrl` (lib/net/safe-url.ts —
 * the ONE shared predicate) rejects non-http(s) schemes and private / loopback /
 * link-local IPv4+IPv6 ranges plus the cloud metadata IP (169.254.169.254) and
 * `localhost`. It runs before the first request AND AGAIN ON EVERY REDIRECT HOP:
 * redirects are followed manually (`redirect: "manual"`, MAX_REDIRECTS hops),
 * because a pre-request-only check is worthless when the fetch layer will
 * happily follow a `302 Location: http://169.254.169.254/` on our behalf — and
 * the agent's whole job is fetching pages whose HTTP behaviour is
 * attacker-controlled (review CR-01). A 10s AbortController and a
 * max-response-size cap bound cost. Residual DNS-rebinding risk (a hostname
 * that resolves to a private IP at request time) is ACCEPTED at ASVS L1 for
 * this phase (T-02-05-01) — it is the ONLY accepted residual here.
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
import { isSafeUrl } from "@/lib/net/safe-url";

// The SSRF predicate lives in lib/net/safe-url.ts so /api/keys and
// /api/keys/test can share it verbatim (review CR-03). Re-exported here because
// this module was its original home and existing callers/tests import it here.
export { isSafeUrl } from "@/lib/net/safe-url";

export interface FetchPageResult {
  text: string;
  domain: string;
  tokensApprox: number;
  /** Extracted page title (Readability / <title>), when one exists — feeds the
   *  D-35 source registry's display title; callers fall back to `domain`. */
  title?: string;
}

/** Typed failure the loop catches and turns into an observation string. */
export class FetchPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchPageError";
  }
}

const FETCH_TIMEOUT_MS = 10_000;
/** Redirect hops we will follow, each one re-gated by `isSafeUrl` (CR-01). */
const MAX_REDIRECTS = 3;
const MAX_BYTES = 2_000_000; // ~2MB response cap
const MAX_CHARS = 20_000; // extracted-text budget
const CHARS_PER_TOKEN = 4; // rough token estimate (display only, not billing)

export interface FetchPageDeps {
  fetchImpl?: typeof fetch;
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

const MAX_TITLE_CHARS = 300;

/** Best-effort <title> extraction for the tag-strip fallback path. */
function titleFromHtml(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m ? normalizeWhitespace(stripTags(m[1])) : "";
  return t.length > 0 ? t.slice(0, MAX_TITLE_CHARS) : undefined;
}

function extractReadable(html: string): { text: string; title?: string } {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document as unknown as Document).parse();
    const content = article?.textContent?.trim();
    if (content && content.length > 0) {
      const t = article?.title ? normalizeWhitespace(article.title) : "";
      return {
        text: normalizeWhitespace(content),
        title: t.length > 0 ? t.slice(0, MAX_TITLE_CHARS) : titleFromHtml(html),
      };
    }
  } catch {
    // fall through to the tag-strip fallback
  }
  return { text: normalizeWhitespace(stripTags(html)), title: titleFromHtml(html) };
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Follow redirects OURSELVES so the SSRF gate runs on every hop. With
    // `redirect: "follow"` the fetch layer would chase a `302 Location:
    // http://169.254.169.254/` for us, and since the body comes back as a
    // persisted observation this would be an EXFILTRATING SSRF (review CR-01).
    let current = url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      // Gate BEFORE the request — nothing leaves the box for a disallowed
      // target, on hop 0 (the model-supplied URL) or any hop after it.
      if (!isSafeUrl(current)) {
        throw new FetchPageError(
          "that link is not allowed — it must be a public http(s) address",
        );
      }
      res = await fetchImpl(current, {
        signal: controller.signal,
        redirect: "manual",
        // EC-03: roughly 11 of ~18 fetch attempts in the captured UAT run came
        // back 403, and a request that negotiates NOTHING is a cheap thing for
        // an origin to refuse. The two negotiation headers below are header
        // COMPLETENESS, not user-agent spoofing: the User-Agent is
        // deliberately byte-unchanged, so the agent still identifies itself
        // honestly and no origin is deceived about the nature of the client.
        // Sent on hop 0 AND on every redirect hop — a redirect target sees the
        // same request the first one did.
        headers: {
          "User-Agent": "MicroManus-Agent/1.0 (+research)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      if (res.status < 300 || res.status > 399) break;

      const loc = res.headers.get("location");
      // A 3xx with no Location (e.g. 304) is not a redirect we can follow.
      if (!loc) {
        throw new FetchPageError(`could not fetch the page (status ${res.status})`);
      }
      if (hop >= MAX_REDIRECTS) {
        throw new FetchPageError("could not fetch the page (too many redirects)");
      }
      // Release the 3xx body before reusing the connection.
      try {
        await (res as { body?: { cancel?: () => Promise<void> } | null }).body?.cancel?.();
      } catch {
        /* already closed */
      }
      try {
        current = new URL(loc, current).toString(); // resolve a relative Location
      } catch {
        throw new FetchPageError(
          "that link is not allowed — it must be a public http(s) address",
        );
      }
    }
    if (!res.ok) {
      throw new FetchPageError(`could not fetch the page (status ${res.status})`);
    }
    const html = await readCapped(res);
    const extracted = extractReadable(html);
    const text = extracted.text.slice(0, MAX_CHARS);
    return {
      text,
      domain: new URL(url).hostname,
      tokensApprox: Math.ceil(text.length / CHARS_PER_TOKEN),
      ...(extracted.title ? { title: extracted.title } : {}),
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
