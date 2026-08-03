import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPage, isSafeUrl, FetchPageError } from "@/lib/agent/tools/fetch-page";
import { ipv6Hextets } from "@/lib/net/safe-url";

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

  // ---- REGRESSION: review CR-02 ----------------------------------------
  // Every row below was empirically ALLOWED by the old string-prefix checks.
  // `new URL()` re-serialises IPv6 literals into WHATWG canonical form BEFORE
  // the predicate sees `hostname`, so the old dotted-quad IPv4-mapped regex
  // (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) was unreachable dead code — the parser
  // had already turned 127.0.0.1 into 7f00:1.
  it("CR-02: rejects the IPv6 spellings new URL() actually emits for loopback", () => {
    // hostname -> [::ffff:7f00:1]  (IPv4-mapped, hex-normalised)
    expect(isSafeUrl("http://[0:0:0:0:0:ffff:127.0.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[::ffff:7f00:1]/")).toBe(false);
    // hostname -> [::7f00:1]  (IPv4-compatible ::/96)
    expect(isSafeUrl("http://[::127.0.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[::7f00:1]/")).toBe(false);
    // hostname -> [::1] / [::]
    expect(isSafeUrl("http://[0:0:0:0:0:0:0:1]/")).toBe(false);
    expect(isSafeUrl("http://[::]/")).toBe(false);
  });

  it("CR-02: rejects the FULL fe80::/10 range, not just the 'fe80' string prefix", () => {
    for (const h of ["fe80::1", "fe90::1", "fea0::1", "febf::1", "febf:ffff::dead"]) {
      expect(isSafeUrl(`http://[${h}]/`)).toBe(false);
    }
  });

  it("CR-02: rejects fc00::/7 unique-local via numeric mask (fc.. and fd..)", () => {
    for (const h of ["fc00::1", "fc12:3456::1", "fd00::1", "fdff:ffff::1"]) {
      expect(isSafeUrl(`http://[${h}]/`)).toBe(false);
    }
  });

  it("CR-02: rejects IPv4-mapped forms of every private v4 range (delegation holds)", () => {
    for (const v4 of ["10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0"]) {
      expect(isSafeUrl(`http://[::ffff:${v4}]/`)).toBe(false);
      expect(isSafeUrl(`http://[::${v4}]/`)).toBe(false);
    }
  });

  it("CR-02: still accepts ordinary public IPv6 (the fix is not a blanket v6 ban)", () => {
    expect(isSafeUrl("http://[2001:4860:4860::8888]/")).toBe(true);
    expect(isSafeUrl("http://[2606:4700::1111]/")).toBe(true);
    expect(isSafeUrl("http://[::ffff:8.8.8.8]/")).toBe(true); // mapped PUBLIC v4
  });

  it("CR-02: IPv4 shorthand normalisation still closes (parser folds these first)", () => {
    expect(isSafeUrl("http://2130706433/")).toBe(false); // 127.0.0.1
    expect(isSafeUrl("http://0x7f000001/")).toBe(false);
    expect(isSafeUrl("http://127.1/")).toBe(false);
    expect(isSafeUrl("http://017700000001/")).toBe(false);
  });

  // CR-02 residual, closed in a follow-up: the first round fixed only the IPv6
  // spellings, leaving genuinely routable-internal and reserved v4 space open.
  it("CR-02: rejects CGNAT, benchmark, multicast and reserved IPv4", () => {
    expect(isSafeUrl("http://100.64.1.1/")).toBe(false); // CGNAT, RFC 6598
    expect(isSafeUrl("http://100.127.255.255/")).toBe(false); // top of /10
    expect(isSafeUrl("http://198.18.0.1/")).toBe(false); // benchmark, RFC 2544
    expect(isSafeUrl("http://198.19.255.255/")).toBe(false); // top of /15
    expect(isSafeUrl("http://224.0.0.1/")).toBe(false); // multicast
    expect(isSafeUrl("http://239.255.255.250/")).toBe(false); // SSDP multicast
    expect(isSafeUrl("http://240.0.0.1/")).toBe(false); // reserved
    expect(isSafeUrl("http://255.255.255.255/")).toBe(false); // broadcast
  });

  it("CR-02: the v4-mapped delegation closes the IPv6 spellings of those ranges too", () => {
    // One predicate, so tightening isPrivateIPv4 tightens ::ffff:… for free.
    expect(isSafeUrl("http://[::ffff:100.64.1.1]/")).toBe(false);
    expect(isSafeUrl("http://[::ffff:198.18.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[::ffff:224.0.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[::ffff:240.0.0.1]/")).toBe(false);
    expect(isSafeUrl("http://[::ffff:255.255.255.255]/")).toBe(false);
    expect(isSafeUrl("http://[::100.64.1.1]/")).toBe(false); // v4-compatible ::/96
  });

  it("CR-02: does NOT over-block — public and documentation IPv4 stay allowed", () => {
    // Public resolvers.
    expect(isSafeUrl("http://8.8.8.8/")).toBe(true);
    expect(isSafeUrl("http://1.1.1.1/")).toBe(true);
    // Documentation ranges are not SSRF targets — deliberately left routable.
    expect(isSafeUrl("http://192.0.2.1/")).toBe(true); // 192.0.2.0/24
    expect(isSafeUrl("http://198.51.100.1/")).toBe(true); // 198.51.100.0/24
    expect(isSafeUrl("http://203.0.113.1/")).toBe(true); // 203.0.113.0/24
    // Just outside each newly-blocked range — the masks must be exact.
    expect(isSafeUrl("http://100.63.255.255/")).toBe(true); // below 100.64/10
    expect(isSafeUrl("http://100.128.0.1/")).toBe(true); // above 100.64/10
    expect(isSafeUrl("http://198.17.255.255/")).toBe(true); // below 198.18/15
    expect(isSafeUrl("http://198.20.0.1/")).toBe(true); // above 198.18/15
    expect(isSafeUrl("http://223.255.255.255/")).toBe(true); // below multicast
  });

  it("CR-02: ipv6Hextets expands and validates, and returns null on garbage", () => {
    expect(ipv6Hextets("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Hextets("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ipv6Hextets("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(ipv6Hextets("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Hextets("2001:db8:0:0:0:0:0:1")?.[0]).toBe(0x2001);
    expect(ipv6Hextets("127.0.0.1")).toBeNull(); // not a v6 literal
    expect(ipv6Hextets("::1::2")).toBeNull(); // "::" twice
    expect(ipv6Hextets("1:2:3:4:5:6:7")).toBeNull(); // too few groups
    expect(ipv6Hextets("1:2:3:4:5:6:7:8:9")).toBeNull(); // too many groups
    expect(ipv6Hextets("gggg::1")).toBeNull(); // non-hex
    expect(ipv6Hextets("::fffff:1")).toBeNull(); // hextet > 4 digits
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

// ---- REGRESSION: review CR-01 -------------------------------------------
// The gate used to run ONCE on the model-supplied URL and then hand the request
// to the fetch layer with `redirect: "follow"`. Since the agent fetches pages it
// found via web_search — i.e. pages whose HTTP behaviour is attacker-controlled
// — a single `302 Location: http://169.254.169.254/` walked straight through the
// SSRF guard, and the body is persisted in the fetch_page `extract` field, making
// it an EXFILTRATING SSRF. Every hop must be re-gated.
describe("fetchPage — redirects are followed manually and re-gated (CR-01)", () => {
  /** A fake fetch that serves a scripted map of url -> response. */
  function scripted(routes: Record<string, { status: number; location?: string; body?: string }>) {
    const calls: string[] = [];
    const impl = (async (url: string, init: { redirect?: string }) => {
      calls.push(url);
      const r = routes[url];
      if (!r) throw new Error(`unscripted url: ${url}`);
      // Pin the contract: the tool must NEVER delegate redirect-following.
      expect(init.redirect).toBe("manual");
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: { get: (h: string) => (h.toLowerCase() === "location" ? (r.location ?? null) : null) },
        text: async () => r.body ?? "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("refuses a 302 into the cloud metadata IP and never issues the second request", async () => {
    const { impl, calls } = scripted({
      "https://evil.example/post": {
        status: 302,
        location: "http://169.254.169.254/latest/meta-data/",
      },
    });
    await expect(fetchPage("https://evil.example/post", { fetchImpl: impl })).rejects.toThrow(
      FetchPageError,
    );
    await expect(fetchPage("https://evil.example/post", { fetchImpl: impl })).rejects.toThrow(
      /not allowed/i,
    );
    // Only the first (public) hop was ever dialled — the metadata IP was not.
    expect(calls).toEqual(["https://evil.example/post", "https://evil.example/post"]);
  });

  it.each([
    ["loopback v4", "http://127.0.0.1/"],
    ["local supabase", "http://localhost:54321/rest/v1/"],
    ["RFC1918", "http://10.1.2.3/admin"],
    ["v6 loopback", "http://[::1]/"],
    ["hex v4-mapped v6 loopback", "http://[::ffff:7f00:1]/"],
    ["non-http scheme", "file:///etc/passwd"],
  ])("refuses a 302 to a %s target", async (_label, target) => {
    const { impl, calls } = scripted({
      "https://evil.example/x": { status: 302, location: target },
    });
    await expect(fetchPage("https://evil.example/x", { fetchImpl: impl })).rejects.toThrow(
      /not allowed/i,
    );
    expect(calls).toEqual(["https://evil.example/x"]);
  });

  it("follows a redirect chain to a PUBLIC target and returns its body", async () => {
    const { impl, calls } = scripted({
      "https://a.example/1": { status: 301, location: "https://b.example/2" },
      "https://b.example/2": { status: 302, location: "/3" }, // relative Location
      "https://b.example/3": { status: 200, body: "<article><p>final destination text</p></article>" },
    });
    const out = await fetchPage("https://a.example/1", { fetchImpl: impl });
    expect(out.text).toContain("final destination text");
    expect(calls).toEqual([
      "https://a.example/1",
      "https://b.example/2",
      "https://b.example/3",
    ]);
  });

  it("caps the hop count instead of chasing a redirect loop", async () => {
    const { impl, calls } = scripted({
      "https://loop.example/": { status: 302, location: "https://loop.example/" },
    });
    await expect(fetchPage("https://loop.example/", { fetchImpl: impl })).rejects.toThrow(
      /too many redirects/i,
    );
    expect(calls.length).toBe(4); // initial + MAX_REDIRECTS(3) hops, then stop
  });

  it("does not treat a 3xx without a Location header as a redirect", async () => {
    const { impl } = scripted({ "https://example.com/x": { status: 304 } });
    await expect(fetchPage("https://example.com/x", { fetchImpl: impl })).rejects.toThrow(
      /status 304/,
    );
  });
});

/**
 * EC-03. Roughly 11 of ~18 fetch attempts in the captured UAT run came back 403.
 * A request that negotiates no content type at all is a cheap thing for an
 * origin to refuse, so the tool now sends `Accept` and `Accept-Language`
 * alongside its existing honest `User-Agent`. This is header COMPLETENESS, not
 * user-agent spoofing — the agent still identifies itself, and these assertions
 * exist to keep it that way.
 */
describe("fetchPage — content-negotiation headers (EC-03)", () => {
  interface Init {
    headers: Record<string, string>;
  }

  it("sends Accept and Accept-Language on the initial request, keeping the honest User-Agent", async () => {
    let init: Init | undefined;
    const fetchImpl = (async (_url: string, i: Init) => {
      init = i;
      return {
        ok: true,
        status: 200,
        text: async () => "<article><p>body text</p></article>",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await fetchPage("https://example.com/doc", { fetchImpl });

    expect(init!.headers["User-Agent"]).toBe("MicroManus-Agent/1.0 (+research)");
    expect(init!.headers["Accept"]).toContain("text/html");
    expect(init!.headers["Accept"]).toContain("application/xhtml+xml");
    expect(init!.headers["Accept"]).toContain("*/*");
    expect(init!.headers["Accept-Language"]).toBe("en-US,en;q=0.9");
  });

  it("sends the same headers on every redirect hop, not just hop 0", async () => {
    const seen: Record<string, string>[] = [];
    const routes: Record<string, { status: number; location?: string; body?: string }> = {
      "https://a.example/1": { status: 301, location: "https://b.example/2" },
      "https://b.example/2": { status: 200, body: "<article><p>final</p></article>" },
    };
    const fetchImpl = (async (url: string, i: Init) => {
      seen.push(i.headers);
      const r = routes[url];
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        headers: {
          get: (h: string) => (h.toLowerCase() === "location" ? (r.location ?? null) : null),
        },
        text: async () => r.body ?? "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await fetchPage("https://a.example/1", { fetchImpl });

    expect(seen).toHaveLength(2);
    for (const h of seen) {
      expect(h["User-Agent"]).toBe("MicroManus-Agent/1.0 (+research)");
      expect(h["Accept"]).toContain("text/html");
      expect(h["Accept-Language"]).toBe("en-US,en;q=0.9");
    }
  });
});
