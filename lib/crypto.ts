/**
 * lib/crypto.ts — AES-256-GCM encryption for user-supplied API keys (KEY-03).
 *
 * SECURITY CONTRACT (RESEARCH Pitfall 7 / T-2-02):
 *   - `decryptKey` is invoked ONLY inside the agent run handler. This module must
 *     NEVER be imported into a client-reachable ("use client") module.
 *   - The plaintext key and the 32-byte encryption key are NEVER logged, and the
 *     plaintext/ciphertext are NEVER returned in any client-facing response.
 *   - The ciphertext columns (iv, ct, tag) are additionally REVOKE'd from the
 *     authenticated role at the DB layer (migration 0002) — only last4 is readable.
 *
 * The 32-byte key is read LAZILY (per call) from API_KEY_ENC_KEY so that merely
 * importing this module never throws — env.ts returns `undefined` under the Vitest
 * runner, and downstream modules may import types from here without a live key.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedKey {
  iv: string;
  ct: string;
  tag: string;
  last4: string;
}

/** Decode + validate the 32-byte AES key. Throws a clear, key-free error. */
function keyBuffer(): Buffer {
  const raw = process.env.API_KEY_ENC_KEY;
  if (!raw) {
    throw new Error(
      "API_KEY_ENC_KEY is not set — expected a base64-encoded 32-byte key.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `API_KEY_ENC_KEY must decode to exactly 32 bytes (got ${key.length}).`,
    );
  }
  return key;
}

export function encryptKey(plain: string): EncryptedKey {
  const key = keyBuffer();
  const iv = randomBytes(12); // fresh 96-bit IV per call
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    last4: plain.slice(-4),
  };
}

/** RUN HANDLER ONLY — never call from a client-reachable module. */
export function decryptKey(ct: string, iv: string, tag: string): string {
  const key = keyBuffer();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
