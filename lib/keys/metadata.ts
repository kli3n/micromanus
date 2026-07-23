/**
 * lib/keys/metadata.ts — the single client-safe projection for BYOK key rows
 * (KEY-03 / T-02key-01).
 *
 * This is a PLAIN module: no next/react/SDK imports, so node-env Vitest can
 * import it directly (and so it can never transitively load next/headers). It is
 * the one choke point every /api/keys response passes through — mirroring the
 * render-pdf "never leak internals" discipline. The ciphertext columns (iv, ct,
 * tag) and any plaintext key are structurally dropped here; only the metadata a
 * client is allowed to see survives.
 */

export interface KeyMetadata {
  provider: string;
  base_url: string | null;
  last4: string;
}

/**
 * A stored user_api_keys row may carry ciphertext fields (iv/ct/tag) and must
 * never carry a plaintext key in a response — this projection keeps ONLY the
 * three metadata fields, discarding everything else by construction.
 */
export function toKeyMetadata(row: {
  provider: string;
  base_url?: string | null;
  last4: string;
  [k: string]: unknown;
}): KeyMetadata {
  return {
    provider: row.provider,
    base_url: row.base_url ?? null,
    last4: row.last4,
  };
}
