"use client";

import { useState } from "react";

/**
 * ExportPdfButton (D-38) — the always-visible "Export as PDF" ghost action on
 * every terminal assistant message: the safety net that produces the SAME PDF
 * via /api/render-pdf even when the model never called the create_pdf_report
 * tool, and the retry path for a degraded artifact card.
 *
 * Shape copied from PdfTestButton (03-PATTERNS analog): POST + CONTENT-TYPE
 * branch — the render route's degrade is a 200 JSON body, so `res.ok` alone
 * is NOT the success signal; only `application/pdf` is.
 *
 * UI-SPEC § [4]: 30px ghost row, ALWAYS visible (hover-reveal fails touch and
 * is an a11y trap); the busy label swap ("Export as PDF" → "Preparing…")
 * keeps the idle label's width reserved so the button never resizes [BD §8];
 * failure renders inline at 11.5px --warning with role="alert".
 */

export interface ExportSource {
  n: number;
  title: string;
  url: string;
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

export function ExportPdfButton({
  title,
  markdown,
  sources,
}: {
  title: string;
  markdown: string;
  sources?: ExportSource[];
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function exportPdf() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch("/api/render-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          markdown,
          // The route's zod marks sources optional — omit the key entirely
          // when the run registered none (renderPdfBody contract, 03-05).
          ...(sources && sources.length > 0 ? { sources } : {}),
        }),
      });
      const contentType = res.headers.get("Content-Type") ?? "";
      if (res.ok && contentType.includes("application/pdf")) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${title.replace(/[\\/:*?"<>|]/g, " ").trim() || "report"}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke after the browser has had time to start the download.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // JSON pdf_unavailable degrade (or any non-PDF response body).
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex h-[30px] items-center gap-[10px]">
      <button
        type="button"
        onClick={exportPdf}
        disabled={pending}
        aria-busy={pending || undefined}
        className="inline-flex h-[30px] items-center gap-[7px] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface)] px-[11px] text-[12px] font-[550] text-[var(--text-2)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-70 motion-reduce:transition-none"
      >
        <span className="grid h-[13px] w-[13px] flex-none place-items-center">
          {pending ? (
            <span
              className="agent-spinner"
              style={{ width: 11, height: 11 }}
              aria-hidden="true"
            />
          ) : (
            <DownloadIcon />
          )}
        </span>
        {/* Stacked labels: the invisible idle label reserves its own width so
            the busy swap never resizes the button [BD §8]. */}
        <span className="grid">
          <span
            className={`col-start-1 row-start-1 ${pending ? "invisible" : ""}`}
            aria-hidden={pending || undefined}
          >
            Export as PDF
          </span>
          {pending && <span className="col-start-1 row-start-1">Preparing…</span>}
        </span>
      </button>
      {failed && (
        <span role="alert" className="text-[11.5px] text-[var(--warning)]">
          PDF unavailable — try again in a moment.
        </span>
      )}
    </div>
  );
}
