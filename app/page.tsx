import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OAuthButtons } from "@/components/OAuthButtons";
import { createClient } from "@/lib/supabase/server";

// Renders as "Sign in · MicroManus" through the root layout's title template.
// This is the page the old flat root title was written for (EC-09).
export const metadata: Metadata = { title: "Sign in" };

// The landing page is the ONLY public route (served at `/`). It renders the
// D-62 hero — nav, headline, subhead, GitHub + Google OAuth buttons, the
// provider-key fine print and the three-step "how it works" band — and, when
// the callback returns ?error (D-07), a human-readable inline error banner with
// the buttons still present.
//
// SOURCE OF TRUTH: design/screens/04-phase4-demos.html § 01 Landing hero, the
// D-63 mockup approved 2026-08-06 (approve-with-changes; the approval record is
// a note inside that panel). Sizes, weights, spacing and copy below are that
// panel; do not re-derive them from landing.html, which this hero supersedes.
//
// LCP / [BD §1-2]: this is a text-and-CSS hero. There is deliberately no
// <img>/<picture>/<video> and no CSS url() background anywhere on the surface,
// so the largest paint element is the 38px headline — cheap, server-rendered,
// and carrying no preload or fetchpriority obligation. Do not introduce an
// image hero here; the approved mockup does not have one and adding one would
// re-open D-63.
//
// ACCENT BUDGET [04-UI-SPEC § Color]: accent may appear on the brand mark, the
// primary CTA, and at most ONE supporting element. Here it is the brand mark
// and the headline's <em>. The OAuth buttons are the 04-12 component and carry
// no accent fill, so the surface ships at two accent sites — under the ceiling,
// never over it. Never put accent on body text or a large fill.
//
// SERVER-RENDERED [BD §12]: this file carries NO client directive — it is an
// RSC and must stay one. The headline, subhead
// and both sign-in buttons are in the initial HTML and read coherently with
// JavaScript disabled; <OAuthButtons> is the only client island and it is
// visible rather than gated on hydration.
//
// ROUTING NOTE: the session-guarded workspace shell lives at the `/app` segment
// (two pages cannot both resolve to `/` in Next.js — the public landing owns
// `/`). So an already-authenticated visitor to `/` is forwarded to the shell,
// which keeps the OAuth flow's `next=/` working (login → `/` → `/app`) and
// avoids showing sign-in buttons to a signed-in user.
export default async function Landing({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  // Forward signed-in users to the guarded shell. getClaims() (getUser fallback)
  // is the server-trust check; never getSession().
  const supabase = await createClient();
  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{ data: { claims?: { sub?: string } } | null }>;
  };
  let signedIn = false;
  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } else {
    const { data } = await supabase.auth.getUser();
    signedIn = Boolean(data.user);
  }
  if (signedIn) redirect("/app");

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Nav — 60px, the inherited topbar constant */}
      <header className="flex h-[60px] items-center gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-[18px] sm:px-8">
        <span
          aria-hidden="true"
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[9px] text-white"
          style={{
            background: "linear-gradient(150deg, var(--accent), #E0742E)",
            boxShadow: "0 3px 9px rgba(194,65,12,.28)",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[17px] w-[17px]"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
        </span>
        <span className="text-[15.5px] font-[650] tracking-[-0.02em]">
          MicroManus
        </span>
        {/* One link, and it is the one that resolves (#how is below). The
            drafted "What it costs" pointed at a section that does not exist and
            was dropped at D-63 approval. Hidden below sm: the phone variant of
            the approved mockup carries the mark and wordmark only. */}
        <nav
          aria-label="Primary"
          className="ml-auto hidden items-center gap-[22px] sm:flex"
        >
          <a
            href="#how"
            className="text-[13px] font-[550] text-[var(--text-2)] no-underline hover:text-[var(--text)]"
          >
            How it works
          </a>
        </nav>
      </header>

      <main className="mx-auto max-w-[1000px] px-5 pt-8 pb-8 sm:px-8 sm:pt-14 sm:pb-12">
        <span className="mb-[14px] inline-flex items-center gap-2 text-[11px] font-[700] tracking-[0.05em] text-[var(--text-2)] uppercase sm:mb-5">
          {/* Decorative pip (aria-hidden, no content of its own). --text-3 is
              legal here precisely because it is decorative: it is NOT an accent
              site — the D-63 approval demoted it from accent to hold the hero's
              three-site accent budget. */}
          <span
            aria-hidden="true"
            className="h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--text-3)]"
          />
          Deep-research agent
        </span>

        <h1 className="mb-[14px] max-w-none text-[32px] leading-[1.14] font-[650] tracking-[-0.025em] text-balance sm:mb-[18px] sm:max-w-[20ch] sm:text-[38px]">
          Research that shows its work &mdash; and{" "}
          <em className="not-italic text-[var(--accent)]">its bill</em>.
        </h1>

        <p className="mb-6 max-w-[58ch] text-[15.5px] leading-[1.6] text-[var(--text-2)] sm:mb-8">
          MicroManus browses the open web in a think &rarr; act &rarr; observe
          loop, cites every claim back to the page it came from, and exports the
          finished report as a PDF.{" "}
          <strong className="font-semibold text-[var(--text)]">
            You bring your own model key
          </strong>
          , and every single call is metered &mdash; input, output, and cached
          tokens, priced to the cent.
        </p>

        {/* The only client island on this surface, and it renders visible
            rather than hydration-gated. Framed, not restyled (plan 04-12 owns
            its state set): the component stacks two w-full buttons, so it is
            given a column width here instead of the mockup's side-by-side row. */}
        <div className="mb-4 max-w-[320px]">
          <OAuthButtons />
        </div>

        {/* D-07 inline error banner — only when the callback returns ?error.
            Copy is LOCKED and byte-identical; this pass restyles only.

            PLACEMENT IS THE CLS CONTRACT [BD §8]. It sits BELOW the sign-in
            buttons on purpose, so the eyebrow, headline, subhead and both
            buttons occupy identical y-offsets with and without the parameter —
            the hero does not move, at any viewport. A fixed-height reservation
            above the hero was considered and rejected: this banner is one line
            at 1280px and four at 390px, so no single reserved height is correct
            at both widths, and a wrong reservation would leave a permanent
            empty band on the far more common no-error load while still shifting
            at the other width. Nothing shifts at runtime either — the banner is
            server-rendered into the initial HTML from the query parameter, so
            it never "appears" after paint.

            The branch is on the parameter's PRESENCE, never its VALUE (T-04-60):
            nothing from the URL is rendered, so this cannot be turned into a
            phishing frame beside a live sign-in button. role="alert" keeps it
            announced as an alert regardless of DOM position. */}
        {error && (
          <div
            role="alert"
            className="mb-4 flex max-w-[58ch] items-start gap-[11px] rounded-[var(--radius)] border border-[var(--error-border)] bg-[var(--error-soft)] p-[13px_14px]"
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

        {/* Fine print. The key claim is true and contract-compliant; the coupon
            flow is deliberately NOT promised on this page (04-UI-SPEC § Hero
            copy), and there is no card-payment claim anywhere (ADR 0001).
            The code chips are --text-2 on --surface-2 (~4.9:1), NOT the old
            --accent-on---accent-soft chip that measured 4.43 and was routed
            here by tests/contrast.test.ts. */}
        <p className="max-w-[58ch] text-[12.5px] leading-[1.6] text-[var(--text-2)]">
          Add your{" "}
          <code className="rounded-[5px] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-px font-[var(--mono)] text-[11.5px]">
            OpenAI
          </code>
          ,{" "}
          <code className="rounded-[5px] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-px font-[var(--mono)] text-[11.5px]">
            Anthropic
          </code>
          , or{" "}
          <code className="rounded-[5px] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-px font-[var(--mono)] text-[11.5px]">
            Kimi
          </code>{" "}
          key in settings &mdash; it is encrypted and never leaves the server.
        </p>

        <section
          id="how"
          aria-labelledby="how-heading"
          className="mt-11 grid gap-[26px] border-t border-[var(--border)] pt-7 lg:grid-cols-3"
        >
          {/* Named for assistive tech and to keep h1 → h2 → h3 order intact;
              the three step titles below are the visible level. */}
          <h2 id="how-heading" className="sr-only">
            How it works
          </h2>
          {[
            {
              k: "think",
              h: "It writes a plan first",
              p: "Every run opens with the questions it intends to answer, so you can see the shape of the research before it spends a token.",
            },
            {
              k: "act",
              h: "Then it actually browses",
              p: "Searches, opens pages, and reads them. Each source it used is listed and numbered, and every claim links back to one.",
            },
            {
              k: "observe",
              h: "And it shows the bill",
              p: "Input, output, and cached tokens per call, per chat, priced from the provider’s own reported usage — never an estimate.",
            },
          ].map((step) => (
            <div key={step.k}>
              <div className="mb-2 flex items-center gap-2 font-[var(--mono)] text-[11px] text-[var(--text-2)]">
                <span
                  aria-hidden="true"
                  className="h-[2px] w-[18px] shrink-0 bg-[var(--border-strong)]"
                />
                {step.k}
              </div>
              <h3 className="mb-1 text-[14.5px] font-[650] tracking-[-0.01em]">
                {step.h}
              </h3>
              <p className="text-[13px] leading-[1.6] text-[var(--text-2)]">
                {step.p}
              </p>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
