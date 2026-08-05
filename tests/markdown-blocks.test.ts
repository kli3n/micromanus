import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "@/components/chat/markdown-blocks";
import {
  blockPropsEqual,
  deriveBlockList,
} from "@/components/chat/MarkdownBlocks";

/**
 * splitMarkdownBlocks (04-03 Task 2) — the fence-aware block splitter that is
 * the substrate for the sanctioned rung 3 of the D-61 ladder (adjudication
 * T-7: fence-aware block-memoized react-markdown; streamdown declined).
 *
 * The correctness requirement it exists for: `react-markdown@10` re-parses the
 * WHOLE document on every render, so a rung-3 fix memoizes completed blocks and
 * re-parses only the tail. A naive `\n\n` split corrupts BOTH halves of that —
 * a blank line inside a fenced code block or between GFM table rows would cut
 * the fence/table in two, and each half then parses as something else entirely.
 * So the rule is: a blank line ends a block ONLY at fence depth 0.
 *
 * The round-trip invariant below is the assertion that catches a subtle
 * off-by-one in the boundary logic — exactly the failure that would corrupt
 * rendered markdown — so it runs on EVERY case via a shared helper rather than
 * being restated (and therefore forgettable) per case.
 */

/**
 * Re-join `blocks` + `tail` and assert the result carries the input's non-blank
 * lines, in order, unchanged. Blank lines are excluded deliberately: a blank
 * line AT a depth-0 boundary is consumed as the separator (that is the rule),
 * so a byte-exact round trip is not the contract — no content line may be
 * dropped, duplicated, reordered or mutated is.
 *
 * `\r\n` is normalised on the expected side too, because the splitter
 * normalises it (a carriage return leaking into a block's last line is itself a
 * corruption, and the `\r\n` case asserts that separately).
 */
function assertRoundTrip(
  src: string,
  result: { blocks: string[]; tail: string },
): void {
  const nonBlank = (s: string) =>
    s
      .replace(/\r\n/g, "\n")
      .split("\n")
      .filter((l) => l.trim() !== "");
  const rejoined = [...result.blocks, result.tail].join("\n");
  expect(nonBlank(rejoined)).toEqual(nonBlank(src));
}

/** Split + round-trip in one call, so no case can silently skip the invariant. */
function splitWithRoundTrip(src: string): { blocks: string[]; tail: string } {
  const result = splitMarkdownBlocks(src);
  assertRoundTrip(src, result);
  return result;
}

