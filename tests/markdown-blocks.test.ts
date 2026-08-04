import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "@/components/chat/markdown-blocks";

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
    // The bash fence survives whole; the trailing tilde fence stays in the tail.
    expect(r.blocks.filter((b) => b.startsWith("```bash"))).toHaveLength(1);
    expect(r.blocks.some((b) => b.includes("npm test"))).toBe(true);
    expect(r.tail).toBe("~~~\nunclosed tilde fence at the stream edge");
    // And the invariant itself, stated explicitly here as well as in the helper.
    assertRoundTrip(src, r);
  });
});
