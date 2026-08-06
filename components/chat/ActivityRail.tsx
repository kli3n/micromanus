"use client";

import { type ReactNode, useEffect, useState } from "react";
import { meterLabel } from "@/components/chat/RunMeter";

/**
 * ActivityRail (D-64/65/66, 04-09) — one visually contained "research
 * activity" block per research turn: the plan card, the run meter and the
 * tool-status rows render inside a single native disclosure card, clearly
 * bounded from the answer below it (the deep-research convention: the agent
 * working is contained, the answer is the product).
 *
 * PRESENTATION ONLY — this component is a render-layer grouping and nothing
 * more. It takes the already-derived surfaces as SLOTS plus the run's terminal
 * flag and the numbers its summary needs. It must not call the run-surface
 * derivation itself (one function feeds the live and replayed paths, and that
 * fact alone is the D-25/26/27 parity contract — a rail-specific second
 * derivation would fork it, T-04-45), it reads nothing from the database and
 * it performs no network I/O (T-04-46). It changes nothing persisted: the
 * expanded state after terminal is EPHEMERAL client state, deliberately not
 * persisted (R-5 names "persist the rail's expanded state" as the specific
 * well-meaning way terminal-once persistence could gain a partial write).
 *
 * DISCLOSURE FORM — Form A (the Tailwind/client form from SourcesCard's
 * "Also found" block), chosen deliberately: the rail lives inside the
 * already-client ChatThread, so the `group-open:` variant form is the right
 * one and needs no server-rendered stylesheet. `list-none` MUST stay in the
 * summary class list — Form A depends on it for the Firefox marker (the
 * webkit pseudo-element utility only covers Safari/Chrome); dropping it
 * brings the marker back on one engine. Form A's legacy pale-accent-wash
 * box-shadow focus ring is NOT copied: plan 04-04 landed the single app-wide
 * :focus-visible rule (D-70) and this element inherits it, so the summary
 * carries no focus declaration at all.
 *
 * ARIA (adjudication T-3, binding — recorded here so a later reader cannot
 * reintroduce it): do NOT put an expanded-state ARIA attribute (aria-expanded)
 * on the summary. A native disclosure exposes its expanded state through the
 * user agent, and adding the attribute produces redundant or conflicting
 * ARIA. Only a CUSTOM toggle needs one, and this phase's only custom toggle
 * is the drawer hamburger in components/NavDrawer.tsx. 04-CONTEXT.md's D-71
 * wording invites the opposite reading; the UI-SPEC's is authoritative: the
 * summary carries an aria-label and the expanded state is conveyed by native
 * disclosure semantics. Two further native-disclosure rules: the summary is
 * the FIRST child of the disclosure element, and it contains NO interactive
 * element — result links live in the expanded tool-row panels, never here.
 *
 * STATE MACHINE — open while running; closed on terminal; a user's
 * post-terminal toggle sticks. React treats the open attribute as controlled,
 * but a user can toggle a native disclosure in the DOM without React knowing
 * — so a bare derived `open={...}` with no toggle handler means every
 * subsequent parent render forces it closed again, and the parent re-renders
 * constantly (T-04-48: looks correct in review, fails only in use). Instead:
 * the state is SEEDED with a lazy useState initialiser from the terminal flag
 * (byte-identical first paint on a live tab and a reopened tab, because the
 * flag derives from the persisted run row — the D-25 parity property), an
 * effect keyed on that flag closes it ONCE at the terminal transition (which
 * is also the CLS contract: collapse happens only at the terminal transition,
 * never mid-scroll and never on reconnect), and onToggle writes the element's
 * own open state back into React so a user toggle survives parent renders.
 * Collapsing the rail hides the polite live region inside it — fine at
 * terminal, and the flag-keyed effect is what guarantees it can never happen
 * mid-run (T-04-47).
 *
 * MOTION — the panel does not animate at all; only the chevron rotates, by
 * transform over 150ms with a motion-reduce variant. Every known technique
 * for sliding a disclosure panel open animates the panel's height, a layout
 * property design/BROWSER-DESIGN.md §5 forbids animating. The deliberately
 * un-animated .src-row:target rule in app/globals.css is the in-repo
 * precedent: a static state has nothing to disable under reduced motion and
 * zero compositor cost.
 *
 * SUMMARY COPY — the locked D-55/56 terminal meter string is preserved as a
 * BYTE-IDENTICAL SUFFIX (imported from meterLabel, the single source of that
 * copy) behind an additive sources prefix: "Researched {s} source{s} · " +
 * "{n} iterations · {m}:{ss}". Singular "1 source"; when the run read ZERO
 * sources the prefix is omitted ENTIRELY and the summary is exactly the
 * locked string — never a zero-sources phrasing. This construction (prefix +
 * verbatim suffix, never a reformatted line) is what satisfies the copy lock
 * and D-65's fold-the-footnote rule at once.
 */
