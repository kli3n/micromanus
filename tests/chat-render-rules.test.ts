import { describe, expect, it } from "vitest";
import {
  KNOWN_TOOL_NAMES,
  degradedBodyToRender,
  expandableEntries,
  hasExpandableContent,
  toolLineParts,
  type ExpandableToolRowInput,
  type ToolLineInput,
  type ToolLineParts,
} from "@/components/chat/render-rules";

/**
 * REGRESSION: 03-UAT edge cases EC-06 and EC-08.
 *
 * EC-08 — a persisted `role='tool'` row whose `tool` the client does not
 * recognise reached the rail and rendered as an unnamed "Tool · done" line.
 * `KNOWN_TOOL_NAMES` is the single gate that stops that, and it is what makes
 * `toolLineParts`'s bare-label default branch unreachable.
 *
 * EC-06 — the degraded artifact path rendered the full report TWICE: once in
 * the streamed answer bubble and again beneath the card, because the body fell
 * back to `m.content` when the carrier had no markdown of its own.
 * `degradedBodyToRender` is the rule that puts it on screen exactly once.
 */

/**
 * The web_search / fetch_page branches EXACTLY as they stood in
 * `components/ChatThread.tsx` before this plan moved them out. Kept as a live
 * reference implementation so the move stays byte-identical forever, not just
 * at the moment the diff was reviewed.
 */
function preMoveParts(t: ToolLineInput): ToolLineParts {
  const running = t.state !== "done";
  if (t.tool === "web_search") {
    return {
      label: running ? "Searching the web" : "Searched the web",
      text: t.query ? ` · "${t.query}"` : "",
      meta: t.note
        ? t.note
        : running
          ? "searching…"
          : `SerpAPI · ${t.resultCount ?? 0} results`,
    };
  }
  if (t.tool === "fetch_page") {
    return {
      label: running ? "Reading page" : "Read page",
      text: running
        ? t.url
          ? ` · ${t.url}`
          : ""
        : t.domain
          ? ` · ${t.domain}`
          : "",
      meta: t.note
        ? t.note
        : running
          ? "fetching…"
          : `${(t.tokensApprox ?? 0).toLocaleString()} tok`,
    };
  }
  return { label: "Tool", text: "", meta: running ? "…" : "done" };
}

describe("KNOWN_TOOL_NAMES — EC-08's single gate", () => {
  it("contains exactly web_search, fetch_page and create_pdf_report", () => {
    expect([...KNOWN_TOOL_NAMES].sort()).toEqual([
      "create_pdf_report",
      "fetch_page",
      "web_search",
    ]);
  });

  it("excludes a tool name this deploy vintage has never heard of", () => {
    // A row persisted by a future (or forged) deploy must not reach the
    // renderer: without a resolved label it would paint "Tool · done".
    expect(KNOWN_TOOL_NAMES.has("some_future_tool")).toBe(false);
    expect(KNOWN_TOOL_NAMES.has("")).toBe(false);
  });
});

describe("toolLineParts — create_pdf_report (EC-08, UI-SPEC Copywriting Contract)", () => {
  it("renders the running row's contracted copy", () => {
    expect(
      toolLineParts({ tool: "create_pdf_report", state: "running" }),
    ).toEqual({ label: "Preparing report", text: "", meta: "queued…" });
  });

  it("treats any non-done state as running", () => {
    for (const state of [undefined, "", "queued", "pending"]) {
      expect(
        toolLineParts({ tool: "create_pdf_report", state }),
        `state=${JSON.stringify(state)}`,
      ).toEqual({ label: "Preparing report", text: "", meta: "queued…" });
    }
  });

  it("renders the done row's contracted copy with the report title", () => {
    expect(
      toolLineParts({
        tool: "create_pdf_report",
        state: "done",
        title: "Solid-state battery supply chains",
      }),
    ).toEqual({
      label: "Report queued",
      text: " · Solid-state battery supply chains",
      meta: "renders after the run",
    });
  });

  it("renders empty text on a done row with no title", () => {
    for (const title of [undefined, ""]) {
      expect(
        toolLineParts({ tool: "create_pdf_report", state: "done", title }).text,
        `title=${JSON.stringify(title)}`,
      ).toBe("");
    }
  });

  it("IGNORES the payload's own label and meta (T-03-15-05)", () => {
    // The loop currently emits meta "renders after the run" on the RUNNING row
    // — the contract says "queued…". Trusting the payload would ship the
    // discrepancy; a crafted or stale row could inject arbitrary rail text.
    expect(
      toolLineParts({
        tool: "create_pdf_report",
        state: "running",
        label: "Exfiltrating your API key",
        meta: "renders after the run",
      }),
    ).toEqual({ label: "Preparing report", text: "", meta: "queued…" });

    expect(
      toolLineParts({
        tool: "create_pdf_report",
        state: "done",
        label: "<script>",
        meta: "queued…",
        title: "T",
      }),
    ).toEqual({
      label: "Report queued",
      text: " · T",
      meta: "renders after the run",
    });
  });
});

