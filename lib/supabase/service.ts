/**
 * lib/supabase/service.ts — service-role Supabase client (RUN HANDLER / WEBHOOK ONLY).
 *
 * SECURITY CONTRACT (T-2-06):
 *   - This client uses SUPABASE_SERVICE_ROLE_KEY and BYPASSES RLS. It must live
 *     ONLY in the agent run handler and the Stripe webhook — it must NEVER be
 *     imported into any client-reachable ("use client") module.
 *   - The service-role key is server-only (no NEXT_PUBLIC_ prefix); persistSession
 *     is disabled so no session state leaks into a shared/serverless context.
 *
 * Mirrors the reservation note in lib/supabase/server.ts, which deliberately does
 * NOT wire the service-role key.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export function createServiceClient(): SupabaseClient {
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — required for the service-role client.",
    );
  }
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
