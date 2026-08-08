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
 * WR-08 (T-03-10-01): a row's `url` arrives off a PERSISTED role='tool' row, so it
 * is untrusted the same way parseArtifactCarrier treats its input (T-3-60). Every
 * numbered row's url therefore passes through `isSafeHref` — the shared
 * render-boundary scheme allow-list — before it can become an href. A url that
 * fails renders as an INERT row of identical geometry that still carries the
 * `src-{n}` id, so a citation jump from the answer body still lands and the
 * fixed-height / no-CLS contract (03-UI-SPEC) holds either way.
 *
 * Icons are inline svg (lucide geometry, 2px stroke, currentColor) —
 * lucide-react must NOT be installed (03-UI-SPEC Amendment A1).
 */
import { isSafeHref } from "@/lib/net/safe-href";

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

/**
 * lucide "circle-slash" geometry — the 12px trailing glyph for a row whose url
 * could not become a link. Occupies the SAME 12px box as ExternalLinkIcon so the
 * two row branches are geometrically identical (no layout difference, no CLS).
 */
function WithheldLinkIcon() {
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
      <circle cx="12" cy="12" r="10" />
      <path d="m4.9 4.9 14.2 14.2" />
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
          {/* --text-3 retained: DECORATIVE — an aria-hidden list bullet whose
              meaning is carried by the list structure itself (04-11 sweep). */}
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
            {/* Keyboard focus is the single app-wide D-70 outline ring
                (app/globals.css) — no per-control declaration here. */}
            <summary className="flex cursor-pointer list-none items-center gap-[6px] pt-[4px] text-[11.5px] text-[var(--text-2)] [&::-webkit-details-marker]:hidden">
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

/**
 * The layout-bearing row classes — shared VERBATIM by both branches so the linked
 * and the withheld row are the same height and the same box (no CLS). The anchor
 * adds a hover affordance on top; that is colour only and changes no geometry,
 * and a non-anchor is not focusable so it would be dead there anyway. Keyboard
 * focus comes from the single app-wide D-70 outline ring (app/globals.css) —
 * an outline with an offset sits entirely OUTSIDE layout, so the original
 * choice here (affordances that change no geometry) survives the swap even
 * more strongly than the shadow form it replaces.
 */
const SOURCE_ROW_CLASS =
  "src-row flex min-h-[34px] items-center gap-[10px] rounded-[var(--radius-sm)] px-[10px] py-[7px] text-inherit no-underline";

const SOURCE_ROW_INTERACTIVE_CLASS =
  " transition-colors hover:bg-[var(--surface-2)] motion-reduce:transition-none";

/**
 * The row's visible content — badge, title, domain, trailing glyph — factored out
 * so the linked and withheld branches provably render the SAME thing in the same
 * order. Only the trailing glyph differs, and both glyphs are the same 12px box.
 */
function SourceRowBody({
  s,
  linked,
}: {
  s: SourceRow;
  linked: boolean;
}) {
  return (
    <>
      {/* Contrast (04-11 + 260808-nec): the [n] badge drops its pale accent wash
          — --accent text on that fill measures 4.43:1 (the fourth measured AA
          pair, under the 4.5:1 bar) — and the accent-line border keeps the
          badge's outline. Dropping the wash was only half the story: the wash
          comes BACK underneath this badge in the `.src-row:target` state
          (app/globals.css), which a citation click reaches, and that is the
          state live axe measured at 4.42. So the badge text now sits on
          --accent-hover, which clears AA in BOTH states — 6.32:1 on the
          --accent-soft :target fill, and darker still on the card surface
          (--accent read 5.18:1 there). */}
      <span
        className="min-w-[30px] flex-none rounded-[var(--radius-sm)] border border-[var(--accent-line)] px-[5px] py-[1px] text-center text-[11px] text-[var(--accent-hover)]"
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
      {/* Both trailing glyphs at --text-2 (04-11 sweep): the withheld glyph is
          a state signal, not decoration, and --text-3 sat at 3.03:1 — at the
          non-text floor on the surface and under it on the hover fill. */}
      <span className="flex-none text-[var(--text-2)]">
        {linked ? <ExternalLinkIcon /> : <WithheldLinkIcon />}
      </span>
    </>
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
          {sources.map((s) => {
            // WR-08: the ONLY value that may reach href. A persisted url whose
            // scheme is not http(s) never becomes an anchor.
            const safeHref = isSafeHref(s.url) ? s.url : undefined;
            return (
              <li key={s.n}>
                {safeHref ? (
                  <a
                    id={`src-${s.n}`}
                    href={safeHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Source ${s.n}: ${s.title} (${s.domain}) — opens in a new tab`}
                    className={SOURCE_ROW_CLASS + SOURCE_ROW_INTERACTIVE_CLASS}
                  >
                    <SourceRowBody s={s} linked />
                  </a>
                ) : (
                  /* Inert twin: same id so a `#src-n` citation jump still lands and
                     still gets the .src-row:target highlight, same box so nothing
                     shifts — but no href, no target, no rel. */
                  <span
                    id={`src-${s.n}`}
                    aria-label={`Source ${s.n}: ${s.title} (${s.domain}) — link withheld, this address is not a web link`}
                    className={SOURCE_ROW_CLASS}
                  >
                    <SourceRowBody s={s} linked={false} />
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {alsoFound.length > 0 && <AlsoFoundList entries={alsoFound} />}
    </div>
  );
}
