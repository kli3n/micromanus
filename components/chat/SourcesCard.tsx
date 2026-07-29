/**
 * SourcesCard (RSCH-02 / D-36, D-37 — 03-03).
 *
 * Terminal-only card listing the pages the agent READ ([n]-badged whole-row
 * anchors, sorted ascending by stored n — never array order, Pitfall 10) and
 * an "Also found" recessive block for search hits the agent did NOT open —
 * which never carry a number badge (D-36's one-notation rule).
 *
 * Timing (CLS contract): appears once, complete, at terminal state — it never
 * grows incrementally beneath a streaming answer [BD §8]. Each source row has
 * id="src-{n}" so inline citation anchors jump here; the arrived-at row gets
 * a static :target highlight (globals.css, deliberately un-animated).
 *
 * Absence (D-52): both lists empty -> null. No shell, no placeholder.
 *
 * Icons are inline svg (lucide geometry, 2px stroke, currentColor) —
 * lucide-react must NOT be installed (03-UI-SPEC Amendment A1).
 */

export interface SourceRow {
  n: number;
  title: string;
  url: string;
  domain: string;
}

export interface FoundRow {
  title: string;
  url: string;
  domain: string;
}

/** lucide "external-link" geometry — 12px row glyph. */
function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3"
      aria-hidden="true"
    >
      <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

/** lucide "chevron-right" geometry — 11px details/summary chevron. */
function ChevronIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[11px] w-[11px]"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function FoundEntries({ entries }: { entries: FoundRow[] }) {
  return (
    <ul className="m-0 list-none p-0">
      {entries.map((e, i) => (
        <li
          key={i}
          className="flex items-baseline gap-[7px] py-[2px] text-[12.5px] text-[var(--text-2)]"
        >
          <span aria-hidden="true" className="flex-none text-[var(--text-3)]">
            •
          </span>
          <span className="min-w-0 flex-1 truncate" title={e.title}>
            {e.title}
          </span>
          <span
            className="ml-auto flex-none whitespace-nowrap text-[11px]"
            style={{ fontFamily: "var(--mono)" }}
          >
            {e.domain}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Also found" recessive block — NO number badge, ever (D-36). More than 4
 * entries collapse into a native <details> whose chevron rotates via
 * transform (compositor-only; none under reduced motion).
 */
function AlsoFoundList({ entries }: { entries: FoundRow[] }) {
  return (
    <div className="mt-[10px] border-t border-[var(--border)] pt-[10px]">
      <div className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-[10px] py-[8px]">
        <div className="text-[11px] font-[700] uppercase tracking-[.05em] text-[var(--text-2)]">
          Also found
        </div>
        <div className="mt-[3px] mb-[6px] text-[11px] text-[var(--text-2)]">
          Search results the agent did not open.
        </div>
        {entries.length > 4 ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-[6px] pt-[4px] text-[11.5px] text-[var(--text-2)] focus-visible:rounded-[3px] focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-none [&::-webkit-details-marker]:hidden">
              <span
                aria-hidden="true"
                className="flex-none transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
              >
                <ChevronIcon />
              </span>
              Also found · {entries.length} more results
            </summary>
            <FoundEntries entries={entries} />
          </details>
        ) : (
          <FoundEntries entries={entries} />
        )}
      </div>
    </div>
  );
}

export function SourcesCard({
  sources,
  alsoFound,
}: {
  sources: SourceRow[];
  alsoFound: FoundRow[];
}) {
  if (sources.length === 0 && alsoFound.length === 0) return null; // D-52
  return (
    <div
      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-[14px] py-[12px]"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <div className="mb-[4px] flex items-center gap-[8px]">
        <span className="text-[12.5px] font-[600] text-[var(--text)]">
          Sources
        </span>
        <span
          className="ml-auto flex-none text-[11px] text-[var(--text-2)]"
          style={{ fontFamily: "var(--mono)" }}
        >
          {sources.length} read
        </span>
      </div>
      {sources.length > 0 && (
        <ol className="m-0 list-none p-0">
          {sources.map((s) => (
            <li key={s.n}>
              <a
                id={`src-${s.n}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Source ${s.n}: ${s.title} (${s.domain}) — opens in a new tab`}
                className="src-row flex min-h-[34px] items-center gap-[10px] rounded-[var(--radius-sm)] px-[10px] py-[7px] text-inherit no-underline transition-colors hover:bg-[var(--surface-2)] focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-none motion-reduce:transition-none"
              >
                <span
                  className="min-w-[30px] flex-none rounded-[var(--radius-sm)] border border-[var(--accent-line)] bg-[var(--accent-soft)] px-[5px] py-[1px] text-center text-[11px] text-[var(--accent)]"
                  style={{ fontFamily: "var(--mono)" }}
                >
                  [{s.n}]
                </span>
                <span
                  className="min-w-0 truncate text-[13px] leading-[1.4] text-[var(--text)]"
                  title={s.title}
                >
                  {s.title}
                </span>
                <span
                  className="ml-auto flex-none whitespace-nowrap text-[11px] text-[var(--text-2)]"
                  style={{ fontFamily: "var(--mono)" }}
                >
                  {s.domain}
                </span>
                <span className="flex-none text-[var(--text-2)]">
                  <ExternalLinkIcon />
                </span>
              </a>
            </li>
          ))}
        </ol>
      )}
      {alsoFound.length > 0 && <AlsoFoundList entries={alsoFound} />}
    </div>
  );
}
