import { describe, expect, it } from "vitest";
import {
  deriveRunSurfaces,
  type RunSurfaces,
  type ToolStatusEntry,
} from "@/components/chat/derive-run-surfaces";
import { KNOWN_TOOL_NAMES } from "@/components/chat/render-rules";
import { parseArtifactCarrier, type ArtifactCarrier } from "@/components/chat/ArtifactCard";
import type { PlanRowItem } from "@/components/chat/ResearchPlanCard";
import type { FoundRow, SourceRow } from "@/components/chat/SourcesCard";

/**
 * FIRST-EVER coverage of `deriveRunSurfaces` (04-03 Task 1, Pitfall 6 / R-4).
 *
 * This function carries the D-25 live/replay parity contract, the citation
 * registry construction (whose append-only integer set is what guarantees
 * `remarkCitations` can only ever emit a literal `#src-{n}` href), the
 * plan-row resolution rule, the EC-08 `KNOWN_TOOL_NAMES` gate and the
 * "Also found" dedupe — and until this file it had NO tests at all, while the
 * whole D-64 activity rail is being built on top of it.
 *
 * The suite exists because the function was NON-EXPORTED inside a 1 460-line
 * `"use client"` component: `vitest.config.ts` collects only
 * `lib/**\/*.test.ts` + `tests/**\/*.test.ts` in a `node` environment and never
 * a `.tsx`, so the extraction into a pure module is what makes testing
 * possible at all. No jsdom, no @testing-library — the house answer to a
 * DOM-less runner is to extract the decision and pin the decision.
 */

/**
 * `deriveRunSurfaces` EXACTLY as it stood in `components/ChatThread.tsx`
 * (lines 215-318, including its private `normalizeUrl`) before 04-03 moved it
 * out. Kept as a LIVE reference implementation, in the same spirit as
 * `tests/chat-render-rules.test.ts:23-45`: the extraction claim is "the body
 * moved unchanged", and a claim of that shape is only true at the moment a
 * human reads the diff unless something keeps asserting it. Every case below
 * asserts extracted-equals-oracle, so a future edit to the extracted module
 * that changes behaviour fails here rather than silently forking the parity
 * contract this function exists to hold.
 *
 * Do NOT "fix" or tidy this copy. Its value is that it is stale on purpose.
 */
function preMoveNormalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw.toLowerCase().replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

function preMoveDeriveRunSurfaces(
  tools: ToolStatusEntry[],
  terminal: boolean,
): RunSurfaces {
  const plan = tools.find((t) => t.kind === "plan") ?? null;
  const meter = tools.find((t) => t.kind === "meter") ?? null;
  const lines = tools.filter(
    (t) => t.kind == null && KNOWN_TOOL_NAMES.has(t.tool),
  );

  let artifact: ArtifactCarrier | null = null;
  for (const t of tools) {
    if (t.kind !== "artifact") continue;
    const parsed = parseArtifactCarrier(t);
    if (parsed) artifact = parsed;
  }

  const doneSearchCount = lines.filter(
    (t) => t.tool === "web_search" && t.state === "done",
  ).length;
  const rawItems = plan && Array.isArray(plan.items) ? plan.items : [];
  const planItems: PlanRowItem[] = rawItems.map((text, i) => ({
    text: String(text),
    resolved: terminal || i < doneSearchCount,
  }));

  const registry = new Set<number>();
  const sources: SourceRow[] = [];
  const fetched = new Set<string>();
  for (const t of lines) {
    if (t.tool !== "fetch_page") continue;
    if (t.url) fetched.add(preMoveNormalizeUrl(t.url));
    if (t.state === "done" && typeof t.n === "number" && !registry.has(t.n)) {
      registry.add(t.n);
      sources.push({
        n: t.n,
        title: t.title ?? t.domain ?? t.url ?? "",
        url: t.url ?? "",
        domain: t.domain ?? "",
      });
    }
  }
  sources.sort((a, b) => a.n - b.n);

  const seen = new Set<string>();
  const alsoFound: FoundRow[] = [];
  for (const t of lines) {
    if (t.tool !== "web_search" || t.state !== "done") continue;
    for (const r of t.results ?? []) {
      if (!r || typeof r.url !== "string") continue;
      const key = preMoveNormalizeUrl(r.url);
      if (fetched.has(key) || seen.has(key)) continue;
      seen.add(key);
      alsoFound.push({
        title: r.title ?? r.url,
        url: r.url,
        domain: r.domain ?? "",
      });
    }
  }

  return { planItems, meter, lines, registry, sources, alsoFound, artifact };
}

/**
 * Every case runs through here: derive with the extracted module, derive with
 * the oracle, assert deep equality, and hand the result back for the
 * case-specific assertions. Making the oracle comparison a HELPER rather than a
 * per-case line is what stops a future case from quietly omitting it.
 */
