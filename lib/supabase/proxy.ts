import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase session on every matched request (called from the root
 * proxy.ts on the Node runtime). Server Components cannot write cookies, so this
 * proxy is what keeps tokens fresh.
 *
 * Source: supabase.com/docs/guides/auth/server-side/nextjs (current "Proxy" pattern).
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: refresh + revalidate the token server-side with getClaims()
  // (available in @supabase/ssr 0.12.3). Never getSession() for server trust;
  // getUser() is the documented fallback (assumption A6) if getClaims regresses.
  await supabase.auth.getClaims();

  return response;
}
