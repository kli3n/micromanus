import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Chromium + puppeteer-core must NOT be bundled by Turbopack/webpack; they are
  // resolved from node_modules at runtime by Plan 04's quarantined /api/render-pdf
  // route. Use the stable top-level key (not experimental.serverComponentsExternalPackages).
  serverExternalPackages: ["@sparticuz/chromium", "puppeteer-core"],
};

export default nextConfig;