describe("splitMarkdownBlocks", () => {
  it("case 1 — empty input returns no blocks and an empty tail", () => {
    const r = splitWithRoundTrip("");
    expect(r).toEqual({ blocks: [], tail: "" });
  });

  it("case 2 — two paragraphs split into one completed block plus the second as the tail", () => {
    const r = splitWithRoundTrip("First paragraph.\n\nSecond paragraph.");
    expect(r.blocks).toEqual(["First paragraph."]);
    expect(r.tail).toBe("Second paragraph.");
  });

  it("case 3 — a fenced code block containing a blank line is NEVER split", () => {
    const src = [
      "Intro line.",
      "",
      "```ts",
      "const a = 1;",
      "",
      "const b = 2;",
      "```",
      "",
      "After the fence.",
    ].join("\n");
    const r = splitWithRoundTrip(src);
    expect(r.blocks).toEqual([
      "Intro line.",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```",
    ]);
    expect(r.tail).toBe("After the fence.");
    // The fence lives in exactly ONE block, whole.
    const whole = [...r.blocks, r.tail].filter((b) => b.includes("```"));
    expect(whole).toHaveLength(1);
    expect(whole[0]).toContain("const a = 1;");
    expect(whole[0]).toContain("const b = 2;");
  });

  it("case 4 — a fence opened and never closed leaves everything from the opener in the tail (the mid-stream case)", () => {
    const src = [
      "Here is the code:",
      "",
      "```python",
      "def f():",
      "",
      "    return 1",
    ].join("\n");
    const r = splitWithRoundTrip(src);
    expect(r.blocks).toEqual(["Here is the code:"]);
    expect(r.tail).toBe("```python\ndef f():\n\n    return 1");
    // No boundary fell INSIDE the open fence.
    expect(r.blocks.some((b) => b.includes("def f()"))).toBe(false);
  });

  it("case 5 — a GFM table followed by a blank line ends a block with every row intact", () => {
    const src = [
      "| Model | Input |",
      "| --- | --- |",
      "| kimi-k3 | $3.00 |",
      "| kimi-k2.6 | $0.95 |",
      "",
      "Trailing prose.",
    ].join("\n");
    const r = splitWithRoundTrip(src);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]).toBe(
      "| Model | Input |\n| --- | --- |\n| kimi-k3 | $3.00 |\n| kimi-k2.6 | $0.95 |",
    );
    expect(r.tail).toBe("Trailing prose.");
    // No boundary fell between table rows.
    expect(r.blocks[0]?.split("\n")).toHaveLength(4);
  });

  it("case 6 — \\r\\n line endings behave identically to \\n", () => {
    const lf = "Para one.\n\n```ts\nx\n\ny\n```\n\nTail here.";
    const crlf = lf.replace(/\n/g, "\r\n");
    const a = splitWithRoundTrip(lf);
    const b = splitWithRoundTrip(crlf);
    expect(b).toEqual(a);
    // The ABSOLUTE shape, not just lf-equals-crlf: two naive splits agree with
    // each other, so an equality-only assertion here is blind to the
    // fence-depth guard. Measured — weakening the guard must turn this red.
    expect(b.blocks).toEqual(["Para one.", "```ts\nx\n\ny\n```"]);
    expect(b.tail).toBe("Tail here.");
    // A carriage return must never leak into a block's last line.
    expect([...b.blocks, b.tail].some((s) => s.includes("\r"))).toBe(false);
  });

  it("case 7 — a blank line inside a nested list splits deterministically and loses no content", () => {
    const src = [
      "- Outer item",
      "  - Inner item",
      "",
      "  - Inner item after a blank line",
      "- Second outer item",
      "",
      "Closing prose.",
    ].join("\n");
    const r = splitWithRoundTrip(src);
    // Deterministic: a depth-0 blank line IS a boundary here (a list is not a
    // fence, and CommonMark loose-list semantics are the renderer's problem,
    // not the splitter's) — what matters is that no content line is lost.
    expect(r.blocks).toEqual([
      "- Outer item\n  - Inner item",
      "  - Inner item after a blank line\n- Second outer item",
    ]);
    expect(r.tail).toBe("Closing prose.");
    expect(splitMarkdownBlocks(src)).toEqual(r); // deterministic across calls
  });

  it("case 8 — input that is only a fence opener returns no blocks and that line as the tail", () => {
    const r = splitWithRoundTrip("```");
    expect(r.blocks).toEqual([]);
    expect(r.tail).toBe("```");
    // Same for a tilde fence with an info string and leading whitespace.
    const t = splitWithRoundTrip("  ~~~json");
    expect(t.blocks).toEqual([]);
    expect(t.tail).toBe("  ~~~json");
  });

  it("case 9 — the round-trip invariant holds on a long realistic mixed document", () => {
    const src = [
      "# Findings",
      "",
      "Solid-state cells are near pilot scale [1].",
      "",
      "| Vendor | Status |",
      "| --- | --- |",
      "| A | pilot |",
      "",
      "```bash",
      "npm run build",
      "",
      "npm test",
      "```",
      "",
      "- point one",
      "- point two",
      "",
      "> A blockquote with a [2] citation.",
      "",
      "~~~",
      "unclosed tilde fence at the stream edge",
    ].join("\n");
    const r = splitWithRoundTrip(src);
    // The bash fence survives WHOLE in ONE block. Asserting the exact string is
    // load-bearing: `startsWith("```bash")` plus a separate `includes("npm
    // test")` is satisfied by a naive split too (it yields "```bash\nnpm run
    // build" and "npm test\n```" as two blocks, and both predicates still
    // hold) — so the loose form was blind to the very guard this case exists
    // to prove. Measured against a deliberately weakened splitter.
    const fenced = r.blocks.filter((b) => b.includes("npm run build"));
    expect(fenced).toEqual(["```bash\nnpm run build\n\nnpm test\n```"]);
    expect(r.blocks.filter((b) => b.includes("```"))).toHaveLength(1);
    expect(r.tail).toBe("~~~\nunclosed tilde fence at the stream edge");
    // And the invariant itself, stated explicitly here as well as in the helper.
    assertRoundTrip(src, r);
  });
});

