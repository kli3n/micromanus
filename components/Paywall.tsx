"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BalanceBadge } from "@/components/BalanceBadge";

/**
 * Paywall (PAY-01/PAY-02/PAY-03, D-13/D-16) — the first step a reviewer
 * meets at `/app` when their credit balance is 0. Rendered by the server
 * balance-gate in `app/app/page.tsx` INSIDE the persistent AppShell chrome
 * (sidebar + topbar stay visible — D-16), never as a separate full-screen route.
 *
 * Markup is ported from design/screens/02-phase2-demos.html §01 "Paywall" (D-11:
 * the mockup is the design contract) into Tailwind arbitrary-value utilities that
 * reference the :root tokens in app/globals.css — never raw hex.
 *
 * The coupon form POSTs to /api/coupon/redeem; the route's `error` key is
 * translated into the locked banners below (UX-01). On success it shows the
 * locked "5 credits added" banner then calls router.refresh() so the server page
 * re-reads the balance and flips the gate to the chat empty-state (D-15).
 *
 * The paywall is coupon-only — the card affordance (formerly D-17) was removed
 * per `docs/adr/0001-descope-card-payments.md`.
 */
type RedeemError = "empty" | "invalid" | "already_redeemed" | "auth" | "unknown";
type Banner =
  | { kind: "error"; title?: string; body: string }
  | { kind: "success"; title: string; body: string };

/** Locked copy (UI-SPEC Copywriting Contract) for each route error key. */
function bannerForError(error: RedeemError): Banner {
  switch (error) {
    case "invalid":
      return {
        kind: "error",
        title: "Invalid code",
        body: "That coupon doesn't exist. Check for typos and try again.",
      };
    case "already_redeemed":
      // D-20: no special-casing of the 0-credits + already-redeemed combination.
      return {
        kind: "error",
        title: "Already redeemed",
        body: "This coupon has already been used on your account. Each coupon grants credits once.",
      };
    case "empty":
      return { kind: "error", body: "Enter your coupon code to redeem credits." };
    case "auth":
    case "unknown":
    default:
      return {
        kind: "error",
        title: "Couldn't redeem coupon",
        body: "Something went wrong redeeming your coupon. Please try again.",
      };
  }
}