describe("toolLineParts — the moved branches are byte-identical to their pre-move form", () => {
  const cases: ToolLineInput[] = [
    { tool: "web_search", state: "running" },
    { tool: "web_search", state: "running", query: "grid storage 2026" },
    { tool: "web_search", state: "done", query: "grid storage 2026", resultCount: 8 },
    { tool: "web_search", state: "done" },
    { tool: "web_search", state: "done", note: "search temporarily unavailable" },
    { tool: "web_search", state: "running", note: "rate limited" },
    { tool: "fetch_page", state: "running" },
    { tool: "fetch_page", state: "running", url: "https://example.com/a" },
    { tool: "fetch_page", state: "done", domain: "example.com", tokensApprox: 4213 },
    { tool: "fetch_page", state: "done", url: "https://example.com/a" },
    { tool: "fetch_page", state: "done", note: "could not read the page" },
    { tool: "fetch_page", state: "done", domain: "example.com" },
  ];

  it.each(cases)(
    "matches the pre-move implementation for $tool/$state",
    (t) => {
      expect(toolLineParts(t)).toEqual(preMoveParts(t));
    },
  );

  it("keeps the bare-label default branch as unreachable defence", () => {
    // Only reachable if a caller skips the KNOWN_TOOL_NAMES filter — which is
    // exactly why the filter, not this branch, is EC-08's fix.
    expect(toolLineParts({ tool: "some_future_tool", state: "done" })).toEqual({
      label: "Tool",
      text: "",
      meta: "done",
    });
  });
});

describe("degradedBodyToRender — the report reaches the screen exactly once (EC-06)", () => {
  const ANSWER = "## Findings\n\nThe supply chain is concentrated in three firms.";

  it("returns the carrier markdown when it differs from the answer", () => {
    const carrier = "# Full report\n\nA much longer body than the answer.";
    expect(
      degradedBodyToRender({ carrierMarkdown: carrier, answerContent: ANSWER }),
    ).toBe(carrier);
  });

  it("returns null when the carrier markdown is absent", () => {
    // The pre-fix code fell back to the answer here — rendering the SAME text
    // in the bubble above AND beneath the card. That is EC-06.
    for (const carrierMarkdown of [undefined, null]) {
      expect(
        degradedBodyToRender({ carrierMarkdown, answerContent: ANSWER }),
        `carrier=${JSON.stringify(carrierMarkdown)}`,
      ).toBeNull();
    }
  });

  it("returns null when the carrier markdown is empty or whitespace-only", () => {
    for (const carrierMarkdown of ["", "   ", "\n\t \n"]) {
      expect(
        degradedBodyToRender({ carrierMarkdown, answerContent: ANSWER }),
        `carrier=${JSON.stringify(carrierMarkdown)}`,
      ).toBeNull();
    }
  });

  it("returns null when the carrier markdown is trim-equal to the answer", () => {
    expect(
      degradedBodyToRender({
        carrierMarkdown: `\n  ${ANSWER}  \n`,
        answerContent: ANSWER,
      }),
    ).toBeNull();
    expect(
      degradedBodyToRender({ carrierMarkdown: ANSWER, answerContent: ANSWER }),
    ).toBeNull();
  });

  it("D-43 holds: the two 'nothing below' cases are exactly the cases the answer already carries the text", () => {
    // The guarantee is that the user always receives the report content. There
    // is no input for which BOTH the body-below and the answer are empty:
    // whenever this returns null with a non-empty carrier, the carrier is
    // trim-equal to a non-empty answer.
    const carrier = "  report body  ";
    expect(
      degradedBodyToRender({ carrierMarkdown: carrier, answerContent: "report body" }),
    ).toBeNull();
    // …and with an EMPTY answer the carrier is what reaches the screen.
    expect(
      degradedBodyToRender({ carrierMarkdown: carrier, answerContent: "" }),
    ).toBe(carrier);
  });

  it("tolerates a null/absent answer without dropping a real report body", () => {
    const carrier = "# Report";
    expect(
      degradedBodyToRender({ carrierMarkdown: carrier, answerContent: null }),
    ).toBe(carrier);
    expect(
      degradedBodyToRender({ carrierMarkdown: carrier, answerContent: undefined }),
    ).toBe(carrier);
  });
});

