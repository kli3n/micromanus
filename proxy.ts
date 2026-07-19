import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next 16 renamed the `middleware.ts` file convention to `proxy.ts` and the
// exported function from `middleware` to `proxy` (Node runtime). A middleware.ts
// file here would silently stop refreshing the session → AUTH-03 breaks.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  // Run on all paths except static assets and the image optimizer; the landing
  // page still passes through (it just has no session to refresh).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
