import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Unit tests live under both lib/** (Phase 1 analog) and tests/** (Phase 2
    // registry/adapter/pricing/crypto suites land here).
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Vitest does not read tsconfig `paths` by default; mirror the `@/*` → repo
      // root mapping so tests can import via `@/lib/...`.
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
});
