/**
 * components/chat/derive-run-surfaces.ts — the ONE derivation that turns an
 * ordered `role='tool'` payload list into every rendered run surface
 * (03-03 payload contract; D-25/26/27 live-vs-replay parity).
 *
 * NO React import and NO client directive at the top of this file, following
 * the `components/chat/RunMeter.tsx` + `tests/run-meter.test.ts` seam that
 * `components/chat/render-rules.ts` already applies: this is a decision, not
 * markup, so a node-env Vitest run can pin it via the `@/` alias without a DOM.
 * The client component that imports it supplies its own directive; a leaf with
 * none is legal in both graphs.
 *
 * WHY IT LIVES HERE AT ALL (04-03 Task 1, Pitfall 6 / R-4). Until this file it
 * was a NON-EXPORTED function inside a 1 460-line client component, and
 * `vitest.config.ts` collects only `lib/**` + `tests/**` `.ts` files — never a
 * `.tsx`. So it was structurally untestable while simultaneously carrying:
 *   - the D-25 parity contract (live SSE state and replayed persisted rows feed
 *     THIS function and nothing else, which is what makes a reopened tab render
 *     byte-identical surfaces),
 *   - the citation registry, whose append-only integer set is what guarantees
 *     `remarkCitations` can only ever emit a literal `#src-{n}` href — no
 *     model-controlled URL can enter an anchor from prose (T-04-11),
 *   - the plan-row resolution rule (derived, never stored — D-31/D-52),
 *   - the EC-08 `KNOWN_TOOL_NAMES` gate,
 *   - and the "Also found" normalize-and-dedupe rule (D-36/D-37).
 * The whole D-64 activity rail is built on top of it. Extraction is what made
 * `tests/derive-run-surfaces.test.ts` possible, and that suite's inlined
 * `preMoveDeriveRunSurfaces` oracle is what proves the move changed nothing.
 *
 * THE BODY BELOW WAS MOVED UNCHANGED from `components/ChatThread.tsx:215-318`.
 * It must STAY a single derivation: no second derivation, no rail-specific
 * variant, no parallel path for live versus replayed rows — that would fork the
 * D-25/26/27 parity contract, which is the one thing this seam exists to hold.
 *
 * Imports: the row types are `import type` (erased at build, so they drag no
 * component into this graph). `parseArtifactCarrier` is the one VALUE import —
 * it is the defensive read-validation of an untrusted persisted carrier row and
 * moving it here too would have made this a rewrite rather than a move. It is
 * already proven node-testable on its own (`tests/artifact-carrier.test.ts`
 * imports it from the same module in the same environment).
 */

import {
  parseArtifactCarrier,
  type ArtifactCarrier,
} from "@/components/chat/ArtifactCard";
import { KNOWN_TOOL_NAMES } from "@/components/chat/render-rules";
import type { PlanRowItem } from "@/components/chat/ResearchPlanCard";
import type { FoundRow, SourceRow } from "@/components/chat/SourcesCard";

/**
 * A single live/persisted tool-status line (CHAT-06 / D-29). Payload shape is
 * emitted by the loop's `tool_status` SSE event AND persisted as the JSON content
 * of a role='tool' message row, so the live and reopened renders are identical.
 *
 * Phase 3 (03-03 payload contract — the server emits these shapes in 03-04):
 * payloads gain a `kind` discriminator. Rows WITHOUT kind are the existing
 * web_search / fetch_page tool lines (unchanged shape). kind "plan" carries
 * the research-plan items; kind "meter" is the run-meter carrier; kind
 * "artifact" is the PDF report carrier (03-05/03-06 — pending/ready/degraded,
 * settled over the SAME messages Realtime channel by an UPDATE after the SSE
 * stream closed, D-46); unknown or unparseable kinds render NOTHING (D-52
 * graceful absence). fetch_page DONE payloads gain {n, title} on successful
 * fetches; web_search DONE payloads gain {results}.
 *
 * Moved here from `ChatThread.tsx` and RE-EXPORTED from there, so any existing
 * importer keeps working unchanged.
 */