export function ActivityRail({
  terminal,
  sourcesCount,
  iterations,
  elapsedMs,
  plan,
  activity,
}: {
  /** Derived from the persisted run row — identical on live and reopened tabs. */
  terminal: boolean;
  /** Count of numbered sources the run read (the derivation's sources rows). */
  sourcesCount: number;
  /** Terminal meter iterations — same value the RunMeter renders at terminal. */
  iterations: number;
  /** Server-computed ended_at - started_at from the meter carrier payload. */
  elapsedMs?: number;
  /** Slot: the research plan card, or null when the run had none (D-52). */
  plan?: ReactNode;
  /** Slot: the meter + tool-rows group (meter first, outside the polite region). */
  activity?: ReactNode;
}) {
  // Lazy initialiser: seeded ONCE from the persisted-row-derived terminal
  // flag, so a reopened tab's first paint matches the live tab's (D-25).
  const [open, setOpen] = useState(() => !terminal);

  // Fires once per terminal TRANSITION (not per render) — the only moment the
  // rail may auto-collapse. A post-terminal user toggle is untouched by it.
  useEffect(() => {
    if (terminal) setOpen(false);
  }, [terminal]);

  // E1 empty: no plan card, no meter, no tool rows — render nothing at all;
  // never an empty container and never a no-activity line (D-52).
  if (!plan && !activity) return null;

  const locked = meterLabel({
    running: false,
    iterations,
    // A defensively-missing elapsed renders 0:00 (formatElapsed clamps NaN),
    // mirroring the RunMeter's own terminal branch — never a client recompute.
    elapsedMs: elapsedMs ?? Number.NaN,
  });
  const summaryText =
    sourcesCount > 0
      ? `Researched ${sourcesCount} source${sourcesCount === 1 ? "" : "s"} · ${locked}`
      : locked;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="group rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[14px] py-[12px] shadow-[var(--shadow-sm)]"
    >
      {/* First child of the disclosure element, no interactive content. */}
      <summary
        className="-mx-[14px] -my-[12px] flex min-h-[36px] cursor-pointer list-none items-center gap-[10px] rounded-[var(--radius-sm)] px-[14px] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-2)] group-open:mb-[2px] motion-reduce:transition-none [&::-webkit-details-marker]:hidden"
        // aria-label="Research activity: {summary text}. Expand for details."
        // (UI-SPEC Copywriting Contract, "Rail — summary aria" row) — applied
        // at terminal, where the collapsed summary text exists; while running
        // the visible header text below is the accessible name.
        aria-label={
          terminal
            ? `Research activity: ${summaryText}. Expand for details.`
            : undefined
        }
      >
        {/* 14px chevron-right, 2px stroke, currentColor, decorative — the
            stats-page glyph geometry; rotates 90° on open via transform. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[14px] w-[14px] flex-none transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        {terminal ? (
          /* Collapsed one-liner: mono 13px, tabular figures so the numeric
             tail never reflows as digits change; single line with ellipsis. */
          <span
            className="min-w-0 flex-1 truncate text-[13px]"
            style={{
              fontFamily: "var(--mono)",
              fontVariantNumeric: "tabular-nums",
            }}
            title={summaryText}
          >
            {summaryText}
          </span>
        ) : (
          /* Running header — the live meter itself stays the first row INSIDE
             the (open) rail body, outside any polite region. */
          <span className="flex min-w-0 items-center gap-[8px] text-[12.5px] font-semibold text-[var(--text)]">
            <span className="agent-spinner" aria-hidden="true" />
            Research activity
          </span>
        )}
      </summary>
      {/* The panel appears/disappears with no animation (see header). */}
      <div className="pt-[10px]">
        {plan}
        {activity}
      </div>
    </details>
  );
}
