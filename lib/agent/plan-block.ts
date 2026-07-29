/**
 * lib/agent/plan-block.ts — pure plan-block parsing for the research plan card
 * (RSCH-01, D-31/D-33/D-52). ZERO imports, zero I/O — unit-testable exactly like
 * `deriveChatTitle` (the house pure-fn analog).
 *
 * THE CONTRACT (D-31 + D-52):
 *   - The model opens its FIRST response to a report-style question with a
 *     fenced code block whose info string is exactly `plan` — the syntax LOCKED
 *     in DEEP_RESEARCH_SYSTEM (03-01; the prompt's inline example and this
 *     parser must agree byte-for-byte on the fence shape).
 *   - A model that omits the block produces NO row, NO card, NO error — graceful
 *     absence. There is no retry and no repair prompt (D-52 rejected both), so
 *     every malformed input maps to `[]`, never a throw.
 *   - Bounds mirror the zod planBlock schema (AI-SPEC § 4b Boundary 3):
 *     1..8 items, each 1..200 chars. Outside bounds → `[]` (malformed block
 *     must never produce a broken card).
 *
 * `stripPlanBlock` runs at BOTH the terminal `messages.content` write and the
 * `conversation.push` replay of the assistant turn, so the cached prefix stays
 * byte-consistent between the turn that wrote it and the turn that replays it
 * (D-49 interaction). It is idempotent on any conformant text (at most one plan
 * fence — the shape the prompt mandates); a pathological second fence survives
 * by design (first-fence-only removal).
 */

/**
 * The first line-anchored fenced block with info string exactly `plan`.
 * Body is capture group 1. Non-greedy so a later second fence is never merged
 * into the first. The opening fence must sit at the start of a line (markdown
 * fence semantics); an inline ``` mid-sentence never matches.
 */
const FENCE_RE = /(?:^|\r?\n)```plan[^\S\r\n]*\r?\n([\s\S]*?)\r?\n?```/;

/** Leading list markers the prompt allows: `1.` / `1)` digits+dot, dash, asterisk. */
const LIST_MARKER_RE = /^\s*(?:\d+[.)]\s*|[-*]\s+)/;

const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 200;

/** True once a COMPLETE ```plan … ``` fence exists in the accumulating text —
 *  the parse-once trigger the loop's first-turn delta scan uses (D-33). */
export function hasClosingMarker(acc: string): boolean {
  if (typeof acc !== "string" || acc.length === 0) return false;
  return FENCE_RE.test(acc);
}

/**
 * Parse the FIRST ```plan fence into 0..8 trimmed sub-question items.
 * Numbering / dash / asterisk markers are stripped; empties dropped; items over
 * 200 chars truncated. Missing, unclosed, empty, or >8-line fences → `[]`
 * (graceful absence, D-52). NEVER throws on arbitrary input.
 */
export function parsePlanBlock(acc: string): string[] {
  try {
    if (typeof acc !== "string" || acc.length === 0) return [];
    const m = FENCE_RE.exec(acc);
    if (!m) return [];
    const items: string[] = [];
    for (const raw of m[1].split(/\r?\n/)) {
      const item = raw.replace(LIST_MARKER_RE, "").trim();
      if (item.length === 0) continue;
      items.push(item.slice(0, MAX_ITEM_CHARS));
    }
    if (items.length < 1 || items.length > MAX_ITEMS) return [];
    return items;
  } catch {
    return []; // a malformed block must never produce a broken card (D-52)
  }
}

/**
 * Remove exactly the FIRST ```plan fence plus the blank-line residue around it.
 * Text without a fence passes through unchanged; only the first fence is
 * removed (a later second fence stays in place). The SAME function runs at the
 * terminal write and the history replay — byte-consistent both paths (D-49).
 */
export function stripPlanBlock(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const m = FENCE_RE.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index).replace(/(?:\r?\n)+$/, "");
  const after = text.slice(m.index + m[0].length).replace(/^(?:\r?\n)+/, "");
  if (before.length === 0) return after;
  if (after.length === 0) return before;
  return `${before}\n\n${after}`;
}