export interface ToolStatusEntry {
  id: string;
  tool: string; // "web_search" | "fetch_page"
  state: string; // "running" | "done"
  query?: string;
  url?: string;
  domain?: string;
  resultCount?: number;
  tokensApprox?: number;
  note?: string;
  // --- Phase 3 additions (03-03 interfaces block, LOCKED) ---
  kind?: string; // "plan" | "meter" | "artifact" — absent on plain tool lines
  items?: string[]; // kind "plan": 1..8 sub-questions
  startedAt?: string; // kind "meter": ISO runs.started_at
  iterations?: number; // kind "meter", terminal: final count
  elapsedMs?: number; // kind "meter", terminal: ended_at - started_at (server-computed)
  n?: number; // fetch_page done: server-assigned source number
  title?: string; // fetch_page done: page title | kind "artifact": report title
  results?: { title: string; url: string; domain: string }[]; // web_search done, <= 8
  // --- kind "artifact" (03-05 carrier contract, validated on read) ---
  artifactId?: string; // kind "artifact": artifacts row id for the download route
  markdown?: string; // kind "artifact", DEGRADED state only: the report body (RC-02)
  // The loop emits these on create_pdf_report rows, so the interface should not
  // silently omit them — but the client DERIVES its own copy from tool + state
  // and never reads them (T-03-15-05: a persisted row is untrusted, and the
  // running payload's meta contradicts the UI-SPEC contract today). Present for
  // forward-compatibility only; see components/chat/render-rules.ts.
  label?: string;
  meta?: string;
}

/**
 * Normalized URL for alsoFound matching (interfaces derivation rule):
 * lowercase host, no trailing slash, no fragment.
 *
 * Deliberately module-private and deliberately NOT the `normalizeUrl` in
 * `lib/agent/sources.ts`: that one is the SERVER's key for the per-run
 * failed-fetch memo and the source registry (EC-03), this one is a render-time
 * dedupe key. Nothing reads across the seam, so the two cannot be
 * consolidated without deciding which side owns the other — and the whole
 * point of this plan is a move, not a merge.
 */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw.toLowerCase().replace(/#.*$/, "").replace(/\/+$/, "");
  }
}

export interface RunSurfaces {
  planItems: PlanRowItem[];
  meter: ToolStatusEntry | null;
  lines: ToolStatusEntry[];
  registry: Set<number>;
  sources: SourceRow[];
  alsoFound: FoundRow[];
  artifact: ArtifactCarrier | null;
}

/**
 * Derive every 03-03 surface from ONE ordered payload list — applied
 * identically to live SSE state and persisted-row replay, so a reopened tab
 * renders byte-identical surfaces (D-25 parity for free). Unknown kinds fall
 * out of every bucket and render nothing (D-52).
 */
export function deriveRunSurfaces(
  tools: ToolStatusEntry[],
  terminal: boolean,
): RunSurfaces {
  const plan = tools.find((t) => t.kind === "plan") ?? null;
  const meter = tools.find((t) => t.kind === "meter") ?? null;
  // EC-08's single gate: a row without a `kind` is a tool line, but only a tool
  // this deploy can NAME may reach the renderer — otherwise it paints an
  // unnamed "Tool · done". Same D-52 graceful-absence convention already
  // applied to unknown `kind` values.
  const lines = tools.filter(
    (t) => t.kind == null && KNOWN_TOOL_NAMES.has(t.tool),
  );

  // Artifact carrier (RSCH-03, D-46): validated defensively on read — rows
  // from any deploy vintage are untrusted (T-3-60), so an unknown state or a
  // missing artifactId renders NOTHING. Last valid entry wins: the settle
  // UPDATE (ready/degraded) supersedes the pending insert on the same row.
  let artifact: ArtifactCarrier | null = null;
  for (const t of tools) {
    if (t.kind !== "artifact") continue;
    const parsed = parseArtifactCarrier(t);
    if (parsed) artifact = parsed;
  }

  const doneSearchCount = lines.filter(
    (t) => t.tool === "web_search" && t.state === "done",
  ).length;
  // Plan-row resolution rule (interfaces block): row i is resolved when
  // i < (count of DONE web_search entries for this message) OR the run is
  // terminal — derived, never stored, so reopen parity is free (D-31/D-52).
  const rawItems = plan && Array.isArray(plan.items) ? plan.items : [];
  const planItems: PlanRowItem[] = rawItems.map((text, i) => ({
    text: String(text),
    resolved: terminal || i < doneSearchCount,
  }));

  // Citation registry + Sources rows: fetch_page done entries carrying n,
  // sorted ascending by stored n — NEVER array order (Pitfall 10).
  const registry = new Set<number>();
  const sources: SourceRow[] = [];
  const fetched = new Set<string>();
  for (const t of lines) {
    if (t.tool !== "fetch_page") continue;
    if (t.url) fetched.add(normalizeUrl(t.url));
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

  // "Also found": union of web_search results whose normalized URL was never
  // fetched, deduped, order preserved (D-36/D-37).
  const seen = new Set<string>();
  const alsoFound: FoundRow[] = [];
  for (const t of lines) {
    if (t.tool !== "web_search" || t.state !== "done") continue;
    for (const r of t.results ?? []) {
      if (!r || typeof r.url !== "string") continue;
      const key = normalizeUrl(r.url);
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
