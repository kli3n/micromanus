import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * tests/d61-rung2.test.ts — structural evidence for the four rung-2 changes
 * (04-05, D-61), in the `tests/done-frame.test.ts` house style: assertions
 * over the component SOURCE, because the mechanisms under test live inside a
 * "use client" component this DOM-less runner cannot mount, and the
 * deterministic replay measurement that would prove them end-to-end needs an
 * authenticated session that was declined at checkpoint (04-03 and again at
 * 04-05 — see both SUMMARYs). These pins are the measured-neutral fallback:
 * they cannot QUANTIFY the win, but they turn the three rAF correctness traps
 * (T-04-20/21/25), the memo-enabling segment key, the single-derivation
 * parity contract (T-04-23) and the stable-props discipline (T-04-22) into
 * regressions a suite catches instead of review conventions.
 *
 * Two-sided validation (the 04-03 lesson: an assertion only counts once it
 * has been observed to fail in the state it exists to catch): this exact
 * suite was run against the pre-04-05 source (`git show 0133d1b`) during
 * development. The observed failure count is recorded in 04-05-SUMMARY.md.
 */

const THREAD = readFileSync(
  new URL("../components/ChatThread.tsx", import.meta.url),
  "utf8",
);

/** Index that must exist — fails loudly instead of returning -1 into a
 *  greater-than assertion that would pass by accident. */
