import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Sign-out (AUTH-04). A POST-only route so it is invoked by the header sign-out
 * form present on every authenticated page (D-03). signOut() clears the session
 * cookie server-side, then we 303-redirect to the landing page (303 forces the
 * follow-up navigation to be a GET after the POST). Default Node runtime.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}
