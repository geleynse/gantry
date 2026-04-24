/**
 * Credential encryption helpers for fleet-credentials.json.
 *
 * Encrypts password fields at rest using AES-256-GCM (same mechanism as session
 * data in crypto.ts). Usernames stay plaintext — they're needed for display.
 *
 * File format (on disk):
 *   { "agent-name": { "username": "plain", "password": "enc:..." } }
 *
 * Migration:
 *   On first import, if fleet-credentials.json exists and fleet-credentials.enc.json
 *   does not, passwords are encrypted and the result written to fleet-credentials.enc.json.
 *   The original is renamed to fleet-credentials.json.bak.
 *
 * No-key fallback:
 *   When GANTRY_SECRET is not set AND no secret file exists, getEncryptionSecret()
 *   auto-generates and persists one — so encryption is always on. There is no plaintext
 *   fallback in production; this module always encrypts.
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../lib/atomic-write.js";
import { encrypt, decryptWithFallback, isEncrypted, getEncryptionSecret } from "./crypto.js";
import { createLogger } from "../lib/logger.js";
import { HttpGameClient } from "../proxy/game-client.js";
import { MetricsWindow } from "../proxy/instability-metrics.js";

const log = createLogger("credentials-crypto");

export type RawCredentialsFile = Record<string, { username: string; password: string }>;

/**
 * Encrypt all password fields in a credentials map.
 * Passwords that are already encrypted (start with "enc:") are left unchanged.
 */
export function encryptCredentials(
  creds: RawCredentialsFile,
  secret: string,
): RawCredentialsFile {
  const result: RawCredentialsFile = {};
  for (const [agent, entry] of Object.entries(creds)) {
    result[agent] = {
      username: entry.username,
      password: isEncrypted(entry.password) ? entry.password : encrypt(entry.password, secret),
    };
  }
  return result;
}

/**
 * Decrypt all password fields in a credentials map.
 * Passwords that are plaintext (no "enc:" prefix) are returned as-is with a warning.
 */
export function decryptCredentials(creds: RawCredentialsFile): RawCredentialsFile {
  const result: RawCredentialsFile = {};
  for (const [agent, entry] of Object.entries(creds)) {
    let password = entry.password;
    if (isEncrypted(password)) {
      try {
        password = decryptWithFallback(password);
      } catch (err) {
        log.warn(`Failed to decrypt password for agent "${agent}": ${err instanceof Error ? err.message : String(err)}`);
        // Return the encrypted value rather than crashing — caller decides how to handle
      }
    }
    result[agent] = { username: entry.username, password };
  }
  return result;
}

/**
 * Encrypt a single password value.
 * If already encrypted, returns it unchanged.
 */
export function encryptPassword(password: string): string {
  if (isEncrypted(password)) return password;
  const secret = getEncryptionSecret();
  return encrypt(password, secret);
}

/**
 * Decrypt a single password value.
 * If plaintext (no enc: prefix), returns it as-is.
 */
export function decryptPassword(password: string): string {
  if (!isEncrypted(password)) return password;
  return decryptWithFallback(password);
}

/**
 * Migrate fleet-credentials.json → fleet-credentials.enc.json if needed.
 *
 * Conditions:
 *   - fleet-credentials.json exists
 *   - fleet-credentials.enc.json does NOT exist (first run after upgrade)
 *
 * On success:
 *   - Encrypted credentials written to fleet-credentials.enc.json
 *   - Original renamed to fleet-credentials.json.bak
 *
 * Returns true if migration ran, false if it was skipped (already migrated or no source).
 */
