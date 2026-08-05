"use client";

/**
 * MarkdownBlocks (04-07 — D-61 rung 3, adjudication T-7) — fence-aware
 * block-memoized react-markdown for the streaming answer bubble.
 *
 * WHY: `react-markdown@10` performs no memoization — it constructs a fresh
 * unified processor and re-parses the ENTIRE accumulated document on every
 * render (verified from `node_modules/react-markdown/lib/index.js:175-179`).
 * On a streamed answer that is O(n²) over the answer length, and it is the
 * one D-61 cost that rung 2's rAF batching cannot touch. This component
 * splits the document with `splitMarkdownBlocks` (the fence-aware splitter
 * from plan 04-03, `components/chat/markdown-blocks.ts`), renders each
 * COMPLETED block through a `memo()`d child, and renders the tail as the one
 * live block — each block is parsed once when it completes, plus the growing
 * tail. Total cost O(n).
 *
 * THE PIPELINE IS BYTE-FOR-BYTE THE EXISTING ONE. `remarkPlugins` is exactly
 * `[remarkGfm, remarkCitations(registry)]` and `components` is the caller's
 * module-level `markdownComponents` constant. No rehype stage is added, ever:
 * react-markdown's structural guarantee that raw HTML is NEVER parsed is the
 * primary XSS control on a render path fed by prompt-injectable fetched web
 * pages (threat T-04-32), and a rehype chain between remarkCitations and the
 * DOM is precisely what adjudication T-7 declined streamdown over. The
 * emitted citation href stays the literal `#src-{n}` fragment minted by
 * `lib/markdown/remark-citations.ts` (T-04-34) — untouched here.
 *
 * THE COMPARATOR IS THE CORRECTNESS SURFACE (T-04-33). `blockPropsEqual`
 * compares block text AND a registry version (`registry.size`). Text alone is
 * NOT enough: `remarkCitations` resolves `[n]` markers against the registry
 * at render time, and the locked RSCH-02 contract is that a marker streamed
 * before its source registers renders as plain text and UPGRADES to a link on
 * a later delta. A text-only comparator would freeze an early memoized
 * block's citations forever — silent, permanent, on the surface the reviewer
 * reads most. `registry.size` is a sound version counter because the registry
 * is append-only (`registry.add(n)` inside deriveRunSurfaces, never deleted):
 * membership cannot change without size changing. Growth happens ~5–10 times
 * per run (once per successful fetch), not per token, so invalidating all
 * blocks on growth keeps the amortised cost linear (T-04-37, accepted).
 *
 * The comparator is EXPLICIT rather than shallow because both versioned
 * inputs arrive as fresh identities every render — deriveRunSurfaces builds a
 * `new Set()` per call, and the plugin array literal inside Block is a fresh
 * object per render. Default shallow equality would return "changed" on every
 * flush and the memo would never fire at all. It is exported as a pure
 * function so `tests/markdown-blocks.test.ts` can pin the memo decision in
 * the node environment (no test in this repo can render a component).
 */

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkCitations } from "@/lib/markdown/remark-citations";
import { splitMarkdownBlocks } from "@/components/chat/markdown-blocks";

export interface MarkdownBlocksProps {
  /** The (possibly still-streaming) markdown document. */
  text: string;
  /**
   * The append-only citation registry from deriveRunSurfaces. Its SIZE is the
   * memo version term — see the module header and blockPropsEqual.
   */
  registry: Set<number>;
  /**
   * The caller's markdown component overrides. MUST be a module-level
   * constant (ChatThread's `markdownComponents` is, pinned by
   * tests/d61-rung2.test.ts) — the comparator deliberately excludes it, so a
   * per-render object literal here would not re-render blocks, it would be
   * silently ignored. Stable identity is the contract.
   */
  components: Components;
}

/**
 * The memo decision for one completed block, as an exported pure function so
 * it is testable without a DOM. Returns true ("reuse the memoized render")
 * only when both the block text and the registry version are unchanged. A
 * grown registry makes EVERY block re-render — that re-render is what
 * upgrades a plain-text `[n]` into a link when its source registers late
 * (RSCH-02; threat T-04-33).
 */
export function blockPropsEqual(
  a: Readonly<{ text: string; registry: Set<number> }>,
  b: Readonly<{ text: string; registry: Set<number> }>,
): boolean {
  return a.text === b.text && a.registry.size === b.registry.size;
}

/**
 * One markdown block through the EXACT existing pipeline. The plugin array is
 * a fresh identity every render by construction — that is fine precisely
 * because blockPropsEqual, not shallow equality, decides re-rendering.
 */
const Block = memo(function Block({
  text,
  registry,
  components,
}: MarkdownBlocksProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkCitations(registry)]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}, blockPropsEqual);

/**
 * Derive the block list the renderer actually consumes, as an exported pure
 * function so the append-only invariant is node-testable.
 *
 * The splitter's raw `blocks`/`tail` are NOT append-only under stream growth:
 * a delta ending exactly on `\n` leaves a transient trailing blank line, which
 * the splitter treats as a boundary — closing (say) a table's header row as a
 * "completed" block — and the very next delta (the delimiter row) reabsorbs
 * it into the tail, SHRINKING the block list. Discovered by comparator case 7
 * in tests/markdown-blocks.test.ts; consuming the raw split would make the
 * index-key stability claim false and waste a parse on every knife-edge
 * boundary.
 *
 * The rule that restores strict append-only growth: promote a block to the
 * memoized (completed) list only once content EXISTS past its boundary. A
 * boundary blank line that is followed by a content line is itself
 * newline-terminated and can never be re-opened by later deltas, so a
 * promotion can never be undone. When the text currently ends at a boundary
 * (empty tail), the last block stays live instead — rendered output is
 * identical (same text through the same pipeline), it is merely not yet
 * eligible for memo reuse.
 */
export function deriveBlockList(text: string): {
  completed: string[];
  live: string;
} {
  const { blocks, tail } = splitMarkdownBlocks(text);
  if (tail.length > 0) return { completed: blocks, live: tail };
  return {
    completed: blocks.slice(0, -1),
    live: blocks[blocks.length - 1] ?? "",
  };
}

/**
 * The parent: split, render completed blocks memoized, render the live text
 * as the one growing block. Index keys are sound here and only here: by
 * deriveBlockList's promotion rule the completed list is strictly append-only
 * under stream growth — a block at index i never changes text, moves, or is
 * removed (pinned by comparator case 7). The live block sits at index
 * `completed.length`; when it is promoted, the next live block takes the next
 * key, so element identities carry over and the memo simply sees each block's
 * final text.
 *
 * A short answer with no completed boundary renders as completed=[] plus the
 * whole text live — the same single code path, no second renderer.
 */
export function MarkdownBlocks({
  text,
  registry,
  components,
}: MarkdownBlocksProps) {
  const { completed, live } = deriveBlockList(text);
  return (
    <>
      {completed.map((block, i) => (
        <Block key={i} text={block} registry={registry} components={components} />
      ))}
      {live.length > 0 && (
        <Block
          key={completed.length}
          text={live}
          registry={registry}
          components={components}
        />
      )}
    </>
  );
}
