"use client";

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "@/components/hooks/useReducedMotion";

/**
 * ArtifactCard (RSCH-03/RSCH-04, D-39, D-43, D-46) — the PDF report download
 * card. ONE fixed 72px box across all three states (the phase's central CLS
 * contract, UI-SPEC § [6]): the right slot reserves 112×34 in every state so
 * the Download button appearing shifts nothing, and pending → ready/degraded
 * is an opacity cross-fade of the inner content only inside the fixed box.
 *
 * States (locked copy — do not paraphrase):
 *   pending  — title {title} · "Preparing PDF…" · spinner in the accent tile
 *   ready    — title {title}.pdf · "PDF · generated from this research" ·
 *              "Download" primary button (34px)
 *   degraded — 🔒 "PDF unavailable" · sub-line branches on `bodyBelow`: the
 *              "…report is below." variant when a body renders beneath the
 *              card, the "…in the answer above." variant when the streamed
 *              answer already carries that exact text (EC-06 — the report
 *              reaches the screen once, never twice). WARNING family,
 *              never error red (a failed PDF is a graceful degrade with the
 *              report intact, D-43). The TITLE is the locked string; the
 *              sub-line is not (03-UI-SPEC Copywriting Contract, re-scoped
 *              against CONTEXT D-43 + 03-VERIFICATION.md's exact-copy list).
 *
 * Download (D-39): each click fetches a FRESH ~60s signed URL from the
 * ownership-checked route and navigates immediately — the URL is never stored
 * in state or DOM attributes beyond the click (T-3-61). A download failure
 * renders the inline warning copy; the card state itself never changes.
 */

export type ArtifactState = "pending" | "ready" | "degraded";

export interface ArtifactCarrier {
  artifactId: string;
  title: string;
  state: ArtifactState;
  /**
   * The report body, present on a DEGRADED carrier only (RC-02). It is the sole
   * remaining route to the report when Chromium failed — D-43's substantive
   * guarantee — so `degradedBodyToRender` renders it beneath the card and the
   * card's own sub-line branches on the same verdict.
   *
   * Still OPTIONAL, and that is not vestigial: `pending` and `ready` carriers
   * never carry it, and rows written by a pre-RC-02 deploy vintage do not
   * either. Absence therefore falls back to the "…in the answer above."
   * sub-line, which is the D-52 graceful-absence idiom, not a fresh gap.
   */
  markdown?: string;
}

/**
 * Defensive read-validation of a persisted {kind:'artifact'} carrier payload
 * (AI-SPEC § 4b artifactCarrier guard, T-3-60). Rows can come from any deploy
 * vintage, so the client treats them as untrusted: state must be one of the
 * three known values and artifactId a non-empty string — anything else
 * returns null and the row renders NOTHING (the D-52 forward-compat idiom).
 */
export function parseArtifactCarrier(raw: unknown): ArtifactCarrier | null {
  if (raw == null || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (p.kind !== "artifact") return null;
  if (typeof p.artifactId !== "string" || p.artifactId.length === 0) return null;
  if (p.state !== "pending" && p.state !== "ready" && p.state !== "degraded") {
    return null;
  }
  return {
    artifactId: p.artifactId,
    title:
      typeof p.title === "string" && p.title.length > 0
        ? p.title
        : "Research report",
    state: p.state,
    markdown:
      typeof p.markdown === "string" && p.markdown.length > 0
        ? p.markdown
        : undefined,
  };
}

/** file-text glyph (UI-SPEC Amendment A1: inline svg, 2px stroke, currentColor). */
function FileTextIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[20px] w-[20px]"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
    </svg>
  );
}

/** WarnIcon geometry reused from ChatThread (alert-triangle), sized for the tile. */
function WarnTileIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[20px] w-[20px]"
      aria-hidden="true"
    >
      <path d="m21.7 18-9-16a1.5 1.5 0 0 0-2.6 0l-9 16A1.5 1.5 0 0 0 2.7 20h18.6a1.5 1.5 0 0 0 1.4-2Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[13px] w-[13px]"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </svg>
  );
}

