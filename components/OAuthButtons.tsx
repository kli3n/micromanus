"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Provider = "github" | "google";

// Full designed state set (design/components.html .oauth/.btn): hover fills
// --surface-2 and darkens the border, active is a 1px translate, keyboard
// focus is the inherited app-wide D-70 ring (no per-control declaration),
// loading swaps the label inside the fixed h-[46px] w-full box so the button
// never resizes above the fold (CLS discipline [BD]), disabled dims both
// buttons while either sign-in is in flight. The literal hover-border hex is
// demo-verbatim (landing.html + auth-error.html; allowlisted), and the four
// Google logo hexes below are brand-exempt — a third party's mark cannot be
// tokenised. No card-payment affordance may ever appear here (ADR 0001).
const BTN_CLASS =
  "flex items-center justify-center gap-2.5 h-[46px] w-full rounded-[var(--radius)] " +
  "border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] " +
  "text-[14.5px] font-[550] cursor-pointer transition-colors " +
  "hover:bg-[var(--surface-2)] hover:border-[#CFC7B9] active:translate-y-px " +
  "disabled:opacity-60 disabled:cursor-not-allowed motion-reduce:transition-none";

export function OAuthButtons() {
  const [pending, setPending] = useState<Provider | null>(null);

  async function signIn(provider: Provider) {
    setPending(provider);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        // The callback validates ?next server-side (safeNext, Plan 04) and lands
        // the signed-in user on the app shell. origin resolves to *.vercel.app in
        // prod and localhost in dev (both in the Supabase redirect allowlist).
        redirectTo: `${window.location.origin}/auth/callback?next=/`,
      },
    });
    // On success the browser is already navigating to the provider; only reset
    // pending state if initiation itself failed.
    if (error) setPending(null);
  }

  return (
    <div className="flex flex-col gap-[11px]">
      {/* Accessible names follow the house idiom (outcome-describing, states
          the consequence) while embedding the locked visible copy verbatim so
          WCAG 2.5.3 label-in-name holds; the rendered strings are untouched. */}
      <button
        type="button"
        className={BTN_CLASS}
        onClick={() => signIn("github")}
        disabled={pending !== null}
        aria-busy={pending === "github"}
        aria-label={
          pending === "github"
            ? "Connecting to GitHub…"
            : "Continue with GitHub — takes you to GitHub to sign in"
        }
      >
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          className="h-[18px] w-[18px] shrink-0"
        >
          <path d="M12 .5C5.7.5.6 5.6.6 11.9c0 5 3.3 9.3 7.8 10.8.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.5 4.5-1.5 7.8-5.8 7.8-10.8C23.4 5.6 18.3.5 12 .5Z" />
        </svg>
        {pending === "github" ? "Connecting to GitHub…" : "Continue with GitHub"}
      </button>

      <button
        type="button"
        className={BTN_CLASS}
        onClick={() => signIn("google")}
        disabled={pending !== null}
        aria-busy={pending === "google"}
        aria-label={
          pending === "google"
            ? "Connecting to Google…"
            : "Continue with Google — takes you to Google to sign in"
        }
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className="h-[18px] w-[18px] shrink-0"
        >
          <path
            fill="#EA4335"
            d="M12 10.2v3.9h5.5c-.2 1.4-1.6 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.9 1.5l2.6-2.5C17.3 3.4 14.9 2.4 12 2.4 6.9 2.4 2.8 6.5 2.8 11.6S6.9 20.8 12 20.8c5.3 0 8.8-3.7 8.8-8.9 0-.6-.1-1.1-.2-1.6H12Z"
          />
          <path
            fill="#34A853"
            d="M12 20.8c2.4 0 4.5-.8 5.9-2.2l-2.8-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.2-3.8l-2.9 2.2C5.2 18.8 8.3 20.8 12 20.8Z"
          />
          <path
            fill="#4A90D9"
            d="M20.8 11.9c0-.6-.1-1.1-.2-1.6H12v3.9h5.5c-.3 1.2-1 2.1-1.9 2.7l2.8 2.2c1.6-1.5 2.6-3.8 2.6-7.2Z"
          />
          <path
            fill="#FBBC05"
            d="M6.8 13.5A5.5 5.5 0 0 1 6.5 12c0-.5.1-1 .3-1.5L3.9 8.3A9.2 9.2 0 0 0 2.8 12c0 1.4.3 2.6.9 3.7l3.1-2.2Z"
          />
        </svg>
        {pending === "google" ? "Connecting to Google…" : "Continue with Google"}
      </button>
    </div>
  );
}
