/**
 * Encryption/decryption helpers for sensitive credentials.
 * Uses AES-256-GCM with scrypt-derived key and random salt per encryption.
 *
 * SECURITY NOTE: Uses a random 16-byte salt per encryption for scrypt key derivation.
 * The salt is stored alongside the ciphertext in the format: "enc:" + base64(salt:iv:ciphertext:authTag).
 * This provides defense-in-depth against dictionary attacks and precomputed key tables.
 * The IV is also randomly generated per encryption, providing authenticated encryption.
 * Backward compatibility: decryptWithFallback() handles old 3-part format (iv:ciphertext:authTag)
 * with fixed salt for existing encrypted credentials.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { FLEET_DIR } from "../config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 16; // 128 bits for per-encryption random salt
// Fallback salt for backward compatibility with old 3-part format (iv:ciphertext:authTag)
const DEFAULT_SALT = "gantry-credential-encryption";
const FALLBACK_SALT = process.env.GANTRY_SALT || DEFAULT_SALT;
const SECRET_FILE = join(FLEET_DIR, "data", ".gantry-secret");

/**
 * Contained singletons for lazy initialization cache of encryption secrets.
 * These are acceptable as module-private singletons because they are
 * lazy-initialization caches for static config (loaded from disk once)
 * and do not represent shared mutable state that changes during operation.
 */
let cachedSecret: string | null = null;
let previousSecret: string | null = null;
let overriddenSecretPath: string | null = null;
let overriddenPrevSecretPath: string | null = null;

// Load previous secret (crash recovery from partial rotation)
const PREV_SECRET_FILE = SECRET_FILE + ".prev";

/**
 * Override SECRET_PATH and PREV_SECRET_PATH for testing.
 * Call this in beforeEach to use a temporary directory.
 */
export function setSecretPathsForTesting(secretPath: string, prevSecretPath: string): void {
  overriddenSecretPath = secretPath;
  overriddenPrevSecretPath = prevSecretPath;
  cachedSecret = null; // Reset cache so new path is used
  previousSecret = null;
  // Try to load previous secret from new path
  try {
    if (existsSync(overriddenPrevSecretPath)) {
      previousSecret = readFileSync(overriddenPrevSecretPath, "utf-8").trim() || null;
    }
  } catch { /* ignore */ }
}
try {
  if (existsSync(PREV_SECRET_FILE)) {
    previousSecret = readFileSync(PREV_SECRET_FILE, "utf-8").trim() || null;
    if (previousSecret) log.info("Loaded previous secret for rotation fallback");
  }
} catch {
  // Ignore — not critical
}

/**
 * Get or create the encryption secret.
 * Priority: env var > persisted file > auto-generate
 */
export function getEncryptionSecret(): string {
  if (cachedSecret) return cachedSecret;

  // Check env var first
  const envSecret = process.env.GANTRY_SECRET;
  if (envSecret) {
    cachedSecret = envSecret;
    return cachedSecret;
  }

  const secretPath = overriddenSecretPath || SECRET_FILE;

  // Check persisted file
  if (existsSync(secretPath)) {
    try {
      cachedSecret = readFileSync(secretPath, "utf-8").trim();
      if (cachedSecret.length > 0) return cachedSecret;
    } catch {
      // Fall through to generate
    }
  }

  // Generate and persist
  cachedSecret = randomBytes(32).toString("hex");
  try {
    mkdirSync(dirname(secretPath), { recursive: true });
    writeFileSync(secretPath, cachedSecret, { mode: 0o600 }); // Only user readable
    log.info(`Generated and persisted encryption secret to ${secretPath}`);
  } catch (err) {
    log.warn(`Failed to persist secret: ${err instanceof Error ? err.message : String(err)}`);
  }

  return cachedSecret;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Generates a random salt per encryption and derives the key using scrypt.
 * Returns: "enc:" prefix + base64-encoded "salt:iv:ciphertext:authTag" (4 parts, all hex)
 */
export function encrypt(plaintext: string, secret: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(secret, salt, KEY_LENGTH);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  let ciphertext = cipher.update(plaintext, "utf-8", "hex");
  ciphertext += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Format: salt:iv:ciphertext:authTag (all hex-encoded)
  const combined = `${salt.toString("hex")}:${iv.toString("hex")}:${ciphertext}:${authTag.toString("hex")}`;
  return "enc:" + Buffer.from(combined).toString("base64");
}

/**
 * Decrypt ciphertext encrypted by encrypt().
 * Expects "enc:" prefix + base64-encoded "salt:iv:ciphertext:authTag" (4 parts, all hex)
 */
export function decrypt(encrypted: string, secret: string): string {
  // Strip "enc:" prefix if present
  const withoutPrefix = encrypted.startsWith("enc:") ? encrypted.slice(4) : encrypted;

  const combined = Buffer.from(withoutPrefix, "base64").toString("utf-8");
  const parts = combined.split(":");

  if (parts.length !== 4) {
    throw new Error("[crypto] Invalid encrypted format - expected 4 parts (salt:iv:ciphertext:authTag)");
  }

  const [saltHex, ivHex, ciphertext, authTagHex] = parts;

  if (!saltHex || !ivHex || !ciphertext || !authTagHex) {
    throw new Error("[crypto] Invalid encrypted format - missing required parts");
  }

  const salt = Buffer.from(saltHex, "hex");
  const key = scryptSync(secret, salt, KEY_LENGTH);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext, "hex", "utf-8");
  plaintext += decipher.final("utf-8");

  return plaintext;
}