function expectMatchesOracle(
  tools: ToolStatusEntry[],
  terminal: boolean,
): RunSurfaces {
  const actual = deriveRunSurfaces(tools, terminal);
  const oracle = preMoveDeriveRunSurfaces(tools, terminal);
  expect(actual).toEqual(oracle);
  return actual;
}

const search = (over: Partial<ToolStatusEntry> = {}): ToolStatusEntry => ({
  id: `s-${Math.random()}`,
  tool: "web_search",
  state: "done",
  ...over,
});

const fetchPage = (over: Partial<ToolStatusEntry> = {}): ToolStatusEntry => ({
  id: `f-${Math.random()}`,
  tool: "fetch_page",
  state: "done",
  ...over,
});

describe("deriveRunSurfaces", () => {
  it("returns every surface in its empty form for no tools", () => {
    const s = expectMatchesOracle([], false);
    expect(s.planItems).toEqual([]);
    expect(s.meter).toBeNull();
    expect(s.lines).toEqual([]);
    expect(s.registry).toEqual(new Set<number>());
    expect(s.registry.size).toBe(0);
    expect(s.sources).toEqual([]);
    expect(s.alsoFound).toEqual([]);
    expect(s.artifact).toBeNull();
  });

  it("a web_search done row yields the oracle's line and contributes nothing to the registry", () => {
    const row = search({
      id: "s-1",
      query: "solid state battery",
      resultCount: 3,
      results: [
        { title: "A", url: "https://a.example/x", domain: "a.example" },
        { title: "B", url: "https://b.example/y", domain: "b.example" },
      ],
    });
    const s = expectMatchesOracle([row], false);
    expect(s.lines).toEqual([row]);
    expect(s.registry.size).toBe(0);
    expect(s.sources).toEqual([]);
    expect(s.alsoFound).toHaveLength(2);
  });

  it("a fetch_page done row carrying n adds exactly that integer to the registry and one sources row", () => {
    const row = fetchPage({
      id: "f-1",
      n: 4,
      url: "https://docs.example/page",
      domain: "docs.example",
      title: "Docs page",
    });
    const s = expectMatchesOracle([row], false);
    expect([...s.registry]).toEqual([4]);
    expect(s.sources).toEqual([
      { n: 4, title: "Docs page", url: "https://docs.example/page", domain: "docs.example" },
    ]);
    // Append-only: a duplicate n never re-registers and never adds a second row.
    const dupe = expectMatchesOracle(
      [row, fetchPage({ id: "f-2", n: 4, url: "https://other.example/z" })],
      false,
    );
    expect([...dupe.registry]).toEqual([4]);
    expect(dupe.sources).toHaveLength(1);
    // Sources sort by STORED n, never array order (Pitfall 10).
    const ordered = expectMatchesOracle(
      [
        fetchPage({ id: "f-9", n: 9, url: "https://nine.example" }),
        fetchPage({ id: "f-3", n: 3, url: "https://three.example" }),
      ],
      true,
    );
    expect(ordered.sources.map((r) => r.n)).toEqual([3, 9]);
  });

  it("the lines filter honours KNOWN_TOOL_NAMES — an unknown tool name is excluded (EC-08 gate)", () => {
    const known = search({ id: "s-1", query: "q" });
    const unknown: ToolStatusEntry = {
      id: "u-1",
      tool: "exfiltrate_everything",
      state: "done",
    };
    const s = expectMatchesOracle([known, unknown], false);
    expect(s.lines).toEqual([known]);
    expect(s.lines.every((t) => KNOWN_TOOL_NAMES.has(t.tool))).toBe(true);
    // create_pdf_report IS known (03-15) and must survive the filter.
    const pdf: ToolStatusEntry = {
      id: "p-1",
      tool: "create_pdf_report",
      state: "done",
      title: "Report",
    };
    expect(expectMatchesOracle([pdf], true).lines).toEqual([pdf]);
  });

  it("terminal true versus false on identical rows produces exactly the oracle's difference", () => {
    const rows: ToolStatusEntry[] = [
      { id: "plan-r1", tool: "plan", state: "done", kind: "plan", items: ["a", "b", "c"] },
      search({ id: "s-1", state: "done", query: "a" }),
      search({ id: "s-2", state: "running", query: "b" }),
    ];
    const live = expectMatchesOracle(rows, false);
    const done = expectMatchesOracle(rows, true);
    // One DONE web_search resolves row 0 only while live; terminal resolves all.
    expect(live.planItems.map((p) => p.resolved)).toEqual([true, false, false]);
    expect(done.planItems.map((p) => p.resolved)).toEqual([true, true, true]);
    // Nothing else moves.
    expect({ ...live, planItems: null }).toEqual({ ...done, planItems: null });
  });

  it("plan and meter carrier rows resolve to planItems and meter respectively", () => {
    const runId = "11111111-1111-1111-1111-111111111111";
    const plan: ToolStatusEntry = {
      id: `plan-${runId}`,
      tool: "plan",
      state: "done",
      kind: "plan",
      items: ["Sub-question one", "Sub-question two"],
    };
    const meter: ToolStatusEntry = {
      id: `meter-${runId}`,
      tool: "meter",
      state: "running",
      kind: "meter",
      startedAt: "2026-08-04T10:00:00.000Z",
    };
    const s = expectMatchesOracle([plan, meter], false);
    expect(s.planItems).toEqual([
      { text: "Sub-question one", resolved: false },
      { text: "Sub-question two", resolved: false },
    ]);
    expect(s.meter).toEqual(meter);
    // Carrier rows are NOT tool lines — kind-discriminated rows never render one.
    expect(s.lines).toEqual([]);
  });

  it("the Also found dedupe and normalizeUrl agree with the oracle on two URLs that normalise to one value", () => {
    const rows: ToolStatusEntry[] = [
      search({
        id: "s-1",
        results: [
          { title: "Canonical", url: "https://Example.COM/path/", domain: "example.com" },
          { title: "Same page, fragment", url: "https://example.com/path#section", domain: "example.com" },
          { title: "Fetched already", url: "https://fetched.example/doc", domain: "fetched.example" },
        ],
      }),
      fetchPage({ id: "f-1", n: 1, url: "https://fetched.example/doc/", domain: "fetched.example" }),
    ];
    const s = expectMatchesOracle(rows, true);
    // Two of the three search results collapse: one deduped against its own
    // twin, one suppressed because it was fetched (and therefore has an [n]).
    expect(s.alsoFound).toHaveLength(1);
    expect(s.alsoFound[0]?.title).toBe("Canonical");
    expect([...s.registry]).toEqual([1]);
  });

  it("an artifact carrier is read defensively — last VALID entry wins, invalid ones render nothing", () => {
    const artifactId = "22222222-2222-2222-2222-222222222222";
    const pending: ToolStatusEntry = {
      id: `artifact-${artifactId}`,
      tool: "create_pdf_report",
      state: "pending",
      kind: "artifact",
      artifactId,
      title: "Report",
    };
    const ready: ToolStatusEntry = { ...pending, state: "ready" };
    const bogus: ToolStatusEntry = {
      id: `artifact-${artifactId}`,
      tool: "create_pdf_report",
      state: "who-knows",
      kind: "artifact",
      artifactId,
      title: "Report",
    };
    const s = expectMatchesOracle([pending, ready], true);
    expect(s.artifact?.state).toBe("ready");
    // An invalid settle row cannot clobber a valid earlier one (last VALID wins).
    const guarded = expectMatchesOracle([ready, bogus], true);
    expect(guarded.artifact?.state).toBe("ready");
    // A carrier with no valid entry at all yields null, not a partial surface.
    expect(expectMatchesOracle([bogus], true).artifact).toBeNull();
  });

  it("malformed payloads degrade exactly as the oracle degrades — no throw, no partial surface", () => {
    const malformed = [
      // plan carrier whose items is not an array
      { id: "plan-x", tool: "plan", state: "done", kind: "plan", items: "not an array" },
      // unknown kind — falls out of every bucket (D-52)
      { id: "z-1", tool: "web_search", state: "done", kind: "from_the_future" },
      // known tool, no state, no payload fields at all
      { id: "f-bare", tool: "fetch_page" },
      // fetch_page done whose n is a string, not a number
      { id: "f-str", tool: "fetch_page", state: "done", n: "7", url: "https://s.example" },
      // web_search done whose results contains junk entries
      {
        id: "s-junk",
        tool: "web_search",
        state: "done",
        results: [null, { title: "no url" }, { url: 42 }, { title: "ok", url: "https://ok.example" }],
      },
      // an unparseable URL — normalizeUrl's catch branch
      { id: "f-badurl", tool: "fetch_page", state: "done", n: 2, url: "not::a::url/" },
    ] as unknown as ToolStatusEntry[];

    expect(() => deriveRunSurfaces(malformed, false)).not.toThrow();
    const s = expectMatchesOracle(malformed, false);
    expect(s.planItems).toEqual([]); // non-array items → no rows, not a crash
    expect(s.meter).toBeNull();
    expect(s.artifact).toBeNull();
    expect([...s.registry]).toEqual([2]); // the string "7" never registers
    expect(s.alsoFound).toEqual([
      { title: "ok", url: "https://ok.example", domain: "" },
    ]);
  });
});
