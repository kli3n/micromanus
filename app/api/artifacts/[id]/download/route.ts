import { z } from "zod";

export const runtime = "nodejs"; // CM-7 — never edge

/**
 * GET /api/artifacts/[id]/download — per-click signed URL minting (D-39).
 *
 * Contract (03-05 interface, consumed by the 03-06 card):
 *   401 no session
 *   404 not found OR not owner (never 403 — do not confirm existence)
 *   409 {error:'not_ready'} unless status === 'succeeded'
 *   200 {url} — a fresh ~60-second signed URL, minted per click
 *
 * AUTHORIZATION: the service-role client bypasses RLS, so the
 * `.eq("user_id", userId)` predicate IS the authorization (T-3-03) — the
 * same double-predicate pattern as the agent route's chat read. The signed
 * URL is never persisted (signed URLs are signed with a separate key and
 * survive sign-out); the short TTL + this ownership check are the only
 * revocation that exists (T-3-50).
 */

const idSchema = z.string().uuid();

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Lazy imports — module loads cleanly under Vitest (house discipline).
  const [{ createClient }, { createServiceClient }] = await Promise.all([
    import("@/lib/supabase/server"),
    import("@/lib/supabase/service"),
  ]);

  // Canonical auth idiom (getClaims with getUser fallback) — 401 without.
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
  if (!userId) return json(401, { error: "unauthenticated" });

  // A non-uuid id can never match a row — same 404 as "not found / not owner".
  const { id } = await ctx.params;
  if (!idSchema.safeParse(id).success) return json(404, { error: "not_found" });

  const svc = createServiceClient();
  const { data: artifact, error } = await svc
    .from("artifacts")
    .select("id, storage_path, status, title")
    .eq("id", id)
    .eq("user_id", userId) // service role bypasses RLS — this IS the authorization
    .maybeSingle();
  if (error) {
    console.error("[artifact] download read failed:", error);
    return json(500, { error: "server_error" });
  }
  if (!artifact) return json(404, { error: "not_found" }); // never 403

  if (artifact.status !== "succeeded" || !artifact.storage_path) {
    return json(409, { error: "not_ready" });
  }

  const { data: signed, error: signErr } = await svc.storage
    .from("reports")
    .createSignedUrl(artifact.storage_path as string, 60); // seconds — D-39
  if (signErr || !signed?.signedUrl) {
    console.error("[artifact] createSignedUrl failed:", signErr);
    return json(500, { error: "server_error" });
  }

  return json(200, { url: signed.signedUrl });
}
