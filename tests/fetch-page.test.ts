import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage, isSafeUrl } from "@/lib/agent/tools/fetch-page";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isSafeUrl — SSRF guard (AGENT-04 / T-02-05-01)", () => {
  it("rejects non-http(s) schemes", () => {
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("ftp://example.com/x")).toBe(false);
    expect(isSafeUrl("data:text/html,<h1>x</h1>")).toBe(false);
    expect(isSafeUrl("gopher://example.com")).toBe(false);
  });

  it("rejects private / loopback / link-local IPv4 and the cloud metadata IP", () => {
    expect(isSafeUrl("http://127.0.0.1/")).toBe(false);
    expect(isSafeUrl("http://10.0.0.1/")).toBe(false);
    expect(isSafeUrl("http://172.16.0.1/")).toBe(false);
    expect(isSafeUrl("http://192.168.1.1/")).toBe(false);
    expect(isSafeUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isSafeUrl("http://0.0.0.0/")).toBe(false);
  });

  it("rejects loopback / link-local / ULA IPv6 and localhost", () => {
    expect(isSafeUrl("http://[::1]/")).toBe(false);
    expect(isSafeUrl("http://[fe80::1]/")).toBe(false);
    expect(isSafeUrl("http://[fc00::1]/")).toBe(false);
    expect(isSafeUrl("http://localhost/")).toBe(false);
    expect(isSafeUrl("http://localhost:3000/x")).toBe(false);
  });

  it("accepts ordinary public http(s) URLs", () => {
    expect(isSafeUrl("https://example.com/article")).toBe(true);
    expect(isSafeUrl("http://news.ycombinator.com/")).toBe(true);
    expect(isSafeUrl("https://8.8.8.8/")).toBe(true);
  });

  it("rejects a malformed URL string", () => {
    expect(isSafeUrl("not a url")).toBe(false);
    expect(isSafeUrl("")).toBe(false);
  });
});

describe("fetchPage — extraction, timeout, size cap, SSRF reject", () => {
  it("rejects an unsafe URL BEFORE issuing any network request", async () => {
    const spy = vi.fn();
    await expect(
      fetchPage("http://169.254.169.254/latest/meta-data/", { fetchImpl: spy as never }),
    ).rejects.toThrow();
    await expect(
      fetchPage("file:///etc/passwd", { fetchImpl: spy as never }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("extracts readable text and reports domain + approximate token count", async () => {
    const html = `<!doctype html><html><head><title>Doc</title></head><body>
      <article><h1>The Title</h1>
      <p>${"Readable body sentence about the topic. ".repeat(20)}</p>
      </article></body></html>`;
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, text: async () => html }) as unknown as Response) as never;
    const out = await fetchPage("https://example.com/doc", { fetchImpl });
    expect(out.domain).toBe("example.com");
    expect(out.text.toLowerCase()).toContain("readable body sentence");
    expect(out.tokensApprox).toBeGreaterThan(0);
  });

  it("falls back to tag-stripping when readability yields no article (never empty-throws)", async () => {
    const html = "<div>plain fallback content here</div>";
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, text: async () => html }) as unknown as Response) as never;
    const out = await fetchPage("https://example.com/", { fetchImpl });
    expect(out.text).toContain("plain fallback content here");
    expect(out.text.length).toBeGreaterThan(0);
  });

  it("truncates extracted text to the char/token budget on an oversized page", async () => {
    const huge = `<article><p>${"word ".repeat(200_000)}</p></article>`;
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, text: async () => huge }) as unknown as Response) as never;
    const out = await fetchPage("https://example.com/big", { fetchImpl });
    expect(out.text.length).toBeLessThanOrEqual(20_000);
  });

  it("aborts a slow response at ~10s via AbortController", async () => {
    vi.useFakeTimers();
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const p = fetchPage("https://slow.example/", { fetchImpl });
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("rejects with a human-readable reason on a non-200 response", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 404, text: async () => "" }) as unknown as Response) as never;
    await expect(fetchPage("https://example.com/missing", { fetchImpl })).rejects.toThrow(
      /could not fetch/i,
    );
  });
});