/**
 * blockPropsEqual (04-07 Task 2) — the memo comparator for the rung-3
 * block-memoized renderer (`components/chat/MarkdownBlocks.tsx`).
 *
 * This is THE correctness surface of the escalation, tested as an exported
 * pure function because no test in this repo can render a component (node
 * env, no DOM). The memo decision — "is this completed block's rendered
 * output re-derived or reused?" — is exactly the comparator's return value,
 * so asserting the comparator IS asserting the memo behaviour.
 *
 * The one non-obvious term: the comparator must include a REGISTRY VERSION.
 * `remarkCitations(registry)` resolves `[n]` markers at render time, and the
 * locked RSCH-02 contract (lib/markdown/remark-citations.ts:9-10) is that a
 * marker streamed before its source registers renders as plain text and
 * UPGRADES to a link on a later delta. A text-only comparator would freeze an
 * early memoized block's citations forever — a silent, permanent regression
 * on the surface the reviewer reads most (threat T-04-33). `registry.size` is
 * a sound version counter because the registry is append-only (built by
 * `registry.add(n)` inside deriveRunSurfaces, never deleted), so its size is
 * monotonic.
 *
 * Two-sided discipline (same as tests/d61-rung2.test.ts): the cases below
 * also pin why the EXPLICIT comparator is load-bearing — the registry `Set`
 * is a fresh object identity on every render (deriveRunSurfaces constructs
 * `new Set()` per call), so React's default shallow prop equality would
 * return "not equal" on every flush and the memo would never fire at all.
 */
