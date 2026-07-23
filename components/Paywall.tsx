"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Paywall (PAY-01/PAY-02, D-13/D-16/D-17) — the first step a reviewer meets at
 * `/app` when their credit balance is 0. Rendered by the server balance-gate in
 * `app/app/page.tsx` INSIDE the persistent AppShell chrome (sidebar + topbar
 * stay visible — D-16), never as a separate full-screen route.
 *
 * Markup is ported from design/screens/02-phase2-demos.html §01 "Paywall" (D-11:
 * the mockup is the design contract) into Tailwind arbitrary-value utilities that
 * reference the :root tokens in app/globals.css — never raw hex.
 *
 * The coupon form POSTs to /api/coupon/redeem; on success it calls
 * router.refresh() so the server page re-reads the balance and flips the gate to
 * the chat empty-state (D-15). This is the Task 1 thin happy path — Task 2 adds
 * the BalanceBadge, the locked error/success banners, and the empty-input guard.
 */
export function Paywall({ balance: _balance }: { balance: number }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"idle" | "ok" | "failed">("idle");

  async function redeem() {
    setPending(true);
    setStatus("idle");
    try {
      const res = await fetch("/api/coupon/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const json = (await res.json()) as { ok: boolean };
      if (json.ok) {
        setStatus("ok");
        router.refresh();
      } else {
        setStatus("failed");
      }
    } catch {
      setStatus("failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-[620px] px-8 py-10">
      <p className="mb-[10px] text-[11px] font-[700] uppercase tracking-[.08em] text-[var(--accent)]">
        Step 1 of 3 · Credits
      </p>
      <h1 className="mb-2 text-[24px] tracking-[-0.02em] [text-wrap:balance]">
        Add credits to run research
      </h1>
      <p className="mb-6 text-[14.5px] leading-[1.6] text-[var(--text-2)]">
        Each run of the deep-research agent costs{" "}
        <strong className="font-[600]">1 credit</strong>. Redeem your coupon to
        get started — you&rsquo;ll connect your own model key next.
      </p>

      {/* Minimal inline status (Task 1). Task 2 replaces this with the locked
          role="alert" success/error banners. */}
      {status === "ok" && (
        <p
          role="status"
          className="mb-[18px] text-[13px] text-[var(--success)]"
        >
          Coupon redeemed.
        </p>
      )}
      {status === "failed" && (
        <p role="alert" className="mb-[18px] text-[13px] text-[var(--error)]">
          Couldn&rsquo;t redeem that coupon. Please try again.
        </p>
      )}

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
          <div className="flex h-11 items-center gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] px-[13px] transition-[border-color,box-shadow] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <input
              id="pw-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="SID_DRDROID"
              autoComplete="off"
              spellCheck={false}
              className="w-full border-0 bg-transparent font-[var(--mono)] text-[13.5px] text-[var(--text)] outline-none"
            />
          </div>
          <p className="mt-[6px] text-[11.5px] leading-[1.5] text-[var(--text-3)]">
            Have the reviewer coupon? Paste it above. Grants 5 credits, one
            time.
          </p>
        </div>
        <button
          type="button"
          onClick={redeem}
          disabled={pending}
          className="flex h-[46px] w-full items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--accent)] text-[13.5px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-70"
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
            <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6" />
            <path d="M2 7h20v5H2z" />
            <path d="M12 22V7" />
            <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
          </svg>
          {pending ? "Redeeming…" : "Redeem coupon"}
        </button>
      </div>

      {/* D-17: disabled card-payment affordance with the "Soon" pill — never
          implies a live payment flow before Phase 4. */}
      <div className="mt-[14px] flex items-center justify-between gap-3 rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-[var(--surface-2)] px-4 py-[14px]">
        <div className="flex items-center gap-[11px]">
          <span
            aria-hidden="true"
            className="grid h-[34px] w-[34px] place-items-center rounded-[9px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text-3)]"
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
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M2 10h20" />
            </svg>
          </span>
          <div>
            <div className="text-[13.5px] font-[600] text-[var(--text-3)]">
              Pay with card
            </div>
            <div className="text-[12px] text-[var(--text-3)]">
              $5 test-mode payment → 5 credits
            </div>
          </div>
        </div>
        <span
          aria-disabled="true"
          className="rounded-[999px] border border-[var(--border)] bg-[var(--surface-3)] px-[6px] py-[2px] text-[10px] font-[600] text-[var(--text-3)]"
        >
          Soon
        </span>
      </div>
    </div>
  );
}
