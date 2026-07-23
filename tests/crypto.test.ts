import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A known, valid 32-byte key (32 ASCII chars → 32 bytes) base64-encoded, set
// BEFORE exercising the module. lib/crypto reads the key lazily, so setting it
// here (rather than via a populated .env) is sufficient under the Vitest runner.
const VALID_KEY_B64 = Buffer.from(
  "0123456789abcdef0123456789abcdef",
).toString("base64");

let cryptoMod: typeof import("@/lib/crypto");

beforeEach(async () => {
  process.env.API_KEY_ENC_KEY = VALID_KEY_B64;
  cryptoMod = await import("@/lib/crypto");
});

afterEach(() => {
  process.env.API_KEY_ENC_KEY = VALID_KEY_B64;
});

describe("lib/crypto AES-256-GCM (KEY-03)", () => {
  it("round-trips encrypt → decrypt back to the original plaintext", () => {
    const plain = "sk-test-abcdef0123456789";
    const enc = cryptoMod.encryptKey(plain);
    expect(cryptoMod.decryptKey(enc.ct, enc.iv, enc.tag)).toBe(plain);
  });

  it("sets last4 to the final four plaintext chars", () => {
    const enc = cryptoMod.encryptKey("sk-test-abcdef0123456789");
    expect(enc.last4).toBe("6789");
  });

  it("produces ciphertext that differs from the plaintext", () => {
    const plain = "sk-test-abcdef0123456789";
    const enc = cryptoMod.encryptKey(plain);
    expect(enc.ct).not.toBe(plain);
  });

  it("uses a fresh random IV per call (same plaintext → different ct)", () => {
    const a = cryptoMod.encryptKey("same-plaintext");
    const b = cryptoMod.encryptKey("same-plaintext");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("throws when the auth tag is tampered with", () => {
    const enc = cryptoMod.encryptKey("sk-test-abcdef0123456789");
    const badTag = Buffer.from(enc.tag, "base64");
    badTag[0] = badTag[0] ^ 0xff;
    expect(() =>
      cryptoMod.decryptKey(enc.ct, enc.iv, badTag.toString("base64")),
    ).toThrow();
  });

  it("throws a clear error when the key is missing", () => {
    delete process.env.API_KEY_ENC_KEY;
    expect(() => cryptoMod.encryptKey("x")).toThrow(/API_KEY_ENC_KEY/);
  });

  it("throws a clear error when the key is not 32 bytes", () => {
    process.env.API_KEY_ENC_KEY = Buffer.from("too-short").toString("base64");
    expect(() => cryptoMod.encryptKey("x")).toThrow(/32 bytes/);
  });
});
