import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSearchThrottle, webSearch } from "@/lib/agent/tools/web-search";

const DEGRADE = "search temporarily unavailable — continuing with what I have";

/** A minimal fetch Response stand-in (only what webSearch reads). */
function fakeResponse(opts: {
  status?: number;
  json?: unknown;
  retryAfter?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "retry-after" ? (opts.retryAfter ?? null) : null,
    },
    json: async () => opts.json ?? {},
  } as unknown as Response;
}

function okFetch(json: unknown): typeof fetch {
  return (async () => fakeResponse({ status: 200, json })) as unknown as typeof fetch;
}

/** Injected fake clock + sleep so throttle timing is deterministic (no real waits). */
function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

beforeEach(() => {
  resetSearchThrottle();
});

describe("webSearch — SerpAPI throttle + graceful degrade (AGENT-03/AGENT-05/D-29)", () => {
  it("spaces two sequential calls >= 1000ms apart (>= 1 req/s throttle)", async () => {
    const clk = fakeClock();
    const fetchImpl = okFetch({ organic_results: [] });
    await webSearch("a", { apiKey: "k", fetchImpl, now: clk.now, sleep: clk.sleep });
    await webSearch("b", { apiKey: "k", fetchImpl, now: clk.now, sleep: clk.sleep });
    // The second call had to wait a full second because no wall time elapsed.
    expect(clk.slept).toContain(1000);
  });

  it("does NOT sleep when >= 1s already elapsed between calls", async () => {
    const clk = fakeClock();
    const fetchImpl = okFetch({ organic_results: [] });
    await webSearch("a", { apiKey: "k", fetchImpl, now: clk.now, sleep: clk.sleep });
    clk.advance(1500); // caller-side time passes
    await webSearch("b", { apiKey: "k", fetchImpl, now: clk.now, sleep: clk.sleep });
    expect(clk.slept).toEqual([]); // no throttle wait needed
  });

  it("honors a 429 retry-after delay, then retries once and succeeds", async () => {
    const clk = fakeClock();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return fakeResponse({ status: 429, retryAfter: "2" });
      return fakeResponse({
        status: 200,
        json: { organic_results: [{ title: "T", link: "https://x.io", snippet: "s" }] },
      });
    }) as unknown as typeof fetch;

    const out = await webSearch("q", {
      apiKey: "k",
      fetchImpl,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(calls).toBe(2);
    expect(clk.slept).toContain(2000); // 2s retry-after honored before the retry
    expect(out.results).toHaveLength(1);
    expect(out.note).toBeUndefined();
  });

  it("degrades (never throws) on a missing/empty API key", async () => {
    const spy = vi.fn();
    const out = await webSearch("q", { apiKey: "", fetchImpl: spy as never });
    expect(out).toEqual({ results: [], note: DEGRADE });
    expect(spy).not.toHaveBeenCalled(); // no request without a key
  });

  it("degrades on a network error (fetch throws)", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET sk-should-never-surface");
    }) as unknown as typeof fetch;
    const out = await webSearch("q", { apiKey: "k", fetchImpl });
    expect(out.results).toEqual([]);
    expect(out.note).toBe(DEGRADE);
  });

  it("degrades on a non-200 (5xx) response", async () => {
    const fetchImpl = (async () => fakeResponse({ status: 503 })) as unknown as typeof fetch;
    const out = await webSearch("q", { apiKey: "k", fetchImpl });
    expect(out.note).toBe(DEGRADE);
  });

  it("degrades when the retry is still 429 (no budget left)", async () => {
    const clk = fakeClock();
    const fetchImpl = (async () =>
      fakeResponse({ status: 429, retryAfter: "1" })) as unknown as typeof fetch;
    const out = await webSearch("q", {
      apiKey: "k",
      fetchImpl,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(out.note).toBe(DEGRADE);
  });

  it("maps organic_results to {title,url,snippet}[] on success", async () => {
    const fetchImpl = okFetch({
      organic_results: [
        { title: "One", link: "https://one.example", snippet: "first" },
        { title: "Two", link: "https://two.example", snippet: "second" },
        { title: "NoLink" }, // dropped — no url
      ],
    });
    const out = await webSearch("q", { apiKey: "k", fetchImpl });
    expect(out.note).toBeUndefined();
    expect(out.results).toEqual([
      { title: "One", url: "https://one.example", snippet: "first" },
      { title: "Two", url: "https://two.example", snippet: "second" },
    ]);
  });

  it("never leaks the api key into the degrade note", async () => {
    const out = await webSearch("q", { apiKey: "SECRET_KEY_123", fetchImpl: (async () => {
      throw new Error("boom SECRET_KEY_123");
    }) as unknown as typeof fetch });
    expect(JSON.stringify(out)).not.toContain("SECRET_KEY_123");
  });
});
