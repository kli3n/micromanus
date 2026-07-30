/**
 * lib/pdf/render-html.tsx — markdown → safe print HTML for the PDF route.
 *
 * QUARANTINE (D-12/D-40): this module is imported ONLY by
 * app/api/render-pdf/route.ts. Nothing else — especially not the agent route —
 * may import it; the agent reaches rendering by internal HTTP only, so
 * Chromium never enters any other bundle.
 *
 * SANITIZATION CONTRACT (T-3-01, CM-9): markdown becomes HTML exclusively via
 * renderToStaticMarkup over react-markdown + remark-gfm — the SAME component +
 * plugin set as the chat view, so the PDF can never render a dialect the chat
 * would not. Raw HTML in the source is ESCAPED, never parsed (no rehype-raw,
 * no dangerouslySetInnerHTML anywhere in this path). Image nodes render
 * nothing (components.img → null), which deletes Chromium's entire
 * subresource-fetch/SSRF surface (T-3-51): with all CSS inlined below, the
 * rendered document performs zero network fetches.
 *
 * The wrapper template is the only place raw HTML strings exist; every
 * interpolation (title, bibliography titles/URLs) goes through esc(), and a
 * bibliography href is emitted ONLY for http:/https: URLs (a javascript: URL
 * renders as inert text). Styling is minimal by decision D-41 — no title
 * page, no branding (a branded template is deferred to Phase 5).
 */
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
// WR-08: the render-boundary scheme allow-list now lives in ONE zero-import
// module, imported here and by the chat's Sources list, so the PDF bibliography
// and the chat can never disagree about what may become a clickable href. It is
// deliberately NOT lib/net/safe-url.ts (the SSRF gate) — see that module's header.
import { isSafeHref } from "@/lib/net/safe-href";

// react-dom's server entries are all gated behind the `react-server` export
// condition (react-dom@19 maps every ./server* subpath to an EMPTY
// server.react-server.js under it), and Turbopack applies that condition to
// the whole app-route layer — so a static import resolves to a module with no
// exports and the build fails. `turbopackIgnore` keeps this ONE import as a
// runtime dynamic import: Node then resolves it with plain node conditions →
// the real server.node.js. This route is nodejs-only (CM-7), the specifier is
// a literal (Vercel's file tracing still follows it), and Vitest resolves it
// natively — module-level await keeps both exported functions synchronous.
const { renderToStaticMarkup } = (await import(
  /* turbopackIgnore: true */ "react-dom/server.node"
)) as typeof import("react-dom/server.node");
export interface ReportSource {
  n: number;
  title: string;
  url: string;
}

/** Escape every character that could open markup inside the fixed template. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal print stylesheet (D-41). Inlined so the document fetches nothing. */
export const PRINT_CSS = `
@page { margin: 18mm; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.55;
  color: #1a1a1a;
}
h1, h2, h3, h4 { line-height: 1.25; }
table { border-collapse: collapse; width: 100%; margin: 0.75em 0; }
th, td { border: 1px solid #999; padding: 4pt 6pt; text-align: left; }
pre, code {
  background: #f4f2ee;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 9.5pt;
}
pre { padding: 8pt; overflow-wrap: break-word; white-space: pre-wrap; }
a { color: inherit; text-decoration: underline; }
img { max-width: 100%; }
blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 12pt; color: #444; }
.bibliography { margin-top: 2em; border-top: 1px solid #999; padding-top: 1em; }
.bibliography ol { list-style: none; padding-left: 0; }
.bibliography li { margin: 0.35em 0; overflow-wrap: anywhere; }
`;

/**
 * Render the report body markdown to HTML through the sanitizing pipeline.
 * Raw HTML arrives as escaped text; image markdown renders nothing.
 */
export function markdownToBodyHtml(markdown: string): string {
  return renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm]} components={{ img: () => null }}>
      {markdown}
    </Markdown>,
  );
}

/**
 * Distinct [n] citation markers present in a markdown body, ascending.
 * Used by tests (and available to callers) to assert the D-42 subset
 * property: every body marker whose n exists in the source registry has a
 * bibliography entry.
 */
export function citationMarkers(markdown: string): number[] {
  const seen = new Set<number>();
  for (const m of markdown.matchAll(/\[(\d+)\]/g)) {
    seen.add(Number.parseInt(m[1], 10));
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * Numbered bibliography (D-42): "[n] title — url", where the URL is always
 * visible as text (a printed link must be readable on paper) and becomes an
 * anchor only when its scheme is http:/https:. Every field is escaped.
 */
function bibliographyHtml(sources: ReportSource[]): string {
  if (sources.length === 0) return "";
  const items = sources
    .map((s) => {
      const urlText = esc(s.url);
      const link = isSafeHref(s.url)
        ? `<a href="${esc(s.url)}">${urlText}</a>`
        : urlText;
      return `<li>[${Math.trunc(s.n)}] ${esc(s.title)} &mdash; ${link}</li>`;
    })
    .join("\n");
  return `<section class="bibliography"><h2>Sources</h2><ol>\n${items}\n</ol></section>`;
}

/**
 * The fixed wrapper document. `bodyHtml` is trusted because ONLY
 * markdownToBodyHtml produces it; everything else is escaped here.
 */
export function buildReportHtml(opts: {
  title: string;
  bodyHtml: string;
  sources?: ReportSource[];
}): string {
  const title = esc(opts.title);
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${title}</title><style>${PRINT_CSS}</style></head>` +
    `<body><h1>${title}</h1>${opts.bodyHtml}${bibliographyHtml(opts.sources ?? [])}</body></html>`
  );
}
