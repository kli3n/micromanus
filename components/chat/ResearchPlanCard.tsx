/**
 * ResearchPlanCard (RSCH-01 / D-31–D-34, D-52 — 03-03).
 *
 * Presentational card showing the agent's 3–5 sub-question decomposition.
 * Rendered once, complete, the moment the plan block is parsed — it never
 * gains or loses rows; only per-row opacity changes (CLS contract, [BD §8]).
 *
 * Row resolution (derived identically from live SSE state and replayed rows —
 * D-25 parity): row i is resolved when i < count of DONE web_search entries
 * for this message, OR the run is terminal. A resolved row greys its TEXT
 * SPAN via opacity .55 (compositor-only, 140ms, none under reduced motion) —
 * the row never changes height, never reflows, never disappears.
 *
 * Absence (D-52): when the model omitted the plan block, `items` is empty and
 * the component returns null. No skeleton, no reserved slot, no error.
 *
 * Icons are inline svg (lucide geometry, 2px stroke, currentColor) — the
 * lucide-react package must NOT be installed (03-UI-SPEC Amendment A1).
 */

export interface PlanRowItem {
  text: string;
  resolved: boolean;
}

/** lucide "list-checks" geometry — 14px header glyph. */
function ListChecksIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[14px] w-[14px]"
      aria-hidden="true"
    >
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  );
}

/** The existing CheckIcon geometry at the demo's 13px plan-row size. */
function PlanCheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[13px] w-[13px]"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function ResearchPlanCard({ items }: { items: PlanRowItem[] }) {
  if (items.length === 0) return null; // D-52 graceful absence
  return (
    <div
      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[14px] py-[12px]"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <div className="mb-[6px] flex items-center gap-[8px]">
        <span className="flex-none text-[var(--text-2)]">
          <ListChecksIcon />
        </span>
        <span className="text-[12.5px] font-[600] text-[var(--text)]">
          Research plan
        </span>
        <span
          className="ml-auto flex-none text-[11px] text-[var(--text-2)]"
          style={{ fontFamily: "var(--mono)" }}
        >
          {items.length} sub-questions
        </span>
      </div>
      <ol className="m-0 list-none p-0">
        {items.map((item, i) => (
          <li key={i} className="flex h-[26px] items-center gap-[10px]">
            <span
              className="grid w-4 flex-none place-items-center"
              aria-hidden="true"
            >
              {item.resolved ? (
                <span className="text-[var(--success)]">
                  <PlanCheckIcon />
                </span>
              ) : (
                <span className="h-[5px] w-[5px] rounded-full bg-[var(--border-strong)]" />
              )}
            </span>
            <span
              title={item.text}
              className={
                "min-w-0 flex-1 truncate text-[14px] leading-[1.5] text-[var(--text)] transition-opacity duration-[140ms] motion-reduce:transition-none" +
                (item.resolved ? " opacity-[.55]" : "")
              }
            >
              <span className="sr-only">
                {item.resolved ? "done — " : "in progress — "}
              </span>
              {item.text}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
