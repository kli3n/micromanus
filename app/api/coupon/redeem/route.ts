export const runtime = "nodejs";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/coupon/redeem (PAY-02/PAY-03) — the only server entry point for
 * coupon redemption. It is a thin wrapper over the `redeem_coupon(p_code)`
 * SECURITY DEFINER RPC shipped by 02-01 / migration 0001: the money mutation
 * (an append-only `credits_ledger` row) and the "one coupon per account"
 * uniqueness are enforced entirely in Postgres. This route NEVER does an
 * app-level check-then-insert (T-02-01) and NEVER leaks raw PG error detail to
 * the client — the full error is logged server-side only (T-02-02, repo lesson
 * commit 7e4d0e0).
 *
 * Body: `{ code: string }` (validated with zod, trimmed, 1..64 chars — T-02-06).
 * Returns status 200 for every domain outcome:
 *   { ok: true, credits: number }                         — grant succeeded
 *   { ok: false, error: 'empty' | 'unknown' }             — this task (Task 1)
 * Task 2 refines the error branch to map the RPC SQLSTATE to the specific
 * 'invalid' / 'already_redeemed' / 'auth' outcomes.
 */
const bodySchema = z.object({ code: z.string().trim().min(1).max(64) });

export async function POST(req: Request) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    const json = await req.json();
    const result = bodySchema.safeParse(json);
    if (!result.success) {
      return Response.json({ ok: false, error: "empty" });
    }
    parsed = result.data;
  } catch {
    // Malformed / non-JSON body — treat as an empty submission.
    return Response.json({ ok: false, error: "empty" });
  }

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("redeem_coupon", {
      p_code: parsed.code,
    });

    if (error) {
      // Log the full error server-side only; never return PG detail (T-02-02).
      console.error("[coupon/redeem] failed:", error);
      return Response.json({ ok: false, error: "unknown" });
    }

    return Response.json({ ok: true, credits: data });
  } catch (err) {
    console.error("[coupon/redeem] failed:", err);
    return Response.json({ ok: false, error: "unknown" });
  }
}