function at(haystack: string, needle: string, from = 0): number {
  const i = haystack.indexOf(needle, from);
  expect(i, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return i;
}

describe("rung 2a — rAF delta batching with cancelFlush on every terminal path", () => {
  it("the token case queues the delta instead of patching state directly", () => {
    const tokenAt = at(THREAD, 'case "token": {');
    const nextCase = at(THREAD, 'case "tool_status": {', tokenAt);
    const tokenCase = THREAD.slice(tokenAt, nextCase);
    expect(tokenCase).toContain("queueDelta(assistantId");
    // A direct patchMessage here would reintroduce one commit per delta and
    // silently bypass every cancelFlush contract below.
    expect(tokenCase).not.toContain("patchMessage(");
  });

  it("queueDelta schedules at most ONE pending frame", () => {
    const qAt = at(THREAD, "function queueDelta(");
    const body = THREAD.slice(qAt, at(THREAD, "requestAnimationFrame", qAt));
    expect(body).toContain("if (rafRef.current !== null) return;");
  });

  it("handleStreamDrop cancels BEFORE the blanking write (CHAT-08 / T-04-20)", () => {
    const dropAt = at(THREAD, "async function handleStreamDrop");
    const cancelAt = at(THREAD, "cancelFlush();", dropAt);
    const blankAt = at(THREAD, 'content: ""', dropAt);
    // A pending frame firing after the blank would repaint partial text the
    // user is entitled to believe was discarded.
    expect(cancelAt).toBeLessThan(blankAt);
  });

  it("the error branch FLUSHES before it reads m.content (T-04-21)", () => {
    const errAt = at(THREAD, 'case "error": {');
    // Anchor on the CODE form (`content: m.content || msg`), not the bare
    // expression — the explanatory comment above the flush call quotes it too.
    const readAt = at(THREAD, "content: m.content || msg", errAt);
    const flushAt = at(THREAD, "flushDeltaNow(assistantId);", errAt);
    // Flush — not cancel: buffered-but-unpainted deltas WERE delivered, and an
    // unflushed buffer would let the error copy clobber a delivered answer.
    expect(flushAt).toBeLessThan(readAt);
  });

  it("flushDeltaNow delivers the buffer, then clears it via cancelFlush", () => {
    const fAt = at(THREAD, "function flushDeltaNow(");
    const body = THREAD.slice(fAt, at(THREAD, "function queueDelta(", fAt));
    const captureAt = at(body, "const buffered = pendingDeltaRef.current;");
    const cancelAt = at(body, "cancelFlush();");
    expect(captureAt).toBeLessThan(cancelAt);
    expect(body).toContain("m.content + buffered");
  });

  it("streamRun's finally cancels, so no frame outlives the stream that queued it", () => {
    const runAt = at(THREAD, "async function streamRun(");
    const finallyAt = at(THREAD, "} finally {", runAt);
    const dropAt = at(THREAD, "async function handleStreamDrop", runAt);
    expect(THREAD.slice(finallyAt, dropAt)).toContain("cancelFlush();");
  });

  it("unmount cancels too (T-04-25)", () => {
    expect(THREAD).toContain("useEffect(() => () => cancelFlush(), []);");
  });
});

describe("rung 2b — replaySegments keyed on a signature that ignores assistant content", () => {
  it("the memo is keyed on segmentKey, not on messages", () => {
    const memoAt = at(THREAD, "const replaySegments = useMemo(");
    const after = at(THREAD, "const exportTitle", memoAt);
    const memoBlock = THREAD.slice(memoAt, after);
    expect(memoBlock).toContain("}, [segmentKey]);");
    // The pre-04-05 key: re-ran the whole walk (and every tool-row JSON.parse)
    // once per token, and handed each row a fresh array identity that made
    // memo() on the row structurally unable to fire.
    expect(memoBlock).not.toContain("}, [messages]);");
  });

  it("the signature carries tool-row content and ONLY id/role for the rest", () => {
    expect(THREAD).toContain("`t:${m.id}:${m.content.length}`");
    expect(THREAD).toContain("`${m.role[0]}:${m.id}`");
  });
});

describe("rung 2c — memoized MessageRow with the single derivation inside it", () => {
  it("MessageRow exists and is wrapped in memo()", () => {
    expect(THREAD).toContain("const MessageRow = memo(function MessageRow(");
  });

  it("deriveRunSurfaces has exactly ONE call site, inside MessageRow (T-04-23)", () => {
    const calls = THREAD.match(/deriveRunSurfaces\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const rowAt = at(THREAD, "const MessageRow = memo(");
    const threadAt = at(THREAD, "export function ChatThread(");
    const callAt = at(THREAD, "deriveRunSurfaces(");
    // One function feeding live and replayed rows alike is the ONLY mechanism
    // enforcing the D-25/26/27 parity contract; a second call site would fork it.
    expect(callAt).toBeGreaterThan(rowAt);
    expect(callAt).toBeLessThan(threadAt);
  });

  it("the call site passes no fresh identities that would defeat memo() (T-04-22)", () => {
    const siteAt = at(THREAD, "<MessageRow");
    const site = THREAD.slice(siteAt, at(THREAD, "/>", siteAt));
    // A `?? []`, a fresh Set or an inline spread in the prop list makes the
    // memo a no-op — the specific way this refactor fails while looking done.
    expect(site).not.toContain("?? []");
    expect(site).not.toContain("new Set");
    expect(site).not.toContain("[...");
  });

  it("markdownComponents stays module-level, outside any component body", () => {
    const constAt = at(THREAD, "const markdownComponents");
    expect(THREAD.match(/const markdownComponents/g) ?? []).toHaveLength(1);
    // Before the first component that renders markdown — i.e. module scope,
    // not re-created per render inside MessageRow or ChatThread.
    expect(constAt).toBeLessThan(at(THREAD, "const MessageRow = memo("));
    expect(constAt).toBeLessThan(at(THREAD, "export function ChatThread("));
  });
});

describe("rung 2d — the near-bottom autoscroll guard", () => {
  it("the messages effect only scrolls while the user is already near the bottom", () => {
    expect(THREAD).toContain("if (atBottomRef.current) scrollToBottom();");
    // Unguarded, scrollIntoView forced a synchronous layout once per token AND
    // yanked a reader who had scrolled up back to the bottom.
    expect(THREAD).not.toMatch(/=>\s*\{\s*scrollToBottom\(\);\s*\}, \[messages/);
  });

  it("the predicate is sampled on scroll, where the measurement is honest", () => {
    expect(THREAD).toContain("onScroll={onScrollerScroll}");
    expect(THREAD).toContain("el.scrollHeight - el.scrollTop - el.clientHeight");
  });
});
