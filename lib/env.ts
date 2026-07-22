import { z } from "zod";

/**
 * Environment schema (fail-fast at boot).
 *
 * Only the two NEXT_PUBLIC_* Supabase vars are required — they are safe in the
 * browser because RLS enforces access. The service-role and encryption keys are
 * optional, server-only strings reserved for Phase 2; they must NEVER carry a
 * NEXT_PUBLIC_ prefix and must never be imported into client-reachable modules.
 */
const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  ENCRYPTION_KEY: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Pure validation helper. Accepts an explicit source so unit tests can exercise
 * both the fail-fast and happy paths without destructively mutating process.env.
 * Throws a ZodError when a required public var is missing or malformed.
 */
export function parseEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  return envSchema.parse({
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY,
    ENCRYPTION_KEY: source.ENCRYPTION_KEY,
  });
}

/**
 * Parsed env, evaluated at module load so a missing public var throws at boot
 * (fail-fast). Skipped only under the Vitest runner (process.env.VITEST) so unit
 * tests can import parseEnv() without a populated .env — the eager fail-fast is
 * what the app itself relies on at startup.
 */
export const env: Env = process.env.VITEST
  ? (undefined as unknown as Env)
  : parseEnv({
      // Access each var as a LITERAL `process.env.X` so Next.js inlines the
      // NEXT_PUBLIC_* values into the CLIENT bundle at build time. Passing bare
      // `process.env` (or reading it indirectly via a `source[key]` variable) is
      // NOT statically replaced by the bundler, so those keys are `undefined` in
      // the browser — which is what threw the client-side ZodError. Non-public
      // vars are never inlined client-side (resolve to undefined) and are optional.
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    });