/**
 * Check if a stored credential is encrypted or plaintext.
 * Encrypted: starts with "enc:" prefix followed by valid base64.
 * Plaintext: anything else (legacy format).
 */
export function isEncrypted(stored: string): boolean {
  if (!stored.startsWith("enc:")) return false;
  // base64 decode won't throw in Node — check length as a basic validity gate
  return stored.length > 4;
}

// ---------------------------------------------------------------------------
// Secret rotation helpers
// ---------------------------------------------------------------------------

/** Replace the cached secret. Called after all credentials are re-encrypted. */
export function setCachedSecret(newSecret: string): void {
  cachedSecret = newSecret;
}

/** Set the previous secret for fallback decryption during/after rotation. */
export function setPreviousSecret(secret: string | null): void {
  previousSecret = secret;
}

/** Reset all cached secrets and paths (for testing). */
export function resetCachedSecrets(): void {
  cachedSecret = null;
  previousSecret = null;
  overriddenSecretPath = null;
  overriddenPrevSecretPath = null;
}

/** Get the previous secret (null if no rotation in progress/recovered). */
export function getPreviousSecret(): string | null {
  return previousSecret;
}

/** Get the path to the previous secret file (for rotation crash recovery). */
export function getPrevSecretPath(): string {
  return overriddenPrevSecretPath || PREV_SECRET_FILE;
}

/** Get the path to the current secret file. */
export function getSecretPath(): string {
  return overriddenSecretPath || SECRET_FILE;
}

// Backward compatibility - these are constants but getter functions are available
export const PREV_SECRET_PATH = PREV_SECRET_FILE;
export const SECRET_PATH = SECRET_FILE;

/**
 * Decrypt with fallback to previous secret and old format.
 * Handles three cases:
 * 1. New 4-part format (salt:iv:ciphertext:authTag) with current secret
 * 2. New 4-part format with previous secret (during rotation)
 * 3. Old 3-part format (iv:ciphertext:authTag) with fallback salt (backward compatibility)
 */
export function decryptWithFallback(encrypted: string): string {
  const current = getEncryptionSecret();
  const secrets = [current, ...(previousSecret ? [previousSecret] : [])];

  for (const secret of secrets) {
    try { return decrypt(encrypted, secret); } catch { /* try next */ }
  }
  for (const secret of secrets) {
    try { return decryptOldFormat(encrypted, secret); } catch { /* try next */ }
  }

  throw new Error("[crypto] Failed to decrypt with current/previous secret or old format");
}

/**
 * Decrypt old 3-part format (iv:ciphertext:authTag) with fallback salt.
 * Used for backward compatibility with credentials encrypted before random-salt migration.
 * @internal
 */
function decryptOldFormat(encrypted: string, secret: string): string {
  const withoutPrefix = encrypted.startsWith("enc:") ? encrypted.slice(4) : encrypted;
  const combined = Buffer.from(withoutPrefix, "base64").toString("utf-8");
  const parts = combined.split(":");

  if (parts.length !== 3) {
    throw new Error("[crypto] Old format requires exactly 3 parts");
  }

  const [ivHex, ciphertext, authTagHex] = parts;

  if (!ivHex || !ciphertext || !authTagHex) {
    throw new Error("[crypto] Invalid old format - missing required parts");
  }

  const key = scryptSync(secret, FALLBACK_SALT, KEY_LENGTH);
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext = decipher.update(ciphertext, "hex", "utf-8");
  plaintext += decipher.final("utf-8");

  return plaintext;
}
