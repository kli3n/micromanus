/**
 * lib/keys/base-url.ts — the ONE validator for a user-supplied provider base URL.
 *
 * WHY THIS FILE EXISTS (review CR-03): both /api/keys and /api/keys/test used to
 * validate `base_url` with a bare `z.url()`, and the probe route's header claimed
 * "base_url constrained to http(s) by zod url() (SSRF guard)". That claim was
 * false. Verified against this project's pinned zod@4.4.3, `z.url()` ACCEPTS:
 *
 *     http://169.254.169.254/latest/meta-data/     file:///etc/passwd
 *     javascript:alert(1)                          http://localhost:8080/v1
 *
 * These two routes are strictly MORE privileged than fetch_page, because they
 * carry the decrypted BYOK key:
 *   - /api/keys/test dials the named host immediately and maps the outcome
 *     through probeErrorCopy(), which distinguishes 401/403 from 429 from
 *     everything else — a status oracle for scanning internal services.
 *   - /api/keys PERSISTS the value, and the agent run handler dials
 *     `keyRow.base_url` with the decrypted key on EVERY subsequent run. A saved
 *     `http://attacker.tld/v1` turns every run into a key-exfiltration channel.
 *
 * So the gate is the same public-http(s) predicate `fetch_page` uses, imported
 * rather than re-implemented — a second copy is what let CR-02's dead regex sit
 * unnoticed for a phase.
 */
import { z } from "zod";
import { isSafeUrl } from "@/lib/net/safe-url";

/** Copy shown to the user — matches the sentence-case house style of these routes. */
export const BASE_URL_REJECTED =
  "That base URL is not allowed — it must be a public http(s) address.";

/**
 * A provider base URL: parseable, http(s), and not pointed at loopback /
 * link-local / private space or the cloud metadata IP.
 */
export const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((u) => isSafeUrl(u), { message: BASE_URL_REJECTED });

/**
 * Guard for a base URL read back OUT of the database (run handler). Rows saved
 * before this validation existed are untrusted — the same discipline the rest of
 * the phase applies to persisted tool rows (T-3-60).
 */
export function isAllowedBaseUrl(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value.trim().length === 0) return true; // falls back to the provider default
  return isSafeUrl(value.trim());
}
