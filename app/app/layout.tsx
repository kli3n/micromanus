import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/AppShell";

// Group-level title for every authenticated page: "Workspace · MicroManus"
// (EC-09). Deliberately NOT a per-chat generateMetadata — deriving the title
// from the chat row would add a server read to every chat navigation for a
// cosmetic finding, and the group title already satisfies it.
export const metadata: Metadata = { title: "Workspace" };

/**
 * Authoritative server-side route guard for the entire (app) group (AUTH-03).
 *
 * This is the REAL enforcement boundary — the proxy only keeps tokens fresh and
 * could be bypassed by a matcher gap, but this layout is inside the render path
 * and cannot be skipped for any page in the group. We use getClaims() (never
 * getSession()) for server-side trust, falling back to getUser() if the running
 * @supabase/ssr build does not expose it (research A6). No valid user -> redirect
 * to the landing page.
 *
 * On success we perform the walking skeleton's real RLS-scoped DB read: the
 * caller's OWN profiles.display_name (RLS `user_id = auth.uid()` filters to their
 * single row), falling back to the email claim when display_name is null, and
 * render the shell around {children}.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  // getClaims() verifies the JWT locally (current Supabase server-trust
  // recommendation). Fall back to getUser() if unavailable in this ssr version.
  let userId: string | undefined;
  let emailClaim: string | undefined;

  const supabaseAuth = supabase.auth as typeof supabase.auth & {
    getClaims?: () => Promise<{
      data: { claims?: { sub?: string; email?: string } } | null;
    }>;
  };

  if (typeof supabaseAuth.getClaims === "function") {
    const { data } = await supabaseAuth.getClaims();
    userId = data?.claims?.sub;
    emailClaim = data?.claims?.email;
  } else {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id;
    emailClaim = data.user?.email;
  }

  if (!userId) redirect('/');

  // Real RLS-scoped read of the caller's own profile row.
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("user_id", userId)
    .maybeSingle();

  const email = emailClaim ?? "";
  const displayName = profile?.display_name ?? email ?? "You";

  return (
    <AppShell displayName={displayName} email={email}>
      {children}
    </AppShell>
  );
}
