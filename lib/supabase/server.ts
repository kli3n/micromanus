import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/**
 * Request-scoped server Supabase client for Server Components, route handlers,
 * and server actions. Reads/writes the session through the httpOnly cookie jar
 * using the getAll/setAll contract (the get/set/remove trio is deprecated).
 *
 * NOTE: SUPABASE_SERVICE_ROLE_KEY is reserved for Phase 2 and is intentionally
 * NOT wired here. A service-role client bypasses RLS and must live only in the
 * agent run handler / Stripe webhook — never in any client-reachable module.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component, which cannot set cookies. This is
            // safe to ignore when session refresh runs in proxy.ts (it does).
          }
        },
      },
    },
  );
}
