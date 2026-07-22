import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Chromium + puppeteer-core must NOT be bundled by Turbopack/webpack; they are
  // resolved from node_modules at runtime by Plan 04's quarantined /api/render-pdf
  // route. Use the stable top-level key (not experimental.serverComponentsExternalPackages).
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],

  // Vercel's static file tracing doesn't include @sparticuz/chromium's `bin/`
  // (the brotli-packed Chromium is read from disk at runtime, not `require`d), so
  // the deployed function fails with: input directory ".../@sparticuz/chromium/bin"
  // does not exist. Force the whole package (incl. bin/) into the render-pdf
  // function bundle so puppeteer.launch() can find the executable.
  outputFileTracingIncludes: {
    "/api/render-pdf": ["./node_modules/@sparticuz/chromium/**"],
  },
};

export default nextConfig;
