import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";

/**
 * Browser (client-component) Supabase client. Uses the anon/publishable key,
 * which is safe to ship to the browser because RLS enforces per-user access.
 * Accessing `env` here triggers the fail-fast env parse at client boot.
 */
export function createClient() {
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
