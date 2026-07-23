import { createClient } from "@/lib/supabase/server";
import { Paywall } from "@/components/Paywall";

/**
 * Balance gate for `/app` (PAY-01, D-15/D-16).
 *
 * Async server component that computes the caller's credit balance as
 * `SUM(credits_ledger.delta)` — there is NO mutable balance column (locked money
 * design). The read is RLS-scoped both by the `ledger_select_own` policy and an
 * explicit `.eq('user_id', userId)` (T-02-03: no cross-account read). The (app)
 * layout is the real auth enforcement boundary; this page only re-derives
 * `userId` to scope its query (same getClaims()->getUser() pattern as the layout).
 *
 * balance <= 0  -> render <Paywall> inside the existing AppShell chrome (D-16).
 * balance  > 0  -> render the text/CSS chat empty-state hero (D-15). The Phase 1
 *                  PDF smoke-test hero is removed here (D-02 supersedes it); the
 *                  topbar PDF affordance in AppShell is untouched.
 */
export default async function AppHome() {
  const supabase = await createClient();

  // Re-derive the caller's id (the layout already enforced auth). Prefer
  // getClaims() (local JWT verification), fall back to getUser().
  let userId: string | undefined;

  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{
      data: { claims?: { sub?: string } } | null;
    }>;
  };

  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    userId = data?.claims?.sub;
  } else {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
  }

  // Balance = SUM(credits_ledger.delta) for the caller (RLS-scoped).
  let balance = 0;
  if (userId) {
    const { data: rows } = await supabase
      .from("credits_ledger")
      .select("delta")
      .eq("user_id", userId);
    balance = (rows ?? []).reduce((sum, r) => sum + (r.delta ?? 0), 0);
  }

  if (balance <= 0) {
    return <Paywall balance={balance} />;
  }

  // Has credits -> chat empty-state hero (text/CSS only, one cheap LCP).
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
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h1 className="mb-[10px] text-[24px] tracking-[-0.02em]">
        You&rsquo;re set. Start your first research run.
      </h1>
      <p className="mb-6 text-[14.5px] leading-[1.6] text-[var(--text-2)]">
        Ask the deep-research agent a question and it will browse the web,
        reason across sources, and hand you a cited report. Each run costs 1
        credit. Start a new research chat from the sidebar.
      </p>
    </div>
  );
}