export function ArtifactCard({
  artifactId,
  title,
  state,
  bodyBelow = true,
}: {
  artifactId: string;
  title: string;
  state: ArtifactState;
  /**
   * EC-06. Whether a report body actually renders BENEATH this card — the
   * caller's `degradedBodyToRender` verdict, passed in rather than guessed, so
   * the degraded sub-line cannot claim the report is below when nothing is.
   * False means the streamed answer bubble ABOVE already carries that exact
   * text (the trim-equal / absent-carrier cases); the user has the content
   * either way, which is D-43's substantive guarantee.
   */
  bodyBelow?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Cross-fade (UI-SPEC § [6]): on a state change the inner content snaps to
  // opacity 0 (no transition) and fades back to 1 over 120ms — a swap inside
  // the fixed box. Disabled entirely under prefers-reduced-motion.
  const [snapped, setSnapped] = useState(false);
  const prevStateRef = useRef(state);

  // WR-09: the preference is NEVER read in the render body (that was a
  // hydration mismatch and a preference that went stale until reload). The
  // transition itself now lives in CSS; this boolean exists only to SKIP the
  // snap-then-fade effect below, which CSS cannot express — un-transitioning it
  // would still flash the element to opacity 0 and back across two frames.
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (prevStateRef.current === state) return;
    prevStateRef.current = state;
    if (reduceMotion) return;
    setSnapped(true);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setSnapped(false));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [state, reduceMotion]);

  /**
   * Per-click signed-URL mint (D-39): GET the ownership-checked route, parse
   * {url}, navigate immediately. On ANY failure (network, 401/404/409/500,
   * missing url) render the inline warning — the card never changes state.
   */
  async function download() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(
        `/api/artifacts/${encodeURIComponent(artifactId)}/download`,
      );
      const data = res.ok
        ? ((await res.json().catch(() => null)) as { url?: unknown } | null)
        : null;
      const url = data && typeof data.url === "string" ? data.url : "";
      if (url) {
        window.location.assign(url);
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const degraded = state === "degraded";
  const titleText =
    state === "ready" ? `${title}.pdf` : degraded ? "PDF unavailable" : title;
  const subText =
    state === "pending"
      ? "Preparing PDF…"
      : state === "ready"
        ? "PDF · generated from this research"
        : bodyBelow
          ? "The renderer failed — the full report is below."
          : "The renderer failed — the full report is in the answer above.";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex h-[72px] items-center rounded-[var(--radius)] border px-[15px] py-[13px] ${
        degraded
          ? "border-[var(--warning-border)] bg-[var(--warning-soft)]"
          : "border-[var(--accent-line)]"
      }`}
      style={
        degraded
          ? undefined
          : // The one permitted literal hex in the app: the gradient face is
            // ported verbatim from the approved demo and has no token
            // equivalent (UI-SPEC § [6]).
            { background: "linear-gradient(180deg,#FFF9F5,var(--surface))" }
      }
    >
      {/* WR-09: the transition is CSS, never an inline style — an inline
          `transition` outranks `motion-reduce:transition-none` and would
          silently reinstate the bug. The two class sets are MUTUALLY EXCLUSIVE
          on purpose: while `snapped` the element carries `transition-none`, so
          the drop to opacity 0 is instantaneous and only the fade BACK animates.
          A single unconditional `transition-opacity` would animate both
          directions, turning the crisp snap-then-fade into a 120ms fade-out
          followed by a fade-in. Two competing transition-property utilities also
          have equal specificity, so applying both would leave the winner to
          stylesheet source order. Only the opacity VALUE stays inline — it is
          the driven value. */}
      <div
        className={
          "flex w-full min-w-0 items-center gap-[13px] " +
          (snapped
            ? "transition-none"
            : "transition-opacity duration-[120ms] ease-[ease] motion-reduce:transition-none")
        }
        style={{ opacity: snapped ? 0 : 1 }}
      >
        {/* 40×40 icon tile */}
        <div
          className={`grid h-[40px] w-[40px] flex-none place-items-center rounded-[10px] border ${
            degraded
              ? "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]"
              : "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
          }`}
        >
          {state === "pending" ? (
            <span
              className="agent-spinner"
              style={{ width: 18, height: 18 }}
              aria-hidden="true"
            />
          ) : degraded ? (
            <WarnTileIcon />
          ) : (
            <FileTextIcon />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-[13.5px] font-[650] ${
              degraded ? "text-[var(--warning)]" : "text-[var(--text)]"
            }`}
          >
            {titleText}
          </div>
          <div className="mt-[1px] truncate text-[11.5px] text-[var(--text-2)]">
            {subText}
          </div>
        </div>

        {/* Download failure is inline next to the button — the card itself
            never changes state on a download error (D-39). */}
        {failed && (
          <span
            role="alert"
            className="flex-none text-[11.5px] text-[var(--warning)]"
          >
            Download failed — try again.
          </span>
        )}

        {/* Fixed 112×34 right slot — RESERVED in every state so the button
            appearing shifts nothing (the CLS contract). */}
        <div className="flex h-[34px] w-[112px] flex-none items-center justify-end">
          {state === "ready" && (
            <button
              type="button"
              onClick={download}
              disabled={busy}
              aria-busy={busy || undefined}
              aria-label={`Download ${title}.pdf`}
              className="inline-flex h-[34px] items-center gap-[6px] rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent)] px-[12px] text-[12.5px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
            >
              <span className="grid h-[13px] w-[13px] flex-none place-items-center">
                {busy ? (
                  <span
                    className="agent-spinner"
                    style={{
                      width: 12,
                      height: 12,
                      borderColor: "rgba(255,255,255,.45)",
                      borderTopColor: "white",
                    }}
                    aria-hidden="true"
                  />
                ) : (
                  <DownloadIcon />
                )}
              </span>
              Download
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
