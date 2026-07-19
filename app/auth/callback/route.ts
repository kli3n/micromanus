import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/redirect";

/**
 * OAuth PKCE callback (D-07 / D-08).
 *
 * The provider redirects here with a `code` (and the `next` we set in
 * signInWithOAuth's redirectTo). We exchange the code for a session — the
 * server client writes the httpOnly session cookies via getAll/setAll — then
 * redirect to a *validated* same-site path.
 *
 *  - Missing `code` OR an exchange error -> `/?error=auth_failed`, where the
 *    landing page renders the inline D-07 banner with the OAuth buttons intact.
 *    No dedicated /auth/error route (D-07).
 *  - Success -> the safeNext(next) path (defaults to `/`, which resolves to the
 *    session-guarded shell — D-08).
 *
 * This route only exchanges the session; the authoritative auth check lives in
 * the (app) layout guard (never here). Default Node runtime.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  // Open-redirect guard (ASVS V5): safeNext collapses anything that is not a
  // single-slash same-site relative path down to "/". Never redirect off-site.
  const next = safeNext(url.searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(new URL("/?error=auth_failed", url.origin));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL("/?error=auth_failed", url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
