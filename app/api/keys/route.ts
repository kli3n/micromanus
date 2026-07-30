export const runtime = "nodejs";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { encryptKey } from "@/lib/crypto";
import { toKeyMetadata } from "@/lib/keys/metadata";
import { baseUrlSchema, BASE_URL_REJECTED } from "@/lib/keys/base-url";

/**
 * /api/keys — save (POST) + list (GET) BYOK provider keys.
 *
 * SECURITY CONTRACT (KEY-03 / T-02key-01..04, mirrors render-pdf's never-leak
 * discipline, DEBUGGING-LOG commit 7e4d0e0):
 *   - Identity is ALWAYS derived from getClaims() (JWT sub) — NEVER from the
 *     request body. 401 when absent (T-02key-04).
 *   - Every success response is routed through `toKeyMetadata()`, so iv/ct/tag
 *     and the plaintext key can never appear in a client payload (T-02key-01).
 *   - On any failure we console.error server-side ONLY and return fixed safe
 *     copy — never the DB/error detail.
 *   - Writes go through the service-role client (bypasses RLS) attributed to the
 *     verified userId; reads go through the RLS-scoped anon server client.
 *   - base_url is gated by `baseUrlSchema` (the shared public-http(s) predicate)
 *     BEFORE it is persisted. This is the more consequential of the two key
 *     routes: whatever is stored here is dialled with the DECRYPTED key on every
 *     subsequent agent run, so an unvalidated value is a persistent SSRF and a
 *     standing key-exfiltration channel (review CR-03).
 *
 * runtime='nodejs' — node:crypto (AES-256-GCM) needs the Node runtime.
 */

// Providers accepted by the save endpoint. Anthropic is rejected below (OQ-1)
// but is included in the enum so we return the designed "arrives soon" copy
// rather than a generic validation error.
const bodySchema = z.object({
  provider: z.enum(["openai", "kimi", "custom", "anthropic", "openrouter"]),
  base_url: baseUrlSchema,
  apiKey: z.string().min(1),
});

/** getClaims()->sub with getUser() fallback, exactly as the (app) layout guard. */
async function resolveUserId(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<string | undefined> {
  const auth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{ data: { claims?: { sub?: string } } | null }>;
  };
  if (typeof auth.getClaims === "function") {
    const { data } = await auth.getClaims();
    return data?.claims?.sub;
  }
  const { data } = await supabase.auth.getUser();
  return data.user?.id;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const supabase = await createClient();
    const userId = await resolveUserId(supabase);
    if (!userId) return json({ error: "Not signed in." }, 401);

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return json({ error: "Invalid request." }, 400);
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      const rejected = parsed.error.issues.some((i) => i.message === BASE_URL_REJECTED);
      return json(
        { error: rejected ? BASE_URL_REJECTED : "Enter a provider, base URL, and key." },
        400,
      );
    }
    const { provider, base_url, apiKey } = parsed.data;

    // OQ-1 RESOLVED (Phase 3 / D-48): anthropic keys are saveable — Claude runs
    // through the native adapter (lib/agent/models/anthropic.ts).

    // Encrypt with the AES-256-GCM helper (env key read lazily inside).
    const { iv, ct, tag, last4 } = encryptKey(apiKey);

    // Service-role upsert attributed to the VERIFIED userId. ON CONFLICT
    // (user_id, provider) replaces the existing key (D-23) — the unique index is
    // schema-enforced in the 0002 migration; no app-level check-then-insert.
    const service = createServiceClient();
    const { error } = await service
      .from("user_api_keys")
      .upsert(
        { user_id: userId, provider, base_url, iv, ct, tag, last4 },
        { onConflict: "user_id,provider" },
      );

    if (error) {
      console.error("[api/keys] upsert failed:", error);
      return json({ error: "Could not save your key. Try again." }, 500);
    }

    // Return ONLY the client-safe projection — never ciphertext/plaintext.
    return json(toKeyMetadata({ provider, base_url, last4 }));
  } catch (err) {
    console.error("[api/keys POST] failed:", err);
    return json({ error: "Could not save your key. Try again." }, 500);
  }
}

export async function GET(): Promise<Response> {
  try {
    const supabase = await createClient();
    const userId = await resolveUserId(supabase);
    if (!userId) return json({ error: "Not signed in." }, 401);

    // RLS-scoped read via the anon server client. The explicit column list is
    // defense in depth — iv/ct/tag are additionally REVOKE'd from `authenticated`
    // (0002 migration), so even a widened select could not surface ciphertext.
    const { data, error } = await supabase
      .from("user_api_keys")
      .select("provider, base_url, last4")
      .eq("user_id", userId);

    if (error) {
      console.error("[api/keys] list failed:", error);
      return json({ error: "Could not load your keys." }, 500);
    }

    return json((data ?? []).map(toKeyMetadata));
  } catch (err) {
    console.error("[api/keys GET] failed:", err);
    return json({ error: "Could not load your keys." }, 500);
  }
}
