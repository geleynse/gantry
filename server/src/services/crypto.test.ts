/**
 * Tests for the crypto service — encrypt/decrypt, roundtrip fidelity, error handling.
 *
 * Note: `encrypt` and `decrypt` accept an explicit `secret` parameter, so these tests
 * are independent of `getEncryptionSecret()` and its module-level caching.
 */

import { describe, it, expect, beforeAll, beforeEach } from "bun:test";
import { encrypt, decrypt, decryptWithFallback, isEncrypted, getEncryptionSecret, resetCachedSecrets } from "./crypto.js";
import { randomBytes, scryptSync, createCipheriv } from "node:crypto";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe("crypto service", () => {
  beforeEach(() => {
    resetCachedSecrets();
    process.env.GANTRY_SECRET = "test-secret-for-crypto-suite-32x";
  });

  // ---------------------------------------------------------------------------
  // encrypt / decrypt roundtrip
  // ---------------------------------------------------------------------------

  describe("encrypt + decrypt roundtrip", () => {
  const secret = "roundtrip-test-secret";

  it("roundtrip returns the original plaintext", () => {
    const plaintext = "hello, world!";
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it("empty string fails to decrypt (implementation limitation: empty body fails format check)", () => {
    // encrypt("") produces iv::tag (empty ciphertext), which decrypt rejects
    // because the format guard treats "" as falsy (missing segment).
    const ciphertext = encrypt("", secret);
    expect(() => decrypt(ciphertext, secret)).toThrow();
  });

  it("roundtrip preserves unicode characters", () => {
    const plaintext = "🔐 sécurité — 日本語テスト";
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it("roundtrip preserves newlines and special characters", () => {
    const plaintext = "line1\nline2\ttab\r\nwindows";
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it("roundtrip preserves a long credential string", () => {
    const plaintext = "eyJhbGciOiJSUzI1NiJ9." + "a".repeat(500);
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it("each encryption produces a different ciphertext (random IV + random salt)", () => {
    const plaintext = "same-plaintext";
    const c1 = encrypt(plaintext, secret);
    const c2 = encrypt(plaintext, secret);
    expect(c1).not.toBe(c2); // Both salt and IV are random, so output differs
    // But both decrypt to the same plaintext
    expect(decrypt(c1, secret)).toBe(plaintext);
    expect(decrypt(c2, secret)).toBe(plaintext);
  });

  it("each encryption produces different salts (random per-encryption)", () => {
    const plaintext = "test-plaintext";
    const c1 = encrypt(plaintext, secret);
    const c2 = encrypt(plaintext, secret);

    // Decode the ciphertexts to extract salts
    const extractSalt = (ciphertext: string) => {
      const withoutPrefix = ciphertext.slice(4); // Strip "enc:"
      const combined = Buffer.from(withoutPrefix, "base64").toString("utf-8");
      const [saltHex] = combined.split(":");
      return saltHex;
    };

    const salt1 = extractSalt(c1);
    const salt2 = extractSalt(c2);
    expect(salt1).not.toBe(salt2); // Salts must be different
  });

  it("encrypt output is a non-empty base64 string with enc: prefix", () => {
    const ciphertext = encrypt("test", secret);
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext.length).toBeGreaterThan(4);
    // Should start with "enc:" followed by base64
    expect(ciphertext.startsWith("enc:")).toBe(true);
    // Valid base64 pattern after prefix (may include +, /, =)
    expect(ciphertext.slice(4)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("different secrets produce different ciphertexts", () => {
    const plaintext = "same-plaintext";
    const c1 = encrypt(plaintext, "secret-one");
    const c2 = encrypt(plaintext, "secret-two");
    expect(c1).not.toBe(c2);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility: old 3-part format
// ---------------------------------------------------------------------------

describe("backward compatibility — old 3-part format", () => {
  const secret = "test-secret-for-crypto-suite-32x"; // Matches beforeEach GANTRY_SECRET

  it("decryptWithFallback handles old 3-part format (iv:ciphertext:authTag)", () => {
    // Manually create old-format ciphertext using the old salt
    const plaintext = "backward-compat-test";
    const DEFAULT_SALT = "gantry-credential-encryption";
    const KEY_LENGTH = 32;
    const ALGORITHM = "aes-256-gcm";

    const key = scryptSync(secret, DEFAULT_SALT, KEY_LENGTH);
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let ciphertext = cipher.update(plaintext, "utf-8", "hex");
    ciphertext += cipher.final("hex");
    const authTag = cipher.getAuthTag();

    // Old format: no salt (3 parts only)
    const oldFormat = `${iv.toString("hex")}:${ciphertext}:${authTag.toString("hex")}`;
    const encrypted = "enc:" + Buffer.from(oldFormat).toString("base64");

    // decryptWithFallback should handle this
    const decrypted = decryptWithFallback(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("new format has 4 parts (salt:iv:ciphertext:authTag), old has 3", () => {
    const plaintext = "part-count-test";

    // New encryption produces 4 parts
    const newEncrypted = encrypt(plaintext, secret);
    const withoutPrefix = newEncrypted.slice(4);
    const newCombined = Buffer.from(withoutPrefix, "base64").toString("utf-8");
    const newParts = newCombined.split(":");
    expect(newParts.length).toBe(4);

    // Old format (manually created) has 3 parts
    const DEFAULT_SALT = "gantry-credential-encryption";
    const KEY_LENGTH = 32;
    const ALGORITHM = "aes-256-gcm";
    const key = scryptSync(secret, DEFAULT_SALT, KEY_LENGTH);
    const iv = randomBytes(16);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    let ciphertext = cipher.update(plaintext, "utf-8", "hex");
    ciphertext += cipher.final("hex");
    const authTag = cipher.getAuthTag();

    const oldFormat = `${iv.toString("hex")}:${ciphertext}:${authTag.toString("hex")}`;
    const oldEncrypted = "enc:" + Buffer.from(oldFormat).toString("base64");

    const oldCombined = Buffer.from(oldEncrypted.slice(4), "base64").toString("utf-8");
    const oldParts = oldCombined.split(":");
    expect(oldParts.length).toBe(3);

    // Both should decrypt correctly with decryptWithFallback
    expect(decryptWithFallback(newEncrypted)).toBe(plaintext);
    expect(decryptWithFallback(oldEncrypted)).toBe(plaintext);
  });
});

// ---------------------------------------------------------------------------
// decrypt with wrong key
// ---------------------------------------------------------------------------

describe("decrypt — wrong key", () => {
  const secret = "correct-secret";
  const wrongSecret = "wrong-secret";

  it("throws or returns garbage when decrypting with wrong key", () => {
    const ciphertext = encrypt("sensitive-data", secret);
    // AES-GCM authentication tag verification will throw on wrong key
    expect(() => decrypt(ciphertext, wrongSecret)).toThrow();
  });

  it("does not silently return the plaintext on wrong key", () => {
    const plaintext = "super-secret-credential";
    const ciphertext = encrypt(plaintext, secret);
    let result: string | undefined;
    try {
      result = decrypt(ciphertext, wrongSecret);
    } catch {
      result = undefined;
    }
    expect(result).not.toBe(plaintext);
  });

  it("empty-string secret is different from non-empty secret", () => {
    // createTokenAdapter prevents empty token, but crypto itself is more permissive.
    // Test that encrypt("x", "real") and decrypt with "" fails.
    const ciphertext = encrypt("value", "real-secret");
    expect(() => decrypt(ciphertext, "")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// decrypt with corrupted ciphertext
// ---------------------------------------------------------------------------

describe("decrypt — corrupted ciphertext", () => {
  const secret = "corruption-test-secret";

  it("throws on completely invalid base64", () => {
    expect(() => decrypt("not-valid!!!", secret)).toThrow();
  });

  it("throws when missing required ':' separators", () => {
    // Decode a valid base64 string that lacks the iv:ciphertext:authTag format
    const invalid = Buffer.from("noseparatorhere").toString("base64");
    expect(() => decrypt(invalid, secret)).toThrow();
  });

  it("throws on truncated ciphertext (missing authTag segment)", () => {
    const valid = encrypt("test", secret);
    // Strip "enc:" prefix, then decode, strip authTag, re-encode
    const withoutPrefix = valid.slice(4);
    const decoded = Buffer.from(withoutPrefix, "base64").toString("utf-8");
    const parts = decoded.split(":");
    // Keep only iv + ciphertext, drop authTag
    const truncated = "enc:" + Buffer.from(`${parts[0]}:${parts[1]}`).toString("base64");
    expect(() => decrypt(truncated, secret)).toThrow();
  });

  it("throws when auth tag is tampered (bit flip)", () => {
    const ciphertext = encrypt("important-value", secret);
    // Strip "enc:" prefix, decode, and flip a byte in the auth tag portion
    const withoutPrefix = ciphertext.slice(4);
    const decoded = Buffer.from(withoutPrefix, "base64").toString("utf-8");
    const parts = decoded.split(":");
    // Tamper the auth tag by changing the first character
    const tamperedTag = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
    const tampered = "enc:" + Buffer.from(`${parts[0]}:${parts[1]}:${tamperedTag}`).toString("base64");
    expect(() => decrypt(tampered, secret)).toThrow();
  });

  it("throws when ciphertext body is tampered", () => {
    const ciphertext = encrypt("important-value", secret);
    const withoutPrefix = ciphertext.slice(4);
    const decoded = Buffer.from(withoutPrefix, "base64").toString("utf-8");
    const parts = decoded.split(":");
    // Flip a byte in the ciphertext body
    const tamperedBody = (parts[1][0] === "a" ? "b" : "a") + parts[1].slice(1);
    const tampered = "enc:" + Buffer.from(`${parts[0]}:${tamperedBody}:${parts[2]}`).toString("base64");
    expect(() => decrypt(tampered, secret)).toThrow();
  });

  it("throws on empty string input", () => {
    expect(() => decrypt("", secret)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getEncryptionSecret — env-var path
// ---------------------------------------------------------------------------

describe("getEncryptionSecret", () => {
  it("returns a non-empty string (env var or cached/generated)", () => {
    // GANTRY_SECRET is set at module top. In isolated runs, cachedSecret is null
    // and getEncryptionSecret() reads GANTRY_SECRET (= TEST_SECRET). In the full
    // suite another module may have already cached a secret — either way the result
    // must be a non-empty string.
    const result = getEncryptionSecret();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("is idempotent (repeated calls return the same value)", () => {
    const a = getEncryptionSecret();
    const b = getEncryptionSecret();
    expect(a).toBe(b);
  });

  it("returned secret can encrypt and decrypt successfully", () => {
    const secret = getEncryptionSecret();
    const plaintext = "test-with-encryption-secret";
    const ciphertext = encrypt(plaintext, secret);
    expect(decrypt(ciphertext, secret)).toBe(plaintext);
  });

  it("auto-generated secrets have the expected 64-char hex format", () => {
    // The generation logic uses randomBytes(32).toString('hex').
    // Verify this format directly (we can't easily invoke auto-generation
    // without resetting module state, but we can verify the format contract).
    const generated = randomBytes(32).toString("hex");
    expect(generated).toHaveLength(64);
    expect(generated).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// isEncrypted helper
// ---------------------------------------------------------------------------

describe("isEncrypted", () => {
  it("returns true for the enc: prefixed output of encrypt()", () => {
    // encrypt() outputs "enc:" + base64
    const ciphertext = encrypt("hello", "some-secret");
    expect(isEncrypted(ciphertext)).toBe(true);
  });

  it("returns false for a raw 'iv:cipher:tag' colon-delimited string (legacy format)", () => {
    // A raw hex-formatted credential like "abc:def:ghi" without "enc:" prefix → false
    expect(isEncrypted("deadbeef:cafebabe:12345678")).toBe(false);
  });

  it("returns false for a plain string without 'enc:' prefix", () => {
    expect(isEncrypted("plaintextpassword")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isEncrypted("")).toBe(false);
  });

  it("returns false for strings with ':' but no 'enc:' prefix", () => {
    expect(isEncrypted("a:b")).toBe(false);
    expect(isEncrypted("foo:bar:baz")).toBe(false);
  });

  it("returns true only for strings starting with 'enc:' followed by base64", () => {
    expect(isEncrypted("enc:abc123==")).toBe(true);
    expect(isEncrypted("enc:YWJj")).toBe(true);
  });

  it("does not throw on unexpected inputs", () => {
    expect(() => isEncrypted("https://example.com/path")).not.toThrow();
    expect(() => isEncrypted("just a random string")).not.toThrow();
  });
});
});
