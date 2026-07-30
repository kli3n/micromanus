export const runtime = "nodejs";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { probeErrorCopy, isTestableProvider } from "@/lib/keys/probe";
import { baseUrlSchema, BASE_URL_REJECTED } from "@/lib/keys/base-url";
import { MODEL_REGISTRY } from "@/lib/registry";

/**
 * POST /api/keys/test — a real server-side 1-token probe of a BYOK key (KEY-02).
 *
 * SECURITY CONTRACT (UX-01 / T-02key-02 / T-02key-05, mirrors render-pdf):
 *   - getClaims() identity gate so anonymous callers cannot burn probes.
 *   - base_url is gated by `baseUrlSchema` (lib/keys/base-url.ts), which runs the
 *     SAME public-http(s) predicate as fetch_page. A bare zod `z.url()` does NOT
 *     do this — it accepts file:, javascript:, and http://169.254.169.254/ — and
 *     this route is the more dangerous of the two, since it dials the named host
 *     immediately and its 401/403-vs-429 reply is a status oracle (review CR-03).
 *   - The provider response body is NEVER returned. On failure we read only the
 *     numeric status, map it through probeErrorCopy(), console.error the detail
 *     server-side ONLY, and return { ok:false, reason } — no sk-… fragment, no
 *     provider headers/body ever cross to the client.
 *   - The openai SDK is lazily import()-ed inside the handler (installed by 02-01).
 *
 * runtime='nodejs' — the SDK + outbound fetch want the Node runtime.
 */

const bodySchema = z.object({
  provider: z.enum(["openai", "kimi", "custom", "anthropic", "openrouter"]),
  base_url: baseUrlSchema,
  apiKey: z.string().min(1),
  model: z.string().min(1).optional(),
});

/** Cheapest selectable model id for a provider (by input price) — the probe default. */
function cheapestModel(provider: string): string | undefined {
  const candidates = MODEL_REGISTRY.filter(
    (m) => m.provider === provider && m.selectable,
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((a, b) => (b.inputPer1M < a.inputPer1M ? b : a)).id;
}

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

/** Best-effort numeric status extraction from an SDK error — status ONLY, never body. */
function statusOf(err: unknown): number {
  if (err && typeof err === "object") {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return 0;
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
      return json({ ok: false, reason: "Invalid request." }, 400);
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      // Say WHY when the base URL itself was refused, so a reviewer probing the
      // SSRF gate sees the gate rather than a generic validation message.
      const rejected = parsed.error.issues.some((i) => i.message === BASE_URL_REJECTED);
      return json(
        { ok: false, reason: rejected ? BASE_URL_REJECTED : "Enter a key and a valid base URL." },
        400,
      );
    }
    const { provider, base_url, apiKey, model } = parsed.data;

    // Seam for future non-probeable providers (OQ-1 resolved — all testable now).
    if (!isTestableProvider(provider)) {
      return json({ ok: false, reason: "This provider cannot be tested yet" });
    }

    // Pick the probe model: explicit request model, else cheapest per provider.
    // custom has no registry entry, so it must supply its own model.
    const probeModel = model ?? cheapestModel(provider);
    if (!probeModel) {
      return json({ ok: false, reason: "Choose a model to test" }, 400);
    }

    // ~10s timeout so a slow/hostile base URL cannot hang the function.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      if (provider === "anthropic") {
        // D-48/CM-3: Claude probes go through the NATIVE Messages API — the
        // openai-compat shim is forbidden for Claude (and the default base URL
        // has no /v1 chat-completions path anyway).
        const AnthropicSDK = (await import("@anthropic-ai/sdk")).default;
        const client = new AnthropicSDK({ apiKey, baseURL: base_url });
        await client.messages.create(
          {
            model: probeModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          },
          { signal: controller.signal },
        );
        return json({ ok: true });
      }
      const OpenAI = (await import("openai")).default;
      const client = new OpenAI({ apiKey, baseURL: base_url });
      await client.chat.completions.create(
        {
          model: probeModel,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        },
        { signal: controller.signal },
      );
      return json({ ok: true });
    } catch (err) {
      // Detail server-side ONLY — never to the client (no sk-…, body, or headers).
      console.error("[api/keys/test] probe failed:", err);
      return json({ ok: false, reason: probeErrorCopy(statusOf(err)) });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error("[api/keys/test] failed:", err);
    return json({ ok: false, reason: probeErrorCopy(0) }, 500);
  }
}
