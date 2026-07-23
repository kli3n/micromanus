/**
 * BalanceBadge (PAY-04, D-21) — the always-visible credit-count pill.
 *
 * Pure presentational server component (no "use client"): it renders entirely
 * from its `balance` prop, so the topbar/composer plans can drop it straight
 * into server-rendered chrome to satisfy "balance always visible next to the
 * chat input" (PAY-04). Markup ported from design/screens/02-phase2-demos.html
 * (D-11) into Tailwind arbitrary-value utilities over the :root tokens.
 *
 * States (D-21): balance > 0 renders the accent "credit" style with a pulsing
 * dot (the pulse is a compositor-only opacity animation, disabled under
 * prefers-reduced-motion — see .badge-dot-pulse in globals.css); balance === 0
 * switches to the warning style (--warning / --warning-soft) so the cause of a
 * disabled composer is visible at a glance. `showMeter` appends the PAY-04 meta
 * "1 credit = 1 agent run" beside the count (FR-8).
 */
export function BalanceBadge({
  balance,
  showMeter,
}: {
  balance: number;
  showMeter?: boolean;
}) {
  const hasCredits = balance > 0;
  const label = `${balance} ${balance === 1 ? "credit" : "credits"}`;

  return (
    <span className="inline-flex items-center gap-[10px]">
      <span
        className={
          "inline-flex h-[30px] items-center gap-[7px] rounded-[999px] border px-3 font-[var(--mono)] text-[12.5px] font-[600] [font-variant-numeric:tabular-nums] " +
          (hasCredits
            ? "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
            : "border-[var(--warning-border)] bg-[var(--warning-soft)] text-[var(--warning)]")
        }
      >
        <span
          aria-hidden="true"
          className={
            "h-[7px] w-[7px] rounded-full bg-current " +
            (hasCredits ? "badge-dot-pulse" : "")
          }
        />
        {label}
      </span>
      {showMeter && (
        <span className="text-[11.5px] text-[var(--text-3)]">
          1 credit = 1 agent run
        </span>
      )}
    </span>
  );
}