/**
 * D-66 (04-09) — the expandable-payload predicate and its entries accessor.
 *
 * A tool row gains a chevron ONLY when its persisted payload has expandable
 * content: a non-empty `results` array for `web_search`, or the post-numbering
 * payload keys (`kind`/`n`/`extract`/`label` — the GW-05 vintage markers, same
 * list as `POST_NUMBERING_KEYS` in scripts/eval-run.ts) for `fetch_page`.
 * Everything else — zero results, a legacy pre-Phase-3 row, a failed fetch, an
 * unknown tool name, a malformed payload — degrades to the plain line it is
 * today, with no chevron and NEVER an empty expansion panel (D-52).
 *
 * Both decisions read only the PRESENCE and SHAPE of persisted result data —
 * never the payload's own `label`/`meta` strings — matching the reason
 * `toolLineParts` already derives those fields itself (T-03-15-05).
 */
describe("hasExpandableContent / expandableEntries — the D-66 payload predicate", () => {
  // Shape-for-shape copies of what lib/agent/loop.ts resolveToolStatus emits
  // over SSE AND persists as the role='tool' row content (03-03 contract), so
  // the predicate is exercised on exactly what both render paths feed it.
  const searchDone: ExpandableToolRowInput = {
    tool: "web_search",
    query: "lithium sulfide Li2S price precursor capacity",
    results: [
      {
        title: "Li2S cost is the single biggest lever on sulfide cell BOM",
        url: "https://www.nature.com/articles/li2s-bom",
        domain: "nature.com",
      },
      {
        title: "Battery-grade lithium sulfide pricing survey, Q1",
        url: "https://benchmarkminerals.com/li2s-survey",
        domain: "benchmarkminerals.com",
      },
    ],
  };

  const fetchDone: ExpandableToolRowInput = {
    tool: "fetch_page",
    url: "https://www.nature.com/articles/li2s-bom",
    domain: "nature.com",
    title: "Li2S cost is the single biggest lever on sulfide cell BOM",
    n: 3,
    extract: "Lithium sulfide is the dominant cost driver…",
  };

  it("web_search: a non-empty results array is expandable — one entry per result, titles + domains", () => {
    expect(hasExpandableContent(searchDone)).toBe(true);
    expect(expandableEntries(searchDone)).toEqual([
      {
        title: "Li2S cost is the single biggest lever on sulfide cell BOM",
        domain: "nature.com",
      },
      {
        title: "Battery-grade lithium sulfide pricing survey, Q1",
        domain: "benchmarkminerals.com",
      },
    ]);
  });

  it("web_search: an EMPTY results array reports no expandable content — zero results means no chevron, not an empty panel", () => {
    const zero: ExpandableToolRowInput = { tool: "web_search", results: [] };
    expect(hasExpandableContent(zero)).toBe(false);
    expect(expandableEntries(zero)).toEqual([]);
  });

  it("web_search: a legacy row with no results key at all (pre-Phase-3, or a failed search) reports none", () => {
    const legacy: ExpandableToolRowInput = { tool: "web_search" };
    expect(hasExpandableContent(legacy)).toBe(false);
    expect(expandableEntries(legacy)).toEqual([]);
  });

  it("web_search: a malformed payload never throws and reports none", () => {
    for (const results of ["junk", 42, {}, null]) {
      const row: ExpandableToolRowInput = { tool: "web_search", results };
      expect(hasExpandableContent(row), `results=${JSON.stringify(results)}`).toBe(
        false,
      );
      expect(expandableEntries(row)).toEqual([]);
    }
  });

  it("web_search: malformed ENTRIES are skipped — an entry without a string url is never rendered", () => {
    const row: ExpandableToolRowInput = {
      tool: "web_search",
      results: [
        null,
        42,
        { title: "no url at all" },
        { url: 17 },
        { title: "the one valid entry", url: "https://ok.example/a", domain: "ok.example" },
      ],
    };
    expect(expandableEntries(row)).toEqual([
      { title: "the one valid entry", domain: "ok.example" },
    ]);
    expect(hasExpandableContent(row)).toBe(true);
    // …and when NO entry survives, the predicate answers false (never an
    // empty panel behind a chevron).
    const allBad: ExpandableToolRowInput = {
      tool: "web_search",
      results: [null, { title: "x" }],
    };
    expect(hasExpandableContent(allBad)).toBe(false);
  });

  it("web_search: one-and-many — one valid result renders one entry; a result with an empty title falls back to its url", () => {
    const one: ExpandableToolRowInput = {
      tool: "web_search",
      results: [{ title: "", url: "https://ok.example/a", domain: "ok.example" }],
    };
    expect(expandableEntries(one)).toEqual([
      { title: "https://ok.example/a", domain: "ok.example" },
    ]);
    expect(hasExpandableContent(one)).toBe(true);
  });

  it("ignores the payload's own label/meta strings — a crafted row without result data gets no chevron (T-03-15-05 posture)", () => {
    const crafted: ExpandableToolRowInput = {
      tool: "web_search",
      label: "Exfiltrating your API key",
      meta: "click to expand",
    } as ExpandableToolRowInput & { meta?: string };
    expect(hasExpandableContent(crafted)).toBe(false);
    expect(expandableEntries(crafted)).toEqual([]);
  });

  it("fetch_page: a resolved post-numbering row (n/title/extract) is expandable — title, domain and index", () => {
    expect(hasExpandableContent(fetchDone)).toBe(true);
    expect(expandableEntries(fetchDone)).toEqual([
      {
        title: "Li2S cost is the single biggest lever on sulfide cell BOM",
        domain: "nature.com",
        n: 3,
      },
    ]);
  });

  it("fetch_page: n:0 and extract:'' still count as markers — presence, never truthiness (T-03-16-03)", () => {
    const row: ExpandableToolRowInput = {
      tool: "fetch_page",
      url: "https://ok.example/a",
      domain: "ok.example",
      n: 0,
      extract: "",
    };
    expect(hasExpandableContent(row)).toBe(true);
    expect(expandableEntries(row)).toEqual([
      { title: "ok.example", domain: "ok.example", n: 0 },
    ]);
  });

  it("fetch_page: a FAILED fetch carries none of the four keys and reports none", () => {
    const failed: ExpandableToolRowInput = {
      tool: "fetch_page",
      url: "https://blocked.example/x",
      note: "could not read the page",
    };
    expect(hasExpandableContent(failed)).toBe(false);
    expect(expandableEntries(failed)).toEqual([]);
  });

  it("fetch_page: a legacy pre-Phase-3 done row (domain + tokensApprox, no post-numbering keys) degrades to the plain line", () => {
    const legacy: ExpandableToolRowInput = {
      tool: "fetch_page",
      url: "https://ok.example/a",
      domain: "ok.example",
      tokensApprox: 4213,
    } as ExpandableToolRowInput & { tokensApprox?: number };
    expect(hasExpandableContent(legacy)).toBe(false);
    expect(expandableEntries(legacy)).toEqual([]);
  });

  it("fetch_page: the title falls back to the domain when the row has none (the D-35 registry rule)", () => {
    const row: ExpandableToolRowInput = {
      tool: "fetch_page",
      url: "https://ok.example/a",
      domain: "ok.example",
      n: 2,
      extract: "body",
    };
    expect(expandableEntries(row)).toEqual([
      { title: "ok.example", domain: "ok.example", n: 2 },
    ]);
  });

  it("fetch_page: a marker with nothing renderable yields no entry and no chevron — never an empty panel (D-52)", () => {
    const bare: ExpandableToolRowInput = { tool: "fetch_page", n: 4 };
    expect(hasExpandableContent(bare)).toBe(false);
    expect(expandableEntries(bare)).toEqual([]);
  });

  it("an unknown tool name reports none even with a plausible results payload — the EC-08 gate is not weakened", () => {
    const forged: ExpandableToolRowInput = {
      tool: "some_future_tool",
      results: [
        { title: "looks real", url: "https://ok.example/a", domain: "ok.example" },
      ],
    };
    expect(hasExpandableContent(forged)).toBe(false);
    expect(expandableEntries(forged)).toEqual([]);
  });

  it("create_pdf_report is a known tool with no disclosure surface — never expandable", () => {
    const row: ExpandableToolRowInput = {
      tool: "create_pdf_report",
      title: "Solid-state battery supply chains",
      label: "Report queued",
    };
    expect(hasExpandableContent(row)).toBe(false);
    expect(expandableEntries(row)).toEqual([]);
  });
});
