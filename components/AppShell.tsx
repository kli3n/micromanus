import { BalanceBadge } from "@/components/BalanceBadge";
import {
  NavDrawerClose,
  NavDrawerProvider,
  NavDrawerToggle,
} from "@/components/NavDrawer";
import { TopbarModelPicker } from "@/components/TopbarModelPicker";
import { createClient } from "@/lib/supabase/server";
import { MODEL_REGISTRY } from "@/lib/registry";

/**
 * AppShell (D-02 / D-03) — the live chat layout the (app) group renders around
 * every authenticated page.
 *
 * Async server component. The (app) layout already enforced auth; this shell
 * re-derives `userId` (getClaims -> getUser) to run two RLS-scoped reads that
 * make the sidebar + topbar real (02-04 owns AppShell integration, wave 3):
 *   - the caller's `chats` (id, title, last_activity_at desc) for the chat list;
 *   - balance = SUM(credits_ledger.delta) for the balance-aware new-chat button,
 *     the 0-credit sidebar empty-state, and the always-visible topbar
 *     <BalanceBadge> (PAY-04).
 *
 * D-68 (04-06): below `lg` the sidebar becomes an off-canvas overlay drawer
 * behind a hamburger — the SAME server-rendered sidebar markup, passed as a
 * slot into the NavDrawer client island and repositioned by DRAWER_CSS below;
 * at `lg` and above the layout is unchanged (264px column + main). This file
 * stays an async server component and holds no client state — the open state
 * lives in components/NavDrawer.tsx (R-9). The sidebar markup is a named
 * server helper (<SidebarContent>) rather than an inline JSX attribute
 * expression, because scripts/audit-contrast.ts attributes classes nested
 * inside an attribute expression to the enclosing tag — inlining it collapsed
 * the file's three baselined same-element hover pairs into one span and
 * failed the gate on count drift (3 -> 1) with zero real change.
 *
 * Renders (inside <NavDrawerProvider>):
 *   - sidebar slot: brand mark (+ the drawer's close button, hidden at `lg`);
 *     an ENABLED "New research chat" -> /app/c/new (disabled with a "0 credits"
 *     hint at 0 balance, CHAT-01); a nav-mini (Settings & keys ->
 *     /app/settings, Cost & usage -> /app/stats) so those routes are reachable
 *     from every authenticated screen; the chat list linking each chat to
 *     /app/c/[chatId] (CHAT-02/03) with the balance-branched empty-state; and
 *     the user card + sign-out;
 *   - topbar: the hamburger (hidden at `lg`), workspace crumb, the topbar
 *     <BalanceBadge> (PAY-04), and the live <TopbarModelPicker> Model slot
 *     (KEY-05 — starts a new chat via /app/c/new?model=<id>, credit-gated).
 *     The Phase-1 PDF smoke-test button no longer ships here — see the
 *     retirement note at its former render site;
 *   - {children} in the canvas.
 *
 * Canonical paths only: /app/c/[chatId], /app/settings, /app/stats (D-11 — never
 * /app/chat/[id]). Sign-out POSTs to /auth/signout on every authenticated page.
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface ChatListItem {
  id: string;
  title: string | null;
}

/**
 * The sidebar's server-rendered markup — today's sidebar verbatim, plus the
 * drawer close button in the brand row. Rendered once and passed into the
 * NavDrawer client island as a slot: the drawer never mounts a second copy of
 * sidebar state, it repositions THIS markup by CSS.
 */
