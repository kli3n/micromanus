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
  //
  // react-dom is here for the mirror-image reason. lib/pdf/render-html.tsx must
  // import react-dom/server.node behind `/* turbopackIgnore: true */` (react-dom@19
  // maps every ./server* subpath to an EMPTY module under the `react-server`
  // export condition, so a static import fails the BUILD — see the comment there).
  // But an import hidden from the bundler is equally hidden from file tracing, so
  // react-dom never reached /var/task and every render threw
  // ERR_MODULE_NOT_FOUND — swallowed by the route's fail-safe into a
  // "PDF unavailable" degrade, making a permanent failure look transient.
  // `react` and `scheduler` are react-dom/server.node's own runtime requires and
  // are invisible to tracing for the same reason.
  outputFileTracingIncludes: {
    "/api/render-pdf": [
      "./node_modules/@sparticuz/chromium/**",
      "./node_modules/react-dom/**",
      "./node_modules/react/**",
      "./node_modules/scheduler/**",
    ],
  },
};

export default nextConfig;
