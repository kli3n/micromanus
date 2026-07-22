export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Quarantined serverless Chromium PDF route (D-12 / success criterion 5).
 *
 * QUARANTINE CONTRACT: this is the ONLY file in the app that may import
 * @sparticuz/chromium or puppeteer-core. Both packages are lazily dynamic-
 * imported INSIDE the handler so Chromium's ~50MB binary never loads for any
 * other route, and they are listed in next.config.ts `serverExternalPackages`
 * so the bundler resolves them at runtime instead of trying to bundle the
 * binary. A render crash here must never touch another route (decision ⑨).
 *
 * chromium@149 is ESM-only and async: `chromium.executablePath()` returns a
 * Promise (awaited below); use the `chromium.args` getter rather than calling
 * the now-Promise-returning `defaultArgs()`.
 *
 * FAIL-SAFE: the whole body is wrapped so Chromium can never throw out of the
 * route — on any error we return 200 JSON `{ error: 'pdf_unavailable' }` (the
 * documented degrade path the client renders as an inline note) and close the
 * browser in `finally`.
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
export async function POST() {
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
      "<h1>MicroManus PDF smoke test</h1><p>Chromium renders on Vercel.</p>",
      // Static hello-world markup pulls no network resources, so "load" is the
      // right (and, in puppeteer-core 25, the only valid) wait condition here.
      { waitUntil: "load" },
    );
    const pdf = await page.pdf({ format: "a4", printBackground: true });

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="smoke.pdf"',
      },
    });
  } catch (err) {
    // Degrade instead of throwing (decision ⑨). 200 so the client reads the
    // JSON body cleanly and shows "PDF unavailable — try again". The failure is
    // logged server-side only (Vercel runtime logs) — never leaked to the client.
    console.error("[render-pdf] render failed:", err);
    return new Response(JSON.stringify({ error: "pdf_unavailable" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    if (browser) await browser.close();
  }
}
