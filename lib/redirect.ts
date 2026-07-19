/**
 * Open-redirect guard (ASVS V5). Returns `raw` only when it is a same-site
 * relative path — it must start with a single "/" and not begin a
 * protocol-relative or absolute URL ("//host", "/\host", "https://host").
 * Anything else collapses to "/". Consumed by Plan 04's /auth/callback.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  // Protocol-relative ("//evil.com") or backslash variant ("/\evil.com").
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
