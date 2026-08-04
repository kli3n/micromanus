/**
 * components/chat/markdown-blocks.ts — split streamed markdown into completed
 * blocks plus a trailing incomplete tail, WITHOUT ever cutting a fenced code
 * block or a GFM table in half.
 *
 * NO React import and NO client directive at the top of this file, following the
 * `components/chat/render-rules.ts` + `components/chat/RunMeter.tsx` seam: this
 * is pure text handling, not markup, so a node-env Vitest run pins it through
 * the `@/` alias with no DOM. The client component that imports it supplies its
 * own directive; a leaf with none is legal in both graphs.
 *
 * WHY IT EXISTS BEFORE IT HAS A CONSUMER (04-03 Task 2, adjudication T-7).
 * `react-markdown@10.1.0` performs no memoization: its exported component
 * constructs a fresh unified processor and re-parses the ENTIRE document on
 * every render, which is cost 5 of the six compounding D-61 per-token costs and
 * the one that batching cannot touch (it is O(document length), so it grows as
 * the answer grows). The sanctioned rung 3 of the D-61 ladder is therefore
 * block-memoized react-markdown: memoize the completed blocks, re-parse only
 * the tail. `streamdown` was declined (rung 4, closed).
 *
 * That escalation is gated on the 04-05 re-measurement, so this module may end
 * up with no consumer at all — and building it now is still deliberate: the
 * escalation must not have to invent its own substrate under time pressure, and
 * a boundary bug here corrupts rendered markdown, which is not something to
 * debug against a clock. Plan 04-07 decides; plan 04-07 wires it into
 * `components/chat/MarkdownBlocks.tsx` if the answer is yes.
 *
 * THE RULE, STATED ONCE AND IMPLEMENTED ONCE: a blank line ends a block ONLY
 * when fence depth is 0. Everything after the last such boundary is the tail.
 * A naive `\n\n` split corrupts BOTH halves of a rung-3 memo — a blank line
 * inside a fence, or between GFM table rows, would cut the construct in two and
 * each half then parses as something else entirely (a fence half becomes prose;
 * a table half loses its delimiter row and stops being a table).
 *
 * WORST CASE is deliberate and is no worse than today (T-04-13): a pathological
 * unclosed fence makes the whole document one tail, which is exactly what
 * `react-markdown` already does with it. The scan is a single pass over the
 * lines and the fence test is anchored to ONE line, so there is no
 * backtracking regex over the document and no catastrophic-backtracking
 * surface.
 */

/**
 * A line that opens or closes a fence: three backticks or three tildes, with
 * optional leading whitespace and any info string after them.
 *
 * Anchored to a single line on purpose (see the module header). This is a
 * depth TOGGLE rather than a matched-delimiter parser, which is the correct
 * approximation for the streaming case: mid-stream the closing fence has not
 * arrived yet, and a toggle keeps everything from the opener onward in the tail
 * — precisely the behaviour a block memo needs.
 */
const FENCE_LINE = /^\s*(```|~~~)/;

/**
 * Split `src` into completed blocks and the trailing incomplete tail.
 *
 * The blank line at a depth-0 boundary is CONSUMED as the separator, so
 * re-joining `blocks` and `tail` reproduces the input's content lines (in
 * order, unmutated) rather than the input byte-for-byte. That is the invariant
 * `tests/markdown-blocks.test.ts` asserts on every case, and it is the
 * assertion that catches a subtle off-by-one in the boundary logic.
 *
 * `\r\n` is normalised BEFORE splitting: a carriage return left on a block's
 * last line is itself a corruption (it would survive into the memoized block
 * and reach the renderer), and normalising once here is cheaper and more
 * obviously correct than trimming per boundary.
 */
export function splitMarkdownBlocks(src: string): {
  blocks: string[];
  tail: string;
} {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE_LINE.test(line)) inFence = !inFence;
    // The whole rule: a blank line closes the current block only at depth 0,
    // and only when there is something to close (so runs of blank lines and a
    // leading blank line do not emit empty blocks).
    if (!inFence && line.trim() === "" && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }

  return { blocks, tail: current.join("\n") };
}
