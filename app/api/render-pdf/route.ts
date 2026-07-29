import { z } from "zod";
import { buildReportHtml, markdownToBodyHtml } from "@/lib/pdf/render-html";

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Quarantined serverless Chromium PDF route (D-12 / success criterion 5).
 *
 * QUARANTINE CONTRACT: this is the ONLY file in the app that may import
 * @sparticuz/chromium or puppeteer-core (and the only importer of
 * lib/pdf/render-html). Both packages are lazily dynamic-imported INSIDE the
 * handler so Chromium's ~50MB binary never loads for any other route, and
 * they are listed in next.config.ts `serverExternalPackages` so the bundler
 * resolves them at runtime instead of trying to bundle the binary. A render
 * crash here must never touch another route (decision ⑨).
 *
 * CONTRACT (D-40, Phase 3): authenticated session required (401 without),
 * zod-validated { title, markdown, sources? } body (400 on failure), markdown
 * rendered ONLY through the sanitizing renderer in lib/pdf/render-html —
 * neither the client nor the model ever supplies raw HTML to Chromium.
 *
 * chromium@149 is ESM-only and async: `chromium.executablePath()` returns a
 * Promise (awaited below); use the `chromium.args` getter rather than calling
 * the now-Promise-returning `defaultArgs()`.
 *
 * FAIL-SAFE: the render body is wrapped so Chromium can never throw out of
 * the route — on any render error we return 200 JSON
 * `{ error: 'pdf_unavailable' }` (the documented degrade path the caller
 * branches on by CONTENT-TYPE, never res.ok) and close the browser in
 * `finally`.
 *
 * FALLBACK LADDER (01-RESEARCH.md "Serverless Chromium PDF"), if the deployed
 * smoke test fails on Vercel:
 *   1. switch to `@sparticuz/chromium-min` + host the brotli pack
 *      (`chromium-v149.0.0-pack.tar`) on Supabase Storage and pass its URL to
 *      `chromium.executablePath('https://.../chromium-v149-pack.tar')` — fixes
 *      the >50MB / 250MB-uncompressed function-size failure;
 *   2. if it still fails, ship the markdown-in-chat fallback permanently and
 *      consider react-pdf for a lower-fidelity artifact.
 */

/** POST body (D-40). Bounds mirror the plan's locked interface. */
export const renderPdfBody = z.object({
  title: z.string().min(1).max(200),
  markdown: z.string().min(1).max(200_000),
  sources: z
    .array(
      z.object({
        n: z.number().int().min(1),
        title: z.string().max(300),
        url: z.string().max(2000),
      }),
    )
    .max(50)
    .optional(),
});

export async function POST(req: Request): Promise<Response> {
  // (a) Session required (T-3-02) — canonical auth idiom, before ANY body work.
  // Lazily imported so this module loads cleanly under Vitest (env.ts returns
  // undefined under the runner; mirrors the agent route's discipline).
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{
      data: { claims?: { sub?: string } } | null;
    }>;
  };
  let userId: string | undefined;
  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    userId = data?.claims?.sub;
  } else {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
  }
  if (!userId) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // (b) Validate the body — zod at the boundary; shape failure is a 400, never
  // the degrade (the degrade contract is reserved for real render failures).
  let body: z.infer<typeof renderPdfBody>;
  try {
    body = renderPdfBody.parse(await req.json());
  } catch {
    return new Response(JSON.stringify({ error: "bad_request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // (c) Sanitizing render OUTSIDE Chromium: markdown → escaped HTML →
  // fixed hand-escaped template with the [n] bibliography (D-41/D-42).
  const html = buildReportHtml({
    title: body.title,
    bodyHtml: markdownToBodyHtml(body.markdown),
    sources: body.sources,
  });

  let browser: Awaited<
    ReturnType<
      (typeof import("puppeteer-core"))["default"]["launch"]
    >
  > | null = null;

  try {
    // Lazy dynamic ESM import — Chromium never loads for any other route.
    const chromium = (await import("@sparticuz/chromium")).default;
    const puppeteer = (await import("puppeteer-core")).default;

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(), // Promise in v149
      headless: true,
      // NOTE: chromium@149's build no longer exports `defaultViewport`; let
      // puppeteer use its default viewport (irrelevant for a page.pdf() render).
    });

    const page = await browser.newPage();
    await page.setContent(
      html,
      // The rendered document pulls no network resources (all CSS inlined,
      // images stripped by the renderer), so "load" is the right (and, in
      // puppeteer-core 25, the only valid) wait condition here.
      { waitUntil: "load" },
    );
    const pdf = await page.pdf({ format: "a4", printBackground: true });

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="report.pdf"',
      },
    });
  } catch (err) {
    // Degrade instead of throwing (decision ⑨). 200 so the caller reads the
    // JSON body cleanly; the settle pipeline (lib/artifacts/db.ts) branches on
    // content-type and lands on the degraded card. The failure is logged
    // server-side only (Vercel runtime logs) — never leaked to the client.
    console.error("[render-pdf] render failed:", err);
    return new Response(JSON.stringify({ error: "pdf_unavailable" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    if (browser) await browser.close();
  }
}
