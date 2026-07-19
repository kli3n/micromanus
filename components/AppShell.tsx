import { PdfTestButton } from "@/components/PdfTestButton";

/**
 * AppShell (D-02 / D-03) — the post-login stub of the eventual chat layout.
 *
 * Ports design/screens/app-shell.html verbatim (D-11: the mockup is the design
 * contract) into JSX with the same warm design tokens the landing page uses. It
 * renders:
 *   - the sidebar: brand mark, a DISABLED "New research chat" button with the
 *     "Soon" pill, the empty chat-list state, and the user card (avatar initials
 *     + display name + email) with the header sign-out control;
 *   - the topbar: workspace crumb, a DISABLED "Model" selector placeholder with
 *     a "Soon" pill (space Phase 2 fills), and a compact "Generate test PDF"
 *     button (PdfTestButton, D-12);
 *   - {children} in the canvas.
 *
 * Sign-out is a form that POSTs to /auth/signout — present on every
 * authenticated page because this shell wraps the whole (app) group in the
 * layout (D-03). The chat + model controls are non-functional placeholders this
 * phase; Phase 2 builds INTO this shell (D-02). This is a server component; the
 * only interactive island is the client PdfTestButton.
 */

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function AppShell({
  displayName,
  email,
  children,
}: {
  displayName: string;
  email: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid h-screen grid-cols-[264px_1fr]">
      {/* ---- Sidebar ---- */}
      <aside className="flex flex-col border-r border-[var(--border)] bg-[var(--surface-2)] p-[14px_12px]">
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
        </div>

        <button
          type="button"
          disabled
          className="flex h-[40px] w-full cursor-not-allowed items-center gap-[9px] rounded-[var(--radius)] border border-dashed border-[var(--border-strong)] bg-transparent px-3 text-[13.5px] font-[550] text-[var(--text-2)] opacity-[.85]"
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
            <path d="M12 5v14M5 12h14" />
          </svg>
          New research chat
          <span className="ml-auto rounded-[20px] bg-[var(--surface-3)] px-[6px] py-[2px] text-[10px] font-[600] tracking-[.02em] text-[var(--text-3)]">
            Soon
          </span>
        </button>

        <div className="p-[20px_10px_8px] text-[11px] font-[600] uppercase tracking-[.06em] text-[var(--text-3)]">
          Chats
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[var(--text-3)]">
          <svg
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
            No chats yet.
            <br />
            Your research history will live here.
          </p>
        </div>

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
            <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11.5px] text-[var(--text-3)]">
              {email}
            </div>
          </div>
          {/* Sign-out (AUTH-04 / D-03): a real form POST to /auth/signout. */}
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-[8px] border border-transparent bg-transparent text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--accent)]"
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
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="m16 17 5-5-5-5" />
                <path d="M21 12H9" />
              </svg>
            </button>
          </form>
        </div>
      </aside>

      {/* ---- Main ---- */}
      <section className="flex min-w-0 flex-col">
        <header className="flex h-[60px] items-center gap-[14px] border-b border-[var(--border)] bg-[var(--surface)] px-[22px]">
          <div className="text-[14.5px] font-[600] tracking-[-0.01em]">
            Workspace{" "}
            <span className="font-[500] text-[var(--text-3)]">
              / Getting started
            </span>
          </div>
          <div className="flex-1" />
          <div
            title="Model selection arrives in the next update"
            className="flex h-9 cursor-not-allowed items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 text-[13px] font-[550] text-[var(--text-3)]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[15px] w-[15px]"
            >
              <path d="M12 2a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 0 6 3 3 0 0 0 3 3 3 3 0 0 0 6 0 3 3 0 0 0 3-3 3 3 0 0 0 0-6 3 3 0 0 0-3-3 3 3 0 0 0-3-3Z" />
            </svg>
            Model
            <span className="rounded-[20px] bg-[var(--surface-3)] px-[6px] py-[2px] text-[10px] font-[600] text-[var(--text-3)]">
              Soon
            </span>
          </div>
          <PdfTestButton variant="topbar" />
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
      </section>
    </div>
  );
}
