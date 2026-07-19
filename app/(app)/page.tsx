import { PdfTestButton } from "@/components/PdfTestButton";

/**
 * The shell's main empty state (D-02) — the hero the reviewer lands on after a
 * successful sign-in. Copy is ported from design/screens/app-shell.html. The
 * primary "Generate test PDF" affordance (D-12 / success criterion 5) is the
 * client PdfTestButton, which POSTs /api/render-pdf and opens the returned PDF.
 * The profile name/email are read + rendered by the guarded layout.
 */
export default function AppHome() {
  return (
    <div className="max-w-[460px] text-center">
      <div
        aria-hidden="true"
        className="mx-auto mb-[22px] grid h-16 w-16 place-items-center rounded-[18px] border border-[var(--border)] bg-[var(--surface)] text-[var(--accent)]"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[30px] w-[30px]"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      </div>
      <h1 className="mb-[10px] text-[24px] tracking-[-0.02em]">
        You&rsquo;re in. This is your research workspace.
      </h1>
      <p className="mb-6 text-[14.5px] leading-[1.6] text-[var(--text-2)]">
        Streaming answers, cited web research, and downloadable PDF reports
        arrive in the next update. For now, confirm the serverless PDF pipeline
        works end-to-end.
      </p>
      <div className="flex flex-col items-center gap-[10px]">
        <PdfTestButton variant="hero" />
      </div>
    </div>
  );
}