describe("blockPropsEqual (rung-3 memo comparator)", () => {
  /** A prop shape per render: fresh Set identity, as deriveRunSurfaces produces. */
  const props = (text: string, registered: number[]) => ({
    text,
    registry: new Set(registered),
  });

  it("comparator case 1 — identical text + identical registry size compare equal across FRESH registry identities (shallow equality would re-render every block)", () => {
    const a = props("A completed paragraph.", [1, 2]);
    const b = props("A completed paragraph.", [1, 2]);
    // The fresh-identity fact that makes the explicit comparator load-bearing:
    expect(Object.is(a.registry, b.registry)).toBe(false);
    // Default shallow equality (what memo() without a comparator would do)
    // says "changed" — the memo would never fire:
    expect(a.registry === b.registry && a.text === b.text).toBe(false);
    // The explicit comparator says "unchanged" — the block is NOT re-parsed:
    expect(blockPropsEqual(a, b)).toBe(true);
  });

  it("comparator case 2 — a completed block is not re-derived when the tail grows (the pure memo decision across stream growth)", () => {
    const step1 = "First block.\n\nSecond blo";
    const step2 = "First block.\n\nSecond block grows and grows";
    const r1 = splitMarkdownBlocks(step1);
    const r2 = splitMarkdownBlocks(step2);
    // Same completed-block prefix on both steps…
    expect(r2.blocks).toEqual(r1.blocks);
    // …and for every completed block, the comparator (fed fresh registry
    // identities per render, unchanged size) decides "reuse", never "re-parse".
    for (let i = 0; i < r1.blocks.length; i++) {
      expect(
        blockPropsEqual(props(r1.blocks[i], [1]), props(r2.blocks[i], [1])),
      ).toBe(true);
    }
    // The live tail DID change, so the tail block re-renders:
    expect(blockPropsEqual(props(r1.tail, [1]), props(r2.tail, [1]))).toBe(
      false,
    );
  });

  it("comparator case 3 — registry growth makes EVERY block compare not-equal (all blocks re-resolve their citations)", () => {
    const blocks = ["Alpha [1].", "Beta prose.", "Gamma [2]."];
    for (const text of blocks) {
      expect(blockPropsEqual(props(text, [1]), props(text, [1, 2]))).toBe(
        false,
      );
    }
  });

  it("comparator case 4 — citation upgrade: a marker in an EARLY block before its source registers is not memo-equal once the registry grows", () => {
    // The RSCH-02 contract: "[3]" streamed before source 3 registers renders
    // as plain text and upgrades to a link on a later delta. The upgrade is
    // physically a re-render of an already-completed block — the ONLY thing
    // that forces it through the memo is the registry-version term. A
    // text-only comparator returns true here and freezes the plain text
    // forever (T-04-33).
    const early = "Solid-state cells are near pilot scale [3].";
    const beforeRegistration = props(early, []);
    const afterRegistration = props(early, [3]);
    expect(beforeRegistration.text).toBe(afterRegistration.text); // text alone cannot see it
    expect(blockPropsEqual(beforeRegistration, afterRegistration)).toBe(false);
  });

  it("comparator case 5 — changed block text is not equal (the growing tail always re-parses)", () => {
    expect(blockPropsEqual(props("tail so f", [1]), props("tail so far", [1]))).toBe(
      false,
    );
  });

  it("comparator case 6 — equal size with different membership compares equal: the documented limit, sound ONLY because the registry is append-only", () => {
    // {1} -> {2} at equal size is UNREACHABLE in production: the registry is
    // built by registry.add(n) inside deriveRunSurfaces and never deleted, so
    // membership cannot change without size changing. The comparator leans on
    // that invariant instead of paying a per-render set comparison; this case
    // pins the trade so a future refactor that makes the registry mutable
    // knows exactly which assumption it breaks.
    expect(blockPropsEqual(props("Alpha [1].", [1]), props("Alpha [1].", [2]))).toBe(
      true,
    );
  });

  it("comparator case 7 — streaming growth end-to-end: the COMPLETED list the renderer consumes is strictly append-only and reproduces the document's content", () => {
    // deriveBlockList, not the raw splitter output, is what MarkdownBlocks
    // renders — and the distinction is load-bearing. The raw blocks/tail are
    // NOT append-only under growth: a delta ending exactly on `\n` leaves a
    // transient trailing blank line that "completes" a block (a table header
    // row, say) which the very next delta reabsorbs into the tail. This case
    // originally consumed the raw split and FAILED on exactly that shape —
    // the promotion rule in deriveBlockList (a block is completed only once
    // content exists past its boundary) is the fix, and 1-char growth below
    // hits every knife-edge cut point to prove it.
    const full = [
      "# Findings",
      "",
      "Solid-state cells are near pilot scale [1].",
      "",
      "| Vendor | Status |",
      "| --- | --- |",
      "| A | pilot |",
      "",
      "```bash",
      "npm run build",
      "",
      "npm test",
      "```",
      "",
      "Closing prose with a late [2] citation.",
    ].join("\n");
    let prev: string[] = [];
    for (let end = 1; end <= full.length; end++) {
      const src = full.slice(0, end);
      const { completed, live } = deriveBlockList(src);
      // Strictly append-only: every previously-completed block is
      // byte-identical at the same index — the memo only ever sees stable
      // prefixes, so an index key can never point at changed text.
      expect(completed.length).toBeGreaterThanOrEqual(prev.length);
      for (let i = 0; i < prev.length; i++) {
        expect(completed[i]).toBe(prev[i]);
        expect(blockPropsEqual(props(completed[i], []), props(prev[i], []))).toBe(
          true,
        );
      }
      // Round-trip: completed + live carry the source's content lines
      // unchanged (the 04-03 invariant, now on the rendered sequence).
      const nonBlank = (s: string) =>
        s.split("\n").filter((l) => l.trim() !== "");
      expect(nonBlank([...completed, live].join("\n"))).toEqual(nonBlank(src));
      prev = completed;
    }
    // The full document really did decompose into multiple memoized blocks
    // plus a live one — the O(n) shape, not one giant block.
    const final = deriveBlockList(full);
    expect(final.completed.length).toBeGreaterThan(2);
    expect(final.live).toBe("Closing prose with a late [2] citation.");
    // And the fence never leaked across the completed/live boundary.
    expect(
      final.completed.filter((b) => b.includes("```")),
    ).toEqual(["```bash\nnpm run build\n\nnpm test\n```"]);
  });
});
