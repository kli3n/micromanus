/**
 * lib/keys/probe.ts — pure helpers for the 1-token key-test probe (KEY-02 / UX-01).
 *
 * PLAIN module: no next/react/SDK imports, so node-env Vitest imports it directly
 * (and it never transitively loads next/headers or the openai SDK). These helpers
 * are the security choke point for UX-01: a provider failure is mapped to FIXED
 * human-readable copy here, so no raw provider error body / header / key fragment
 * can ever reach the browser (T-02key-02, DEBUGGING-LOG commit 7e4d0e0).
 */

// Fixed copy set. Nothing is interpolated from a provider response.
const COPY_REJECTED = "key rejected — check the value and base URL";
const COPY_RATE_LIMITED =
  "rate limited by the provider — wait a moment and try again";
const COPY_GENERIC = "could not verify this key — try again";

/**
 * Map a numeric HTTP status from the provider to fixed, safe copy.
 *   401/403 -> rejected; 429 -> rate limited; everything else -> generic.
 */
export function probeErrorCopy(status: number): string {
  if (status === 401 || status === 403) return COPY_REJECTED;
  if (status === 429) return COPY_RATE_LIMITED;
  return COPY_GENERIC;
}

/** OQ-1: every provider is testable EXCEPT anthropic (Claude non-runnable now). */
export function isTestableProvider(provider: string): boolean {
  return provider !== "anthropic";
}