function SidebarContent({
  hasCredits,
  chats,
  displayName,
  email,
}: {
  hasCredits: boolean;
  chats: ChatListItem[];
  displayName: string;
  email: string;
}) {
  return (
    <>
      <div className="flex items-center gap-[10px] p-[6px_8px_14px]">
        <span
          aria-hidden="true"
          className="grid h-[30px] w-[30px] place-items-center rounded-[9px] text-white"
          style={{
            background: "linear-gradient(150deg, var(--accent), #E0742E)",
            boxShadow: "0 3px 9px rgba(194,65,12,.28)",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[17px] w-[17px]"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </span>
        <span className="text-[15.5px] font-[650] tracking-[-0.02em]">
          MicroManus
        </span>
        {/* Drawer close (04-06): top-right inside the panel, only a drawer
            affordance — removed from layout at `lg` and above. */}
        <NavDrawerClose className="ml-auto lg:hidden" />
      </div>

      {hasCredits ? (
        <a
          href="/app/c/new"
          className="flex h-[40px] w-full items-center gap-[9px] rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-3 text-[13.5px] font-[600] text-white transition-colors hover:bg-[var(--accent-hover)]"
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
            <path d="M12 5v14M5 12h14" />
          </svg>
          New research chat
        </a>
      ) : (
        <button
          type="button"
          disabled
          title="Redeem a credit to start a research chat"
          className="flex h-[40px] w-full cursor-not-allowed items-center gap-[9px] rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-transparent px-3 text-[13.5px] font-[550] text-[var(--text-2)] opacity-[.85]"
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
            <path d="M12 5v14M5 12h14" />
          </svg>
          New research chat
          <span className="ml-auto rounded-[20px] bg-[var(--surface-3)] px-[6px] py-[2px] text-[10px] font-[600] tracking-[.02em] text-[var(--text-2)]">
            0 credits
          </span>
        </button>
      )}

      {/* Nav-mini (UI-SPEC Component Inventory) — keeps Settings + Stats
          reachable from every authenticated screen. */}
      <nav className="mt-3 flex flex-col gap-0.5">
        {/* Hover text is --accent-hover, not --accent: --accent on the
            --surface-3 hover fill measures 4.36:1 (fails AA text) and axe
            cannot see it — resting-state only. The pinned matrix
            (tests/contrast.test.ts) is the authority: --accent-hover on
            --surface-3 is 6.22:1. Same rule at all three hover sites. */}
        <a
          href="/app/settings"
          className="flex items-center gap-[9px] rounded-[var(--radius-sm)] px-3 py-[7px] text-[13px] font-[550] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--accent-hover)]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[15px] w-[15px]"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
          </svg>
          Settings &amp; keys
        </a>
        <a
          href="/app/stats"
          className="flex items-center gap-[9px] rounded-[var(--radius-sm)] px-3 py-[7px] text-[13px] font-[550] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--accent-hover)]"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[15px] w-[15px]"
          >
            <path d="M3 3v18h18" />
            <path d="m19 9-5 5-4-4-3 3" />
          </svg>
          Cost &amp; usage
        </a>
      </nav>

      <div className="p-[20px_10px_8px] text-[11px] font-[600] uppercase tracking-[.06em] text-[var(--text-2)]">
        Chats
      </div>
      {chats.length > 0 ? (
        <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {chats.map((c) => (
            <a
              key={c.id}
              href={`/app/c/${c.id}`}
              className="overflow-hidden text-ellipsis whitespace-nowrap rounded-[var(--radius-sm)] px-3 py-[8px] text-[13px] font-[500] text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)]"
              title={c.title ?? "Untitled chat"}
            >
              {c.title ?? "Untitled chat"}
            </a>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[var(--text-2)]">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[26px] w-[26px] opacity-50"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <p className="m-0 text-[12.5px] leading-[1.5]">
            {hasCredits
              ? "No chats yet. Your research history will live here."
              : "Redeem a credit to start your first research run."}
          </p>
        </div>
      )}

      <div className="mt-2 flex items-center gap-[10px] border-t border-[var(--border)] p-[10px]">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-[650] text-white"
          style={{ background: "linear-gradient(150deg,#8B6D4E,#B08B62)" }}
        >
          {initials(displayName)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-[600]">
            {displayName}
          </div>
          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-[var(--text-2)]">
            {email}
          </div>
        </div>
        {/* Sign-out (AUTH-04 / D-03): a real form POST to /auth/signout. */}
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            title="Sign out"
            aria-label={`Sign out ${email} — ends this session and returns to the sign-in page`}
            className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-[8px] border border-transparent bg-transparent text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--accent-hover)]"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[17px] w-[17px]"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="m16 17 5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
          </button>
        </form>
      </div>
    </>
  );
}

export async function AppShell({
  displayName,
  email,
  children,
}: {
  displayName: string;
  email: string;
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{
      data: { claims?: { sub?: string } } | null;
    }>;
  };
  let userId: string | undefined;
  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    userId = data?.claims?.sub;
  } else {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
  }

  let chats: ChatListItem[] = [];
  let balance = 0;
  let savedProviders: string[] = [];
  if (userId) {
    const { data: chatRows } = await supabase
      .from("chats")
      .select("id, title, last_activity_at")
      .eq("user_id", userId)
      .order("last_activity_at", { ascending: false });
    chats = (chatRows ?? []).map((c) => ({
      id: c.id as string,
      title: (c.title as string | null) ?? null,
    }));

    const { data: ledgerRows } = await supabase
      .from("credits_ledger")
      .select("delta")
      .eq("user_id", userId);
    balance = (ledgerRows ?? []).reduce((sum, r) => sum + (r.delta ?? 0), 0);

    // KEY-05 / D-22: which providers the caller has a saved key for. Selects
    // ONLY the `provider` column, RLS-scoped by user_id — never iv/ct/tag/last4
    // (ciphertext columns are also REVOKE'd from `authenticated`, 0002).
    const { data: keyRows } = await supabase
      .from("user_api_keys")
      .select("provider")
      .eq("user_id", userId);
    savedProviders = (keyRows ?? []).map((k) => k.provider as string);
  }
  const hasCredits = balance > 0;

  return (
    <>
      <style>{DRAWER_CSS}</style>
      <NavDrawerProvider
        className="grid h-screen grid-cols-1 lg:grid-cols-[264px_1fr]"
        sidebarClassName="flex flex-col border-r border-[var(--border)] bg-[var(--surface-2)] p-[14px_12px]"
        contentClassName="flex min-w-0 flex-col"
        sidebar={
          <SidebarContent
            hasCredits={hasCredits}
            chats={chats}
            displayName={displayName}
            email={email}
          />
        }
      >
        {/* ---- Main (inert while the drawer is open — the focus trap) ---- */}
        <header className="flex h-[60px] items-center gap-[14px] border-b border-[var(--border)] bg-[var(--surface)] px-[22px]">
          {/* Hamburger (04-06): first topbar item below `lg`; removed from
              layout entirely at `lg` and above, so the header's gap spacing
              is unaffected on desktop. */}
          <NavDrawerToggle className="lg:hidden" />
          <div className="text-[14.5px] font-[600] tracking-[-0.01em]">
            Workspace{" "}
            <span className="font-[500] text-[var(--text-2)]">
              / Getting started
            </span>
          </div>
          <div className="flex-1" />
          {/* Always-visible balance (PAY-04). Distinct from the Model slot. */}
          <BalanceBadge balance={balance} />
          {/* Model slot (KEY-05, D-11 §03): the live topbar picker starts a NEW
              research chat via /app/c/new?model=<id>. Rendered only with credits
              (mirrors the sidebar CHAT-01 gating so 0-credit users aren't sent to
              a dead-end composer). Claude greyed (OQ-1); no-key providers locked
              with the "add key" nudge (D-22). */}
          {hasCredits && (
            <TopbarModelPicker
              models={MODEL_REGISTRY}
              savedProviders={savedProviders}
            />
          )}
          {/* The D-12 / Phase-1 criterion-5 PDF smoke-test button was retired
              from production chrome here (EC-09): it was a dev affordance
              shipped to the reviewer-visible authenticated header, and it POSTs
              to /api/render-pdf, so removing the render site also shrinks the
              authenticated surface (T-03-16-05 — the route's own auth + zod
              contract, D-40, remains the real boundary and is unchanged).
              components/PdfTestButton.tsx is deliberately RETAINED on disk as
              the Phase-1 evidence artifact. The production PDF paths are the
              create_pdf_report tool and the per-message Export button. */}
        </header>

        <div
          className="grid flex-1 place-items-center p-10"
          style={{
            background:
              "radial-gradient(720px 380px at 50% 30%, #FDF4EE 0%, rgba(253,244,238,0) 70%)",
          }}
        >
          {children}
        </div>
      </NavDrawerProvider>
    </>
  );
}

// Server-rendered global CSS (pure RSC; zero client JS) — the D-68 drawer's
// positioning + motion rules that utilities cannot express, following the
// STATS_CSS house pattern (app/app/stats/page.tsx). Compositor-only motion:
// only transform, opacity and visibility ever transition — visibility is a
// paint/hit-test property, not a layout one, and its `0s linear 200ms` exit
// delay keeps the panel painted through the slide-out, then drops the CLOSED
// drawer from BOTH the tab order and the accessibility tree (the closed-drawer
// fix: an <aside> parked at translateX(-100%) would otherwise still be
// tabbable — T-04-26). The grid column change itself is the Tailwind lg:
// utility on the provider's className above, NOT a rule here, because the SC-3
// gate greps the BUILT CSS chunk for the compiled breakpoint and an inline
// <style> never reaches that chunk. The reduced-motion override is its own CSS
// media block (never a JS gate), per the three-instance idiom in
// app/globals.css. Tokens only — no raw hex, no raw rgba.
const DRAWER_CSS = `
@media (width < 64rem) {
  #nav-drawer {
    position: fixed;
    inset-block: 0;
    inset-inline-start: 0;
    width: 280px;
    z-index: 40;
    background: var(--surface);
    border-right: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    transform: translateX(-100%);
    visibility: hidden;
    transition: transform 200ms ease, visibility 0s linear 200ms;
  }
  #nav-drawer[data-drawer="open"] {
    transform: translateX(0);
    visibility: visible;
    transition: transform 200ms ease, visibility 0s;
  }
  .drawer-scrim {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: var(--scrim);
    opacity: 0;
    visibility: hidden;
    transition: opacity 200ms ease, visibility 0s linear 200ms;
  }
  .drawer-scrim[data-drawer="open"] {
    opacity: 1;
    visibility: visible;
    transition: opacity 200ms ease, visibility 0s;
  }
}
@media (prefers-reduced-motion: reduce) {
  #nav-drawer,
  .drawer-scrim {
    transition: none;
  }
}
`;
