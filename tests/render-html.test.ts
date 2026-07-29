import { describe, expect, it } from "vitest";
import {
  markdownToBodyHtml,
  buildReportHtml,
  citationMarkers,
} from "@/lib/pdf/render-html";

/**
 * D-40/D-41/D-42 — the sanitizing renderer for /api/render-pdf (T-3-01).
 *
 * markdown becomes HTML ONLY through renderToStaticMarkup + react-markdown +
 * remark-gfm: raw HTML is escaped (never parsed), images render nothing (the
 * Chromium subresource/SSRF surface is deleted — Open Question 4 resolved:
 * strip), and the wrapper template hand-escapes every interpolation. The
 * bibliography emits an href ONLY for http:/https: URLs.
 */

describe("markdownToBodyHtml (sanitizing renderer, CM-9)", () => {
  it("renders a GFM table to table/th/td markup", () => {
    const html = markdownToBodyHtml(
      "| Col A | Col B |\n| --- | --- |\n| a1 | b1 |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>Col A</th>");
    expect(html).toContain("<td>a1</td>");
  });

  it("escapes a raw script tag — arrives as text, never an element (T-3-01)", () => {
    const html = markdownToBodyHtml('hello <script>alert("x")</script> world');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an img-onerror payload — no element, no handler", () => {
    const html = markdownToBodyHtml('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("renders NOTHING for image markdown (img components override → null, T-3-51)", () => {
    const html = markdownToBodyHtml("before ![alt text](https://internal.host/x.png) after");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("internal.host");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("renders ordinary markdown structure (headings, emphasis, code)", () => {
    const html = markdownToBodyHtml("# Title\n\nSome *em* and `code`.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
  });
});

describe("buildReportHtml (fixed template, hand-escaped interpolations)", () => {
  it("escapes ampersand/lt/gt/quote in the title", () => {
    const html = buildReportHtml({
      title: `A & B <script> "quoted"`,
      bodyHtml: "<p>body</p>",
    });
    expect(html).toContain("A &amp; B &lt;script&gt; &quot;quoted&quot;");
    expect(html).not.toContain("<script>");
  });

  it("passes the (trusted, renderer-produced) bodyHtml through unescaped", () => {
    const html = buildReportHtml({
      title: "T",
      bodyHtml: "<p>rendered body</p>",
    });
    expect(html).toContain("<p>rendered body</p>");
  });

  it("inlines the minimal PRINT_CSS (@page 18mm, collapsed tables) — D-41", () => {
    const html = buildReportHtml({ title: "T", bodyHtml: "" });
    expect(html).toContain("@page");
    expect(html).toContain("18mm");
    expect(html).toContain("border-collapse");
  });

  it("renders bibliography entries as '[n] title — url' with an href for http(s) URLs (D-42)", () => {
    const html = buildReportHtml({
      title: "T",
      bodyHtml: "<p>see [1] and [2]</p>",
      sources: [
        { n: 1, title: "First Source", url: "https://a.example/one" },
        { n: 2, title: "Second Source", url: "http://b.example/two" },
      ],
    });
    expect(html).toContain("[1]");
    expect(html).toContain("First Source");
    expect(html).toContain('href="https://a.example/one"');
    expect(html).toContain("[2]");
    expect(html).toContain('href="http://b.example/two"');
    // The URL is also visible as text (a printed link must be readable on paper).
    expect(html).toContain("https://a.example/one</");
  });

  it("emits NO href for a javascript: URL — it renders as escaped text only", () => {
    const html = buildReportHtml({
      title: "T",
      bodyHtml: "",
      sources: [{ n: 1, title: "Evil", url: "javascript:alert(1)" }],
    });
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("href='javascript:");
    expect(html).toContain("javascript:alert(1)"); // visible text, no anchor
  });

  it("escapes hostile bibliography titles and URLs", () => {
    const html = buildReportHtml({
      title: "T",
      bodyHtml: "",
      sources: [
        { n: 1, title: '<script>x</script>', url: 'https://a.io/"><script>' },
      ],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders no bibliography section when sources are omitted or empty", () => {
    const none = buildReportHtml({ title: "T", bodyHtml: "<p>x</p>" });
    const empty = buildReportHtml({ title: "T", bodyHtml: "<p>x</p>", sources: [] });
    expect(none).not.toContain("Sources");
    expect(empty).not.toContain("Sources");
  });
});

describe("citationMarkers — body-marker ⊆ bibliography subset check (D-42)", () => {
  it("extracts the distinct [n] integers from a markdown body", () => {
    const md = "Claim [1]. Another [2], repeated [1]. Not a marker [x] or [12abc].";
    expect(citationMarkers(md)).toEqual([1, 2]);
  });

  it("returns [] for a body with no markers", () => {
    expect(citationMarkers("no citations here")).toEqual([]);
  });

  it("every body marker whose n exists in sources has a bibliography entry", () => {
    const md = "Alpha [1] beta [2] gamma [3].";
    const sources = [
      { n: 1, title: "S1", url: "https://a.io/1" },
      { n: 2, title: "S2", url: "https://a.io/2" },
      // n=3 was never fetched — the model invented it; the bibliography
      // correctly omits it (the client renders it as plain text — Pitfall 10).
    ];
    const html = buildReportHtml({
      title: "T",
      bodyHtml: markdownToBodyHtml(md),
      sources,
    });
    const covered = citationMarkers(md).filter((n) =>
      sources.some((s) => s.n === n),
    );
    for (const n of covered) {
      expect(html).toContain(`[${n}]`);
      expect(html).toContain(sources.find((s) => s.n === n)!.title);
    }
  });
});