export function migrateCredentialsIfNeeded(fleetDir: string): boolean {
  const src = join(fleetDir, "fleet-credentials.json");
  const dst = join(fleetDir, "fleet-credentials.enc.json");
  const bak = join(fleetDir, "fleet-credentials.json.bak");

  if (!existsSync(src) || existsSync(dst)) {
    return false;
  }

  log.info("Migrating fleet-credentials.json → fleet-credentials.enc.json");

  let raw: RawCredentialsFile;
  try {
    raw = JSON.parse(readFileSync(src, "utf-8")) as RawCredentialsFile;
  } catch (err) {
    log.error(`Migration failed — could not parse fleet-credentials.json: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  const agents = Object.keys(raw);
  if (agents.length === 0) {
    log.warn("Migration skipped — fleet-credentials.json is empty");
    return false;
  }

  const secret = getEncryptionSecret();
  const encrypted = encryptCredentials(raw, secret);

  // Verify: decrypt one entry to confirm the key roundtrips correctly
  const testAgent = agents[0];
  try {
    const decrypted = decryptCredentials({ [testAgent]: encrypted[testAgent] });
    if (decrypted[testAgent].password !== raw[testAgent].password) {
      log.error("Migration aborted — decrypt verification produced wrong password");
      return false;
    }
  } catch (err) {
    log.error(`Migration aborted — decrypt verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }

  try {
    atomicWriteFileSync(dst, JSON.stringify(encrypted, null, 2));
    renameSync(src, bak);
    log.info(`Migration complete. Plaintext backup at fleet-credentials.json.bak`);
  } catch (err) {
    log.error(`Migration failed — could not write encrypted file: ${err instanceof Error ? err.message : String(err)}`);
    // Clean up partial migration
    try { if (existsSync(dst)) unlinkSync(dst); } catch { /* best effort */ }
    return false;
  }

  return true;
}

/**
 * Return the active credentials file path.
 * Prefers fleet-credentials.enc.json (encrypted) over fleet-credentials.json (plaintext/legacy).
 *
 * If both files exist and the plaintext file is newer than the encrypted file,
 * re-runs the encryption migration so edits to fleet-credentials.json are never silently ignored.
 */
export function getCredentialsFilePath(fleetDir: string): string {
  const enc = join(fleetDir, "fleet-credentials.enc.json");
  const plain = join(fleetDir, "fleet-credentials.json");

  if (existsSync(enc) && existsSync(plain)) {
    try {
      const encMtime = statSync(enc).mtimeMs;
      const plainMtime = statSync(plain).mtimeMs;
      if (plainMtime > encMtime) {
        log.info("Re-encrypting credentials (plaintext file updated)");
        // Temporarily remove the enc file so migrateCredentialsIfNeeded will run
        const tmp = enc + ".old";
        renameSync(enc, tmp);
        const migrated = migrateCredentialsIfNeeded(fleetDir);
        if (migrated) {
          // Migration succeeded — remove the old enc file
          try { unlinkSync(tmp); } catch { /* best effort */ }
        } else {
          // Migration failed — restore original enc file
          log.warn("Re-encryption failed — reverting to existing encrypted file");
          renameSync(tmp, enc);
        }
      }
    } catch (err) {
      log.warn(`Could not compare credential file mtimes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (existsSync(enc)) return enc;
  return plain;
}

/**
 * Result of a credential validation attempt.
 */
export type CredentialValidationResult =
  | { ok: true; agentName: string; username: string }
  | { ok: false; agentName: string; username: string; reason: "auth_failed" | "network_error" | "no_credentials" }

/**
 * Minimal interface for a game client used during credential validation.
 * Allows injection of a mock client in tests without module-level mocking.
 */
export interface ValidationGameClient {
  label: string;
  login(username: string, password: string): Promise<{ error?: { code: string } | null }>;
  logout(): Promise<unknown>;
  close(): Promise<void>;
}

export function isAuthFailureCode(code: string | undefined): boolean {
  return code === "unauthorized" || code === "forbidden" ||
    code === "invalid_credentials" || code === "auth_failed" ||
    code === "login_failed" || code === "bad_credentials";
}

function loadDecryptedCredentials(fleetDir: string): RawCredentialsFile {
  const credsPath = getCredentialsFilePath(fleetDir);
  const raw = JSON.parse(readFileSync(credsPath, "utf-8")) as RawCredentialsFile;
  return decryptCredentials(raw);
}

async function validateCredentialEntry(
  agentName: string,
  username: string,
  password: string,
  gameMcpUrl: string,
  clientFactory?: (mcpUrl: string) => ValidationGameClient,
): Promise<CredentialValidationResult> {
  const makeClient = clientFactory ?? ((mcpUrl: string) => {
    const metrics = new MetricsWindow();
    const c = new HttpGameClient(mcpUrl, metrics);
    return c as ValidationGameClient;
  });

  const client = makeClient(gameMcpUrl);
  client.label = `validate:${agentName}`;

  try {
    const resp = await client.login(username, password);

    if (!resp.error) {
      log.info(`Credentials validated (agent: ${agentName}, user: ${username})`);
      // Discard the session — we don't need it
      try { await client.logout(); } catch { /* best effort */ }
      try { await client.close(); } catch { /* best effort */ }
      return { ok: true, agentName, username };
    }

    const code = resp.error.code;

    if (isAuthFailureCode(code)) {
      log.error(
        `\n${"=".repeat(70)}\n` +
        `WARNING: Fleet credentials may be stale — login failed for agent "${agentName}".\n` +
        `Username: ${username} | Error: ${code}\n` +
        `Check fleet-credentials and update passwords before starting agents.\n` +
        `${"=".repeat(70)}`
      );
      try { await client.close(); } catch { /* best effort */ }
      return { ok: false, agentName, username, reason: "auth_failed" };
    }

    // Other error (e.g. action_pending, rate_limited, server_error) — treat as network issue
    log.warn(`Credential validation inconclusive for agent "${agentName}" — server returned: ${code ?? "unknown error"}. Game server may be down or busy.`);
    try { await client.close(); } catch { /* best effort */ }
    return { ok: false, agentName, username, reason: "network_error" };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Credential validation failed for agent "${agentName}" — could not reach game server: ${msg}. This is expected if the game is offline.`);
    try { await client.close(); } catch { /* best effort */ }
    return { ok: false, agentName, username, reason: "network_error" };
  }
}

/**
 * Validate fleet credentials against the game API by attempting a login.
 *
 * Picks the first agent entry from the loaded credentials, opens a temporary
 * MCP HTTP connection, sends a login command, then closes the connection.
 *
 * - 401/403 response → LOUD warning (stale credentials)
 * - Network/connection error → soft warning (game server may be down)
 * - Success → logs "Credentials validated" and discards the session
 *
 * Never throws — all errors are logged and returned as a result object.
 * This is advisory only; startup continues regardless.
 *
 * @param clientFactory - Optional factory for creating the game client. Defaults to
 *   creating a real HttpGameClient. Override in tests to avoid real network connections.
 */
export async function validateCredentials(
  fleetDir: string,
  gameMcpUrl: string,
  clientFactory?: (mcpUrl: string) => ValidationGameClient,
): Promise<CredentialValidationResult> {
  // Load and decrypt credentials
  let creds: RawCredentialsFile;
  try {
    creds = loadDecryptedCredentials(fleetDir);
  } catch (err) {
    log.warn(`Credential validation skipped — could not load credentials: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, agentName: "(unknown)", username: "(unknown)", reason: "no_credentials" };
  }

  const entries = Object.entries(creds);
  if (entries.length === 0) {
    log.warn("Credential validation skipped — credentials file is empty");
    return { ok: false, agentName: "(unknown)", username: "(unknown)", reason: "no_credentials" };
  }

  const [agentName, { username, password }] = entries[0];
  return validateCredentialEntry(agentName, username, password, gameMcpUrl, clientFactory);
}

export async function validateCredentialForAgent(
  fleetDir: string,
  gameMcpUrl: string,
  agentName: string,
  clientFactory?: (mcpUrl: string) => ValidationGameClient,
): Promise<CredentialValidationResult> {
  let creds: RawCredentialsFile;
  try {
    creds = loadDecryptedCredentials(fleetDir);
  } catch (err) {
    log.warn(`Credential validation skipped — could not load credentials: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, agentName, username: "(unknown)", reason: "no_credentials" };
  }

  const entry = creds[agentName];
  if (!entry) {
    log.warn(`Credential validation skipped — no credentials found for agent "${agentName}"`);
    return { ok: false, agentName, username: "(unknown)", reason: "no_credentials" };
  }

  return validateCredentialEntry(agentName, entry.username, entry.password, gameMcpUrl, clientFactory);
}

export async function validateAllCredentials(
  fleetDir: string,
  gameMcpUrl: string,
  clientFactory?: (mcpUrl: string) => ValidationGameClient,
): Promise<CredentialValidationResult[]> {
  let creds: RawCredentialsFile;
  try {
    creds = loadDecryptedCredentials(fleetDir);
  } catch (err) {
    log.warn(`Credential validation skipped — could not load credentials: ${err instanceof Error ? err.message : String(err)}`);
    return [{ ok: false, agentName: "(unknown)", username: "(unknown)", reason: "no_credentials" }];
  }

  const entries = Object.entries(creds);
  if (entries.length === 0) {
    log.warn("Credential validation skipped — credentials file is empty");
    return [{ ok: false, agentName: "(unknown)", username: "(unknown)", reason: "no_credentials" }];
  }

  const results: CredentialValidationResult[] = [];
  for (const [agentName, { username, password }] of entries) {
    results.push(await validateCredentialEntry(agentName, username, password, gameMcpUrl, clientFactory));
  }
  return results;
}
