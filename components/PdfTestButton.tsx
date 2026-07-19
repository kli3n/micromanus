"use client";

import { useState } from "react";

/**
 * PdfTestButton (D-12 / success criterion 5) — the one-click affordance that
 * exercises the quarantined /api/render-pdf route from the shell.
 *
 * POSTs to /api/render-pdf and:
 *   - on an application/pdf response, opens the returned blob in a new tab via
 *     an object URL (the hello-world smoke PDF);
 *   - on the JSON degrade path ({ error: 'pdf_unavailable' }, returned with 200
 *     so Chromium never throws out of the route — decision ⑨), shows a
 *     human-readable inline note ("PDF unavailable — try again").
 *
 * Two visual variants match the mockup: the compact "topbar" button in the
 * header and the large "hero" button in the empty state.
 */
export function PdfTestButton({
  variant = "hero",
}: {
  variant?: "topbar" | "hero";
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function generate() {
    setPending(true);
    setFailed(false);
    try {
      const res = await fetch("/api/render-pdf", { method: "POST" });
      const contentType = res.headers.get("Content-Type") ?? "";
      if (res.ok && contentType.includes("application/pdf")) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener,noreferrer");
        // Revoke after the new tab has had time to load the blob.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        // JSON pdf_unavailable degrade path (or any non-PDF response).
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  const label = pending ? "Generating…" : "Generate test PDF";
  const isHero = variant === "hero";

  const buttonClass = isHero
    ? "flex h-[44px] items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent)] px-5 text-[14px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px disabled:opacity-70 disabled:cursor-not-allowed"
    : "flex h-9 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent)] px-[15px] text-[13.5px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px disabled:opacity-70 disabled:cursor-not-allowed";

  return (
    <>
      <button
        type="button"
        onClick={generate}
        disabled={pending}
        title="Renders a hello-world PDF via /api/render-pdf"
        className={buttonClass}
        style={{ boxShadow: "0 2px 8px rgba(194,65,12,.22)" }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        {label}
      </button>

      {/* Status line: static verify note in the hero, error note on the degrade
          path in either variant. */}
      {isHero && !failed && (
        <span className="flex items-center gap-1.5 text-[12px] text-[var(--text-3)]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[13px] w-[13px] text-[var(--success)]"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          Verifies Chromium rendering on Vercel
        </span>
      )}
      {failed && (
        <span role="alert" className="text-[12px] text-[var(--error)]">
          PDF unavailable — try again
        </span>
      )}
    </>
  );
}
