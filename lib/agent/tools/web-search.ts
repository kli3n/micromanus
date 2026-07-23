/**
 * lib/agent/tools/web-search.ts — the `web_search` agent tool (AGENT-03 / D-29).
 *
 * SerpAPI is the SOLE search provider this phase (D-29 — not Brave); the
 * multi-provider search-adapter seam is deferred (D-30). Server-only: this module
 * reads `env.SERPAPI_API_KEY` and issues an outbound HTTPS request, so it is only
 * ever imported from the Node run handler / agent loop, never client-reachable.
 *
 * Two invariants make it safe to hand to a bounded agent loop:
 *   1. A module-level >= 1 request/second throttle (AGENT-03) so a runaway loop
 *      cannot hammer SerpAPI and burn the free-tier quota in one run.
 *   2. It NEVER throws (AGENT-05): every failure path — missing key, network
 *      error, non-200, or an exhausted 429 after one retry — resolves to the
 *      locked degrade shape so the loop converts it to an observation and keeps
 *      going. The SerpAPI key and raw error body never appear in the return value
 *      or (see below) in a log line.
 */
import { env } from "@/lib/env";

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  results: WebSearchResultItem[];
  /** Present ONLY on graceful degrade (AGENT-05). Locked copy — do not reword. */
  note?: string;
}

/** Locked degrade copy (02-UI-SPEC "Search degrade (AGENT-05)"). */
const DEGRADE_NOTE = "search temporarily unavailable — continuing with what I have";

const SERPAPI_URL = "https://serpapi.com/search.json";
const THROTTLE_MS = 1000; // >= 1 req/s (AGENT-03)
const MAX_RETRY_WAIT_MS = 5000; // bound the single 429 back-off
const MAX_RESULTS = 8;

/**
 * Module-level monotonic throttle marker (survives across loop iterations).
 * `-Infinity` so the FIRST call in a run is never throttled — only the gap
 * between successive calls is bounded to >= 1s (AGENT-03).
 */
let lastCallAt = Number.NEGATIVE_INFINITY;

/** Test seam: reset the module throttle between specs. */
export function resetSearchThrottle(): void {
  lastCallAt = Number.NEGATIVE_INFINITY;
}

export interface WebSearchDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Override the resolved key (tests); defaults to env.SERPAPI_API_KEY. */
  apiKey?: string;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function degrade(): WebSearchResult {
  return { results: [], note: DEGRADE_NOTE };
}

interface SerpResponse {
  organic_results?: Array<{ title?: unknown; link?: unknown; snippet?: unknown }>;
}

function parseRetryAfter(res: Response): number | null {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

export async function webSearch(
  query: string,
  deps: WebSearchDeps = {},
): Promise<WebSearchResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const fetchImpl = deps.fetchImpl ?? fetch;
  // `env` is undefined under the Vitest guard — optional-chain so a keyless
  // test/boot degrades instead of throwing.
  const apiKey =
    deps.apiKey !== undefined ? deps.apiKey : (env?.SERPAPI_API_KEY ?? "");

  try {
    if (!apiKey) return degrade();

    // (1) >= 1 req/s throttle.
    const wait = THROTTLE_MS - (now() - lastCallAt);
    if (wait > 0) await sleep(Math.min(wait, THROTTLE_MS));
    lastCallAt = now();

    const url =
      `${SERPAPI_URL}?engine=google&q=${encodeURIComponent(query)}` +
      `&api_key=${encodeURIComponent(apiKey)}`;

    let res = await fetchImpl(url);

    // (2) Single bounded retry on 429, honoring retry-after if present.
    if (res.status === 429) {
      const retryMs = parseRetryAfter(res) ?? THROTTLE_MS;
      await sleep(Math.min(retryMs, MAX_RETRY_WAIT_MS));
      lastCallAt = now();
      res = await fetchImpl(url);
    }

    if (!res.ok) return degrade();

    const json = (await res.json()) as SerpResponse;
    const raw = Array.isArray(json.organic_results) ? json.organic_results : [];
    const results: WebSearchResultItem[] = raw
      .slice(0, MAX_RESULTS)
      .map((r) => ({
        title: typeof r.title === "string" ? r.title : "",
        url: typeof r.link === "string" ? r.link : "",
        snippet: typeof r.snippet === "string" ? r.snippet : "",
      }))
      .filter((r) => r.url.length > 0);

    return { results };
  } catch (err) {
    // Server-side only, and deliberately NOT the raw error (a fetch error can
    // embed the request URL, which carries api_key) — log just the error name.
    console.error(
      "[web_search] request failed:",
      err instanceof Error ? err.name : "error",
    );
    return degrade();
  }
}
