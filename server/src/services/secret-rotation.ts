/**
 * Secret rotation orchestration.
 *
 * Generates a new encryption secret and re-encrypts all credential stores
 * (SQLite sessions, account pool, file fallback) by leveraging existing
 * persist methods that call getEncryptionSecret() internally.
 */

import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "../proxy/session-manager.js";
import {
  getEncryptionSecret,
  setCachedSecret,
  setPreviousSecret,
  getSecretPath,
  getPrevSecretPath,
} from "./crypto.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("rotation");

export interface RotationResult {
  sessionsRotated: number;
  accountsRotated: number;
  durationMs: number;
}

/**
 * Rotate the encryption secret and re-encrypt all credential stores.
 *
 * Steps:
 *  1. Save old secret to .gantry-secret.prev (crash recovery)
 *  2. Write new secret to .gantry-secret (atomic via tmp + rename)
 *  3. Update in-memory cache
 *  4. Re-persist sessions and account pool (re-encrypts with new secret)
 *  5. Clean up .gantry-secret.prev
 */
export function rotateSecret(sessionManager: SessionManager): RotationResult {
  const start = Date.now();
  const oldSecret = getEncryptionSecret();
  const newSecret = randomBytes(32).toString("hex");

  // Step 1: Save old secret for crash recovery
  try {
    const prevSecretPath = getPrevSecretPath();
    mkdirSync(dirname(prevSecretPath), { recursive: true });
    writeFileSync(prevSecretPath, oldSecret, { mode: 0o600 });
  } catch (err) {
    throw new Error(`Failed to write previous secret: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 2: Write new secret (atomic via tmp + rename)
  const secretPath = getSecretPath();
  const tmpPath = secretPath + ".tmp";
  try {
    writeFileSync(tmpPath, newSecret, { mode: 0o600 });
    renameSync(tmpPath, secretPath);
  } catch (err) {
    // Clean up tmp if it exists
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw new Error(`Failed to write new secret: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 3: Update in-memory cache
  setCachedSecret(newSecret);
  setPreviousSecret(oldSecret);

  // Step 4: Re-persist all credential stores (uses getEncryptionSecret() → new secret)
  let sessionsRotated = 0;
  let accountsRotated = 0;

  try {
    sessionManager.persistSessions();
    sessionsRotated = sessionManager.listActive().length;
  } catch (err) {
    log.error(`Failed to re-persist sessions: ${err}`);
    // Not fatal — in-memory credentials are plaintext, will be re-persisted on next operation
  }

  try {
    const pool = sessionManager.getPoolInstance();
    if (pool) {
      pool.persist();
      accountsRotated = pool.listAccounts().length;
    }
  } catch (err) {
    log.error(`Failed to re-persist account pool: ${err}`);
  }

  // Step 5: Clean up previous secret file
  try {
    const prevSecretPath = getPrevSecretPath();
    if (existsSync(prevSecretPath)) unlinkSync(prevSecretPath);
  } catch {
    log.warn("Failed to clean up .gantry-secret.prev — not critical");
  }

  const result: RotationResult = {
    sessionsRotated,
    accountsRotated,
    durationMs: Date.now() - start,
  };

  log.info("Secret rotation completed", { sessionsRotated: String(result.sessionsRotated), accountsRotated: String(result.accountsRotated), durationMs: String(result.durationMs) });
  return result;
}
