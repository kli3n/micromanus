"use client";

import { useEffect, useState } from "react";

/**
 * RunMeter (STAT-06 / D-55, D-56 — 03-03).
 *
 * The first row of the existing left-bordered tool rail — NOT a floating
 * element — so appending tool lines below never moves it. Fixed 24px
 * min-height row, mono 11px --text-2 tabular-nums, min-width 11ch on the text
 * span so digit changes cause zero width jitter [BD §8].
 *
 * States (locked copy — 🔒 do not reword):
 *   running:  "iteration {n}/12 · {m}:{ss} elapsed"  + 13px .agent-spinner
 *   terminal: "{n} iterations · {m}:{ss}"            + same-size 16px empty slot
 *
 * Elapsed ticks client-side from `startedAt` (runs.started_at) on ONE 1s
 * setInterval, cleared the moment the run is terminal or the component
 * unmounts (T-3-32). The TERMINAL elapsed renders the supplied `elapsedMs` —
 * the server-computed ended_at - started_at from the meter carrier payload —
 * never the client clock (D-56, RESEARCH C2).
 *
 * a11y: aria-live="off", and this row must sit OUTSIDE the rail's polite
 * role="status" region — a 1s-ticking live region would spam assistive tech.
 */

/** "m:ss" from milliseconds; negative / non-finite input clamps to "0:00". */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** The locked meter label (🔒 03-UI-SPEC Copywriting Contract — do not reword). */
export function meterLabel({
  running,
  iterations,
  elapsedMs,
}: {
  running: boolean;
  iterations: number;
  elapsedMs: number;
}): string {
  return running
    ? `iteration ${iterations}/12 · ${formatElapsed(elapsedMs)} elapsed`
    : `${iterations} iterations · ${formatElapsed(elapsedMs)}`;
}

export function RunMeter({
  startedAt,
  iterations,
  running,
  elapsedMs,
}: {
  /** ISO timestamp — runs.started_at (the meter carrier payload). */
  startedAt: string;
  /** Running: max(SSE meter event, Realtime runs.iterations). Terminal: payload value. */
  iterations: number;
  running: boolean;
  /** Terminal only: server-computed ended_at - started_at (never the client clock). */
  elapsedMs?: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  // One 1s tick while running; cleared on terminal (running -> false) and on
  // unmount via the effect cleanup (T-3-32: single interval, never leaked).
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [running]);

  const startMs = Date.parse(startedAt);
  const liveElapsed = Number.isFinite(startMs) ? Math.max(0, now - startMs) : 0;
  const label = meterLabel({
    running,
    iterations,
    // Terminal: supplied server elapsed only; a defensively-missing value
    // renders 0:00 (formatElapsed clamps NaN) rather than a client recompute.
    elapsedMs: running ? liveElapsed : (elapsedMs ?? Number.NaN),
  });

  return (
    <div
      aria-live="off"
      className="flex min-h-[24px] items-center gap-[10px] py-[4px] pl-[14px] text-[11px] text-[var(--text-2)]"
      style={{ fontFamily: "var(--mono)", fontVariantNumeric: "tabular-nums" }}
    >
      <span className="grid h-4 w-4 flex-none place-items-center">
        {running ? <span className="agent-spinner" aria-hidden="true" /> : null}
      </span>
      <span className="min-w-[11ch]">{label}</span>
    </div>
  );
}
