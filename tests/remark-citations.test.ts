import { describe, expect, it } from "vitest";
import { remarkCitations } from "@/lib/markdown/remark-citations";

/**
 * remark-citations (RSCH-02 client half, 03-03 Task 1 / UI-SPEC "Citation
 * rendering pipeline").
 *
 * Contract pinned here:
 *   - `[n]` in a text node becomes a link node (url "#src-n", className
 *     ["cite"], aria-label "Jump to source n") ONLY when n is in the registry.
 *   - Unregistered markers stay literal text — a citation can never be a dead
 *     link (D-35/D-36, Pitfall 10).
 *   - Markers inside inlineCode / code / link / linkReference subtrees are
 *     never transformed.
 *   - Regex is \[(\d{1,3})\]: 1–3 digits match; "[1234]" never links.
 *   - Empty registry -> tree unchanged.
 *
 * Trees are constructed as plain mdast-shaped objects — no parser dependency
 * (the plugin itself is a hand-rolled zero-dependency walk).
 */

type Node = {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
};

const text = (value: string): Node => ({ type: "text", value });
const para = (...children: Node[]): Node => ({ type: "paragraph", children });
const root = (...children: Node[]): Node => ({ type: "root", children });

/** The exact link node the plugin must emit for a registered marker. */
const cite = (n: number): Node => ({
  type: "link",
  url: `#src-${n}`,
  data: {
    hProperties: {
      className: ["cite"],
      "aria-label": `Jump to source ${n}`,
    },
  },
  children: [{ type: "text", value: `[${n}]` }],
});

/** Run the plugin the way react-markdown does: factory -> attacher -> transformer. */
function transform(tree: Node, registry: Set<number>): Node {
  remarkCitations(registry)()(tree);
  return tree;
}

describe("remarkCitations (RSCH-02 citation linkification)", () => {
  it("splits a text node into text + link nodes for registered markers", () => {
    const tree = root(para(text("see [1] and [2]")));
    transform(tree, new Set([1, 2]));
    expect(tree.children![0].children).toEqual([
      text("see "),
      cite(1),
      text(" and "),
      cite(2),
    ]);
  });

  it("leaves an unregistered marker as literal text (never a dead link)", () => {
    const tree = root(para(text("claim [4] here")));
    transform(tree, new Set([1, 2, 3]));
    expect(tree.children![0].children).toEqual([text("claim [4] here")]);
  });

  it("mixes registered and unregistered markers in one text node", () => {
    const tree = root(para(text("[1] and [9]")));
    transform(tree, new Set([1]));
    expect(tree.children![0].children).toEqual([cite(1), text(" and [9]")]);
  });

  it("never transforms markers inside inlineCode", () => {
    const inlineCode: Node = { type: "inlineCode", value: "arr[1]" };
    const tree = root(para(inlineCode));
    transform(tree, new Set([1]));
    expect(tree.children![0].children).toEqual([
      { type: "inlineCode", value: "arr[1]" },
    ]);
  });

  it("never transforms markers inside code blocks", () => {
    const code: Node = { type: "code", value: "const x = a[1];" };
    const tree = root(code);
    transform(tree, new Set([1]));
    expect(tree.children).toEqual([{ type: "code", value: "const x = a[1];" }]);
  });

  it("never transforms markers inside link subtrees", () => {
    const link: Node = {
      type: "link",
      url: "https://example.com",
      children: [text("release [1] notes")],
    };
    const tree = root(para(link));
    transform(tree, new Set([1]));
    expect(tree.children![0].children![0].children).toEqual([
      text("release [1] notes"),
    ]);
  });

  it("never transforms markers inside linkReference subtrees", () => {
    const ref: Node = {
      type: "linkReference",
      identifier: "x",
      children: [text("[1]")],
    };
    const tree = root(para(ref));
    transform(tree, new Set([1]));
    expect(tree.children![0].children![0].children).toEqual([text("[1]")]);
  });

  it("DOES transform inside non-skip containers (emphasis, strong, list items)", () => {
    const tree = root(para({ type: "emphasis", children: [text("see [2]")] }));
    transform(tree, new Set([2]));
    expect(tree.children![0].children![0].children).toEqual([
      text("see "),
      cite(2),
    ]);
  });

  it("matches two- and three-digit markers", () => {
    const tree = root(para(text("a [12] b [123] c")));
    transform(tree, new Set([12, 123]));
    expect(tree.children![0].children).toEqual([
      text("a "),
      cite(12),
      text(" b "),
      cite(123),
      text(" c"),
    ]);
  });

  it("never links [1234] (four digits — outside \\[(\\d{1,3})\\])", () => {
    const tree = root(para(text("see [1234]")));
    transform(tree, new Set([1234]));
    expect(tree.children![0].children).toEqual([text("see [1234]")]);
  });

  it("leaves [0] literal when 0 is not registered", () => {
    const tree = root(para(text("index [0]")));
    transform(tree, new Set([1]));
    expect(tree.children![0].children).toEqual([text("index [0]")]);
  });

  it("empty registry -> tree unchanged (deep-equal, including node identity of structure)", () => {
    const tree = root(para(text("see [1] and [2]")), {
      type: "code",
      value: "[3]",
    });
    const before = JSON.parse(JSON.stringify(tree));
    transform(tree, new Set());
    expect(tree).toEqual(before);
  });

  it("a marker with no surrounding text becomes a lone link node", () => {
    const tree = root(para(text("[3]")));
    transform(tree, new Set([3]));
    expect(tree.children![0].children).toEqual([cite(3)]);
  });
});