export function Paywall({ balance }: { balance: number }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  async function redeem() {
    // Client-side empty-input guard — no network call for a blank code.
    if (code.trim().length === 0) {
      setBanner(bannerForError("empty"));
      return;
    }
    setPending(true);
    setBanner(null);
    try {
      const res = await fetch("/api/coupon/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = (await res.json()) as
        | { ok: true; credits: number }
        | { ok: false; error: RedeemError };
      if (json.ok) {
        setBanner({
          kind: "success",
          title: "5 credits added",
          body: "You're set for 5 research runs. Next: connect your model key.",
        });
        // Re-read the balance server-side -> gate flips to the chat empty-state.
        router.refresh();
      } else {
        setBanner(bannerForError(json.error));
      }
    } catch {
      setBanner(bannerForError("unknown"));
    } finally {
      setPending(false);
    }
  }

  const isSuccess = banner?.kind === "success";

  return (
    <div className="mx-auto max-w-[620px] px-8 py-10">
      <p className="mb-[10px] text-[11px] font-[700] uppercase tracking-[.08em] text-[var(--accent)]">
        Step 1 of 3 · Credits
      </p>
      <h1 className="mb-2 text-[24px] tracking-[-0.02em] [text-wrap:balance]">
        Add credits to run research
      </h1>
      <p className="mb-4 text-[14.5px] leading-[1.6] text-[var(--text-2)]">
        Each run of the deep-research agent costs{" "}
        <strong className="font-[600]">1 credit</strong>. Redeem your coupon to
        get started — you&rsquo;ll connect your own model key next.
      </p>

      {/* PAY-04: the current balance stays visible on the paywall itself. */}
      <div className="mb-6">
        <BalanceBadge balance={balance} showMeter />
      </div>

      {/* Banner slot — reserved height to avoid CLS when a banner appears. */}
      <div className="min-h-[64px]">
        {banner && (
          <div
            role="alert"
            className={
              "flex items-start gap-[11px] rounded-[var(--radius)] border p-[13px_14px] " +
              (isSuccess
                ? "border-[var(--success-border)] bg-[var(--success-soft)]"
                : "border-[var(--error-border)] bg-[var(--error-soft)]")
            }
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={isSuccess ? 2.2 : 2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={
                "mt-px h-[18px] w-[18px] shrink-0 " +
                (isSuccess ? "text-[var(--success)]" : "text-[var(--error)]")
              }
            >
              {isSuccess ? (
                <path d="M20 6 9 17l-5-5" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v4" />
                  <path d="M12 16h.01" />
                </>
              )}
            </svg>
            <div>
              {banner.title && (
                <strong
                  className={
                    // Success title is --text-2, NOT --success: --success on
                    // --success-soft measures 4.47:1 — a text fail at
                    // 13.5px/650 (tests/contrast.test.ts SUCCESS_ON_
                    // SUCCESS_SOFT_VERDICT, fixed here per plan 04-04). The
                    // green semantic stays on the glyph + border (non-text,
                    // 3:1 bar — 4.47 clears it).
                    "block text-[13.5px] font-[650] " +
                    (isSuccess
                      ? "text-[var(--text-2)]"
                      : "text-[var(--error)]")
                  }
                >
                  {banner.title}
                </strong>
              )}
              <span className="text-[13px] leading-[1.5] text-[var(--text-2)]">
                {banner.body}
              </span>
            </div>
          </div>
        )}
      </div>

      <div
        className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-[18px]"
        style={{ boxShadow: "var(--shadow-sm)" }}
      >
        <div className="mb-3">
          <label
            htmlFor="pw-input"
            className="mb-[6px] block text-[13px] font-[600]"
          >
            Coupon code
          </label>
          {/* Keyboard focus ring comes from the single app-wide D-70 rule in
              globals.css (never re-declared per control); the input keeps its
              accent BORDER affordance in addition. The legacy focus-within
              accent-soft shadow (1.17:1 — never AA-visible) was removed under
              Amendment A3. */}
          <div className="flex h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-[13px] transition-[border-color] focus-within:border-[var(--accent)] motion-reduce:transition-none">
            <input
              id="pw-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !pending) redeem();
              }}
              placeholder="SID_DRDROID"
              autoComplete="off"
              spellCheck={false}
              className="w-full border-0 bg-transparent font-[var(--mono)] text-[13.5px] text-[var(--text)]"
            />
          </div>
          <p className="mt-[6px] text-[11.5px] leading-[1.5] text-[var(--text-2)]">
            Have the reviewer coupon? Paste it above. Grants 5 credits, one
            time.
          </p>
        </div>
        {/* Full designed state set (design/components.html .primary): hover
            darkens to --accent-hover, active is a 1px translate, keyboard
            focus is the inherited D-70 ring, loading swaps the label inside a
            fixed h-[46px] w-full box (no resize — CLS discipline [BD]), and
            the button is disabled while the input is empty or a redeem is in
            flight. The empty-input error copy stays reachable via Enter. */}
        <button
          type="button"
          onClick={redeem}
          disabled={pending || code.trim().length === 0}
          aria-busy={pending}
          className="flex h-[46px] w-full items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent)] text-[13.5px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-70 motion-reduce:transition-none"
          style={{ boxShadow: "0 2px 8px rgba(194,65,12,.22)" }}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6" />
            <path d="M2 7h20v5H2z" />
            <path d="M12 22V7" />
            <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
          </svg>
          {pending ? "Redeeming…" : "Redeem coupon"}
        </button>
      </div>
    </div>
  );
}
