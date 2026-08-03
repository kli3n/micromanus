/**
 * components/chat/render-rules.ts — pure render rules for the chat surfaces
 * (03-UAT edge cases EC-06 and EC-08).
 *
 * NO React import and NO client directive at the top of this file, following
 * the `components/chat/RunMeter.tsx` + `tests/run-meter.test.ts` seam: these
 * are decisions, not markup, so a node-env Vitest run can pin them via the `@/`
 * alias without a DOM. The client component that imports them supplies its own
 * directive; a leaf with none is legal in both graphs.
 *
 * EC-08 — an unnamed "Tool · done" row. `toolLineParts` had a bare-label
 * default branch and `deriveRunSurfaces` let ANY payload without a `kind`
 * through, so a `create_pdf_report` row (and any row from a future or forged
 * deploy vintage) reached the rail with no resolved label. `KNOWN_TOOL_NAMES`
 * is the single gate: a name not in it never reaches the renderer, which is
 * what makes the default branch below unreachable defence rather than a
 * user-visible state. It is the same D-52 graceful-absence convention already
 * applied to unknown `kind` values.
 *
 * EC-06 — the degraded artifact path rendered the full report TWICE.
 * `degradedBodyToRender` is the rule that puts it on screen exactly once, and
 * the artifact card's sub-line branches on the SAME value so the copy cannot
 * claim the body is somewhere it is not.
 *
 * RC-02 — this rule is only half a fix without its PRODUCER. It reads the
 * carrier's `markdown`, and `artifactCarrierPayload` did not write one, so it
 * returned `null` on every real degraded artifact: the body-below block was
 * dead code in production and the card always claimed the report was in the
 * answer above, which the system prompt guarantees it is not. The producer now
 * attaches the body on the degraded branch (`lib/artifacts/db.ts`). Read the two
 * files together — a consumer rule that nothing feeds is indistinguishable from
 * a correct one until someone traces the producer.
 */

/**
 * The tools this deploy can name. EC-08's single gate — `deriveRunSurfaces`
 * filters the tool-line list through it, so no row can reach `toolLineParts`
 * without a branch that resolves a real label.
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "fetch_page",
  "create_pdf_report",
]);

/** The three rendered spans of one tool-status line. */
export interface ToolLineParts {
  label: string;
  text: string;
  meta: string;
}

/**
 * Structural input — the fields of `ToolStatusEntry` this rule reads. Declared
 * here rather than imported so the module stays free of the ChatThread client
 * component; `ToolStatusEntry` satisfies it by construction.
 */
export interface ToolLineInput {
  tool: string;
  state?: string;
  query?: string;
  url?: string;
  domain?: string;
  resultCount?: number;
  tokensApprox?: number;
  note?: string;
  title?: string;
  /**
   * Emitted by the loop and read here for FORWARD-COMPATIBILITY ONLY — the
   * client derives its own copy and deliberately ignores these (see below).
   */
  label?: string;
  meta?: string;
}

/**
 * Resolve one tool-status line's copy from the `tool` + `state` discriminators.
 *
 * The `create_pdf_report` branch DERIVES its label and meta and IGNORES the
 * payload's own `label`/`meta` strings (T-03-15-05). Two reasons, both load
 * bearing: persisted rows are untrusted the same way `parseArtifactCarrier`
 * treats its input — a stale or crafted row must not be able to inject
 * arbitrary text into the rail — and the currently-emitted RUNNING payload
 * carries the wrong meta (it repeats the DONE row's `renders after the run`
 * where the UI-SPEC contract calls for the queued wording below), so trusting
 * the payload would ship that discrepancy rather than close it.
 */
export function toolLineParts(t: ToolLineInput): ToolLineParts {
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
      text: running ? (t.url ? ` · ${t.url}` : "") : t.domain ? ` · ${t.domain}` : "",
      meta: t.note
        ? t.note
        : running
          ? "fetching…"
          : `${(t.tokensApprox ?? 0).toLocaleString()} tok`,
    };
  }
  if (t.tool === "create_pdf_report") {
    // UI-SPEC Copywriting Contract rows "Tool status — create_pdf_report
    // running / done". Do not reword.
    return running
      ? { label: "Preparing report", text: "", meta: "queued…" }
      : {
          label: "Report queued",
          text: t.title ? ` · ${t.title}` : "",
          meta: "renders after the run",
        };
  }
  // UNREACHABLE in the wired render path: `deriveRunSurfaces` filters the line
  // list through KNOWN_TOOL_NAMES first, so a tool with no branch above never
  // gets here. Kept as defence for any future caller that forgets the filter.
  return { label: "Tool", text: "", meta: running ? "…" : "done" };
}

/**
 * What (if anything) renders BENEATH a degraded artifact card (EC-06/RC-02).
 *
 * Returns the carrier markdown when it is a non-empty string whose trimmed
 * value differs from the trimmed answer content; `null` otherwise.
 *
 * `null` means "the answer bubble above already carries this text". D-43's
 * substantive guarantee ("the user always receives the report content
 * regardless") holds in both outcomes — but ONLY because the producer supplies
 * the body on a degraded carrier (`artifactCarrierPayload`, RC-02). That
 * conditional is the whole point of this comment: for one round it read as an
 * unconditional property of this function, while in production the carrier
 * never had markdown, so `null` was returned for EVERY degraded artifact and
 * the user genuinely lost a report that differed from the answer. If the
 * producer ever stops attaching it, this rule silently regresses to that state
 * again — `tests/artifact-settle.test.ts` pins the producer for exactly that
 * reason.
 *
 * The pre-EC-06 code fell back to the answer content whenever the carrier had
 * no markdown of its own, which rendered the identical body twice: once in the
 * answer bubble and again below the card. Only D-43's incidental phrase
 * "rendered in-chat below it" narrows, because honouring that phrase literally
 * is what produced the duplicate.
 */
export function degradedBodyToRender(args: {
  carrierMarkdown?: string | null;
  answerContent?: string | null;
}): string | null {
  const carrier = args.carrierMarkdown;
  if (typeof carrier !== "string") return null;
  const trimmed = carrier.trim();
  if (trimmed.length === 0) return null;
  const answer = typeof args.answerContent === "string" ? args.answerContent : "";
  if (trimmed === answer.trim()) return null;
  return carrier;
}
