import { describe, expect, it } from "vitest";
import {
  KNOWN_TOOL_NAMES,
  degradedBodyToRender,
  toolLineParts,
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
