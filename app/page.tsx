import { OAuthButtons } from "@/components/OAuthButtons";

// The landing page is the ONLY public route. It renders the wordmark, tagline,
// GitHub + Google OAuth buttons, and — when the callback returns ?error (D-07) —
// a human-readable inline error banner with the buttons still present.
export default async function Landing({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main
      className="grid min-h-screen place-items-center p-8"
      style={{
        background:
          "radial-gradient(1100px 520px at 50% -10%, #FDF2EA 0%, rgba(253,242,234,0) 60%), var(--bg)",
      }}
    >
      <div
        className="w-full max-w-[400px] rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] px-9 py-10"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        {/* Brand */}
        <div className="mb-6 flex items-center gap-[11px]">
          <span
            aria-hidden="true"
            className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] text-white"
            style={{
              background: "linear-gradient(150deg, var(--accent), #E0742E)",
              boxShadow: "0 4px 12px rgba(194,65,12,.28)",
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[21px] w-[21px]"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <span className="text-[19px] font-[650] tracking-[-0.02em]">
            MicroManus
          </span>
        </div>

        {/* D-07 inline error banner — only when the callback returns ?error */}
        {error && (
          <div
            role="alert"
            className="mb-[22px] flex items-start gap-[11px] rounded-[var(--radius)] border border-[var(--error-border)] bg-[var(--error-soft)] p-[13px_14px]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-px h-[18px] w-[18px] shrink-0 text-[var(--error)]"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
            <div className="text-[13.5px] leading-[1.5]">
              <strong className="mb-0.5 block font-[650] text-[var(--error)]">
                Sign-in couldn&rsquo;t be completed
              </strong>
              <span className="text-[var(--text-2)]">
                The authorization was cancelled or timed out. No account was
                created &mdash; please try again.
              </span>
            </div>
          </div>
        )}

        {/* Tagline */}
        <h1 className="mb-[9px] text-[23px] leading-[1.25] tracking-[-0.02em]">
          Research that shows its work.
        </h1>
        <p className="mb-7 text-[14.5px] leading-[1.55] text-[var(--text-2)]">
          A deep-research agent that browses the web, cites every source, and
          tells you exactly what each answer cost &mdash; on your own API key.
        </p>

        {/* GitHub + Google OAuth buttons */}
        <OAuthButtons />

        {/* Footer */}
        <div className="mt-[26px] flex flex-wrap gap-[14px] border-t border-[var(--border)] pt-[18px] text-[12.5px] text-[var(--text-3)]">
          <span>
            <b className="font-semibold text-[var(--text-2)]">BYOK</b> &mdash;
            your key, encrypted
          </span>
          <span className="text-[var(--border-strong)]">·</span>
          <span>
            <code className="rounded-[5px] bg-[var(--accent-soft)] px-1.5 py-px font-[var(--mono)] text-[12px] text-[var(--accent)]">
              1 credit
            </code>{" "}
            = 1 research run
          </span>
        </div>
      </div>
    </main>
  );
}
