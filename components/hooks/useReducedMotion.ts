"use client";

import { useEffect, useState } from "react";

/**
 * useReducedMotion (WR-09) — the ONLY sanctioned place in this codebase to read
 * the `prefers-reduced-motion` preference from JavaScript.
 *
 * CSS IS THE PREFERRED ROUTE. If the motion decision can be expressed as a
 * style — a `transition`, a `transition-duration`, an `animation` — express it
 * in CSS and let the cascade decide: the `motion-reduce:` Tailwind variant
 * (see `components/chat/ExportPdfButton.tsx`, `ResearchPlanCard.tsx`,
 * `SourcesCard.tsx`) or an `@media (prefers-reduced-motion: reduce)` block in
 * `app/globals.css` (the `.badge-dot-pulse`, `.streaming-cursor` and
 * `.agent-spinner` blocks). CSS needs no hook, cannot desynchronise from the
 * server markup, and updates live for free. Reach for this hook ONLY when JS
 * genuinely needs the boolean — e.g. to SKIP an imperative effect entirely
 * rather than merely leave its transition off (`ArtifactCard`'s snap-then-fade,
 * whose two `requestAnimationFrame` hops would otherwise still flash the
 * element to opacity 0 and back under reduced motion).
 *
 * THE `false` INITIAL VALUE IS LOAD-BEARING, NOT A DEFAULT. It is the SSR-safe
 * value: the server has no media queries, so it must render as if motion were
 * allowed. Seeding the initial state from `window.matchMedia(...)` — even
 * guarded by a `typeof window` check — makes the first CLIENT render disagree
 * with the server markup for any reduced-motion user, which is precisely the
 * hydration mismatch WR-09 reports. The real preference is therefore read only
 * AFTER mount, inside an effect, and never during render.
 *
 * The `change` subscription is what makes toggling the OS setting with the page
 * open take effect without a reload.
 */
export function useReducedMotion(): boolean {
  // SSR-safe initial value — see the header. Never seed this from a media query.
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduceMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduceMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduceMotion;
}
