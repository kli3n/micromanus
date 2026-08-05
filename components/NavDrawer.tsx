"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * NavDrawer (D-68 / D-71) — the mobile off-canvas drawer's client island.
 *
 * Named exports, no default: NavDrawerProvider, NavDrawerToggle,
 * NavDrawerClose. One internal context carries { open, toggle, close,
 * closeButtonRef } so the two trigger components consume drawer state without
 * the async server AppShell having to close over any client state (R-9).
 * AppShell passes the server-rendered sidebar in as a slot, so the drawer
 * never mounts a second copy of sidebar state — the panel IS today's sidebar
 * markup, repositioned by CSS (see DRAWER_CSS in components/AppShell.tsx).
 *
 * WHY NO DIALOG ROLE AND NO MODAL ATTRIBUTE (a judgement call, recorded here
 * so the next reader can revisit it): with `inert` on the background
 * <section>, the modality is already real — everything behind the scrim is
 * unreachable by pointer, keyboard AND assistive technology — so adding
 * aria-modal would change nothing, and converting the <aside> navigation into
 * a dialog would LOSE the navigation landmark that helps screen-reader users
 * orient. Neither axe nor Lighthouse tests this either way
 * (04-RESEARCH § Pattern 4).
 *
 * CONSEQUENCE WORTH BEING DELIBERATE ABOUT: `inert` suppresses live regions
 * inside the inert subtree, so while the drawer is open the chat's
 * role="status" aria-live="polite" tool-status announcements stop. That is
 * arguably correct — the content is visually behind a scrim too, and
 * announcing content the user cannot reach would be worse — but it is a
 * conscious trade recorded here rather than a surprise (T-04-30, accepted).
 *
 * THE FOCUS TRAP IS `inert` — no tabbable-node collection, no manual focus
 * cycling, no focus-trap dependency. `inert` also blocks pointer and
 * assistive-technology access, which a tab-cycling JS trap does not. The
 * structural insight that makes this correct with no viewport check: the
 * hamburger only renders below `lg`, so open === true implies a sub-`lg`
 * viewport at all times. The codebase's only sanctioned JS environment read
 * stays components/hooks/useReducedMotion.ts, which this module does not
 * need — the drawer's motion is a CSS transition, gated by a CSS
 * prefers-reduced-motion media block, never by JS.
 *
 * Four behaviours need JS, and none of them is a focus trap:
 *   1. open/close state (plus storing the trigger element on open);
 *   2. Escape closes — a document keydown listener that exists only while
 *      open and is removed in the effect's cleanup;
 *   3. focus moves to the close button on open, and back to the stored
 *      trigger on close — both halves, or a keyboard user is stranded;
 *   4. route navigation closes it for free: the sidebar links are plain
 *      anchors, so navigating unmounts this state naturally.
 *
 * No drag or gesture handling of any kind — keyboard and click/tap only
 * (declined in the UI-SPEC as new scope with accessibility risk).
 */

interface NavDrawerContextValue {
  open: boolean;
  toggle: () => void;
  close: () => void;
  closeButtonRef: RefObject<HTMLButtonElement | null>;
}

const NavDrawerContext = createContext<NavDrawerContextValue | null>(null);

function useNavDrawer(): NavDrawerContextValue {
  const ctx = useContext(NavDrawerContext);
  if (ctx === null) {
    throw new Error(
      "NavDrawer components must be rendered inside <NavDrawerProvider>",
    );
  }
  return ctx;
}

/**
 * NavDrawerProvider — renders the shell's grid root, then in order: the
 * server-rendered sidebar slot inside the #nav-drawer <aside>, the scrim, and
 * the main content inside a <section> that is inert while the drawer is open.
 * All class strings are passed in from AppShell so the layout contract stays
 * in the server component the gates scan.
 */
export function NavDrawerProvider({
  className,
  sidebarClassName,
  contentClassName,
  sidebar,
  children,
}: {
  className?: string;
  sidebarClassName?: string;
  contentClassName?: string;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  // Behaviour 1: open/close. On open, store the currently-focused element
  // (the hamburger) so behaviour 3 can restore focus to it on close.
  const toggle = useCallback(() => {
    if (!open) {
      restoreFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    setOpen(!open);
  }, [open]);

  // Behaviour 3: focus moves to the close button on open; back to the stored
  // trigger on close. The wasOpenRef guard keeps the initial mount (closed)
  // from stealing focus.
  useEffect(() => {
    if (open) {
      closeButtonRef.current?.focus();
    } else if (wasOpenRef.current) {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
    }
    wasOpenRef.current = open;
  }, [open]);

  // Behaviour 2: Escape closes. The listener exists only while open and is
  // removed in the cleanup, so handlers never accumulate across opens
  // (T-04-28).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  return (
    <NavDrawerContext.Provider value={{ open, toggle, close, closeButtonRef }}>
      <div className={className}>
        <aside
          id="nav-drawer"
          aria-label="Navigation"
          data-drawer={open ? "open" : "closed"}
          className={sidebarClassName}
        >
          {sidebar}
        </aside>
        {/* Scrim: click closes (dismissal). lg:hidden removes it from the grid
            flow at and above the breakpoint, keeping the desktop layout
            byte-identical; below the breakpoint DRAWER_CSS positions it fixed. */}
        <div
          className="drawer-scrim lg:hidden"
          data-drawer={open ? "open" : "closed"}
          onClick={close}
          aria-hidden="true"
        />
        {/* The focus trap: while the drawer is open the whole main section is
            inert — unreachable by tab, pointer and assistive technology. */}
        <section inert={open} className={contentClassName}>
          {children}
        </section>
      </div>
    </NavDrawerContext.Provider>
  );
}

/**
 * NavDrawerToggle — the hamburger. A real button carrying the expanded-state
 * attribute; this is the ONE place in this phase that attribute belongs (a
 * custom toggle needs it — a native details/summary never does, T-3).
 * AppShell renders it with lg:hidden so it is removed from layout entirely at
 * and above the breakpoint.
 */
export function NavDrawerToggle({ className }: { className?: string }) {
  const { open, toggle } = useNavDrawer();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-controls="nav-drawer"
      aria-label="Open navigation"
      className={`grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[8px] border border-transparent bg-transparent text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)] motion-reduce:transition-none ${className ?? ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[18px] w-[18px]"
        aria-hidden="true"
      >
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}

/**
 * NavDrawerClose — the panel's close button, top-right inside the panel. It
 * takes the provider's closeButtonRef so focus can be moved to it on open.
 */
export function NavDrawerClose({ className }: { className?: string }) {
  const { close, closeButtonRef } = useNavDrawer();
  return (
    <button
      ref={closeButtonRef}
      type="button"
      onClick={close}
      aria-label="Close navigation"
      className={`grid h-11 w-11 shrink-0 cursor-pointer place-items-center rounded-[8px] border border-transparent bg-transparent text-[var(--text-2)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)] motion-reduce:transition-none ${className ?? ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[18px] w-[18px]"
        aria-hidden="true"
      >
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
    </button>
  );
}
