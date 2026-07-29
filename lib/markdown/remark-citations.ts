/**
 * remark-citations (RSCH-02 / D-35, D-36 — 03-03 Task 1).
 *
 * Linkifies inline `[n]` citation markers in assistant markdown into
 * `<a class="cite" href="#src-n">` anchors — but ONLY when `n` exists in the
 * registry the client already holds (built from fetch_page done payloads).
 * An unregistered `[n]` stays literal text, so a citation can never be a dead
 * link (UI-SPEC "Citation rendering pipeline", Pitfall 10). A `[3]` streamed
 * before source 3 registers renders as plain text and upgrades to a link on a
 * later delta — both forms occupy the same inline box (no CLS).
 *
 * Zero-dependency by contract (UI-SPEC Registry Safety / Amendment A1): the
 * mdast walk is hand-rolled — `unist-util-visit` is explicitly forbidden.
 *
 * Security (T-3-31): the emitted href is only ever the literal `#src-{n}`
 * built from a parsed integer — no model-controlled URL can enter an anchor
 * from prose through this plugin.
 *
 * Usage: `remarkPlugins={[remarkGfm, remarkCitations(registry)]}` — the
 * factory returns a unified attacher, which returns the tree transformer.
 */

/** Minimal structural mdast node — enough for the walk, no @types/mdast dep. */
interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: MdastNode[];
}

/** Subtrees whose text must never be transformed (UI-SPEC skip list). */
const SKIP_TYPES = new Set(["inlineCode", "code", "link", "linkReference"]);

/** 1–3 digit bracketed marker: [1] … [999]. "[1234]" never matches. */
const MARKER = /\[(\d{1,3})\]/g;

/** The link node emitted for a registered marker n. */
function citeNode(n: number): MdastNode {
  return {
    type: "link",
    url: `#src-${n}`,
    data: {
      hProperties: {
        className: ["cite"],
        "aria-label": `Jump to source ${n}`,
      },
    },
    children: [{ type: "text", value: `[${n}]` }],
  };
}

/**
 * Split one text value on registered markers. Unregistered markers stay part
 * of the surrounding literal text. Returns null when nothing changed.
 */
function splitText(value: string, registry: Set<number>): MdastNode[] | null {
  const out: MdastNode[] = [];
  let literalStart = 0; // start of the pending literal slice
  let changed = false;
  MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER.exec(value)) !== null) {
    const n = Number.parseInt(m[1], 10);
    if (!registry.has(n)) continue; // stays literal — covered by the slice
    const literal = value.slice(literalStart, m.index);
    if (literal.length > 0) out.push({ type: "text", value: literal });
    out.push(citeNode(n));
    literalStart = m.index + m[0].length;
    changed = true;
  }
  if (!changed) return null;
  const tail = value.slice(literalStart);
  if (tail.length > 0) out.push({ type: "text", value: tail });
  return out;
}

/** Recursive walk; skips subtrees rooted at SKIP_TYPES ancestors. */
function walk(node: MdastNode, registry: Set<number>): void {
  const children = node.children;
  if (!children || children.length === 0) return;
  let replaced: MdastNode[] | null = null;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (SKIP_TYPES.has(child.type)) {
      if (replaced) replaced.push(child);
      continue;
    }
    if (child.type === "text" && typeof child.value === "string") {
      const split = splitText(child.value, registry);
      if (split) {
        if (!replaced) replaced = children.slice(0, i);
        replaced.push(...split);
      } else if (replaced) {
        replaced.push(child);
      }
      continue;
    }
    walk(child, registry);
    if (replaced) replaced.push(child);
  }
  if (replaced) node.children = replaced;
}

/**
 * Plugin factory: takes the Set of registered source numbers, returns the
 * unified attacher (what react-markdown invokes), which returns the mdast
 * transformer. Rebuilt per render so markers resolve against the registry the
 * client holds at that moment (UI-SPEC streaming contract).
 */
export function remarkCitations(registry: Set<number>) {
  return function remarkCitationsAttacher() {
    return function transformer(tree: unknown): void {
      if (registry.size === 0) return; // empty registry -> tree unchanged
      if (!tree || typeof tree !== "object") return;
      walk(tree as MdastNode, registry);
    };
  };
}
