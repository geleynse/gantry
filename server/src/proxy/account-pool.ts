/**
 * AccountPool — centralized game account credential management.
 *
 * Operators can maintain a shared JSON file of game accounts and let Gantry
 * assign them to agents automatically (autoAssign mode) or explicitly via API.
 * Persists every mutation so crashes don't lose assignment state.
 *
 * Passwords are stored encrypted (AES-256-GCM) in the pool file.
 *
 * Usage:
 *   const pool = new AccountPool("/path/to/account-pool.json");
 *   const account = pool.assignAccount("my-agent");
 *   const creds = pool.getCredentials("my-agent");
 *
 * File format: see examples/account-pool.json.example
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createLogger } from "../lib/logger.js";
import { encrypt, decryptWithFallback, getEncryptionSecret } from "../services/crypto.js";
import type { Account, AccountStatus, AccountPoolConfig, AccountPoolFile, AccountPublic } from "../shared/types/account-pool.js";

const log = createLogger("account-pool");

const DEFAULT_POOL_CONFIG: AccountPoolConfig = {
  autoAssign: true,
  matchFaction: true,
  releaseOnShutdown: false,
  maxAssignmentsPerAccount: 1,
};

export class AccountPool {
  private poolFile: string;
  private accounts: Account[];
  private poolConfig: AccountPoolConfig;

  constructor(poolFile: string) {
    this.poolFile = poolFile;
    const { accounts, poolConfig } = this.load(poolFile);
    this.accounts = accounts;
    this.poolConfig = poolConfig;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private markAssigned(account: Account, agentName: string): void {
    account.status = "assigned";
    account.assignedTo = agentName;
    account.assignedAt = new Date().toISOString();
  }

  private markAvailable(account: Account): void {
    account.status = "available";
    account.assignedTo = null;
    account.assignedAt = null;
  }

  private load(filePath: string): { accounts: Account[]; poolConfig: AccountPoolConfig } {
    if (!existsSync(filePath)) {
      throw new Error(`[AccountPool] Pool file not found: ${filePath}`);
    }
    const raw = readFileSync(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`[AccountPool] Failed to parse pool file ${filePath}: ${(err as Error).message}`);
    }

    const data = parsed as AccountPoolFile;
    if (!Array.isArray(data.accounts)) {
      throw new Error(`[AccountPool] Pool file must have an "accounts" array: ${filePath}`);
    }

    const poolConfig: AccountPoolConfig = {
      ...DEFAULT_POOL_CONFIG,
      ...(data.config ?? {}),
    };

    // Validate and normalize each account
    const accounts: Account[] = data.accounts.map((raw, idx) => {
      if (!raw.username || typeof raw.username !== "string") {
        throw new Error(`[AccountPool] Account at index ${idx} missing "username"`);
      }
      if (!raw.password || typeof raw.password !== "string") {
        throw new Error(`[AccountPool] Account at index ${idx} ("${raw.username}") missing "password"`);
      }
      const validStatuses: AccountStatus[] = ["available", "assigned", "disabled"];
      const status: AccountStatus = validStatuses.includes(raw.status as AccountStatus)
        ? (raw.status as AccountStatus)
        : "available";

      // Decrypt password if encrypted (starts with "enc:"), otherwise use as-is
      let password = raw.password;
      if (password.startsWith("enc:")) {
        try {
          password = decryptWithFallback(password);
        } catch (err) {
          log.warn(`Failed to decrypt password for account "${raw.username}": ${err instanceof Error ? err.message : String(err)}`);
          throw new Error(`[AccountPool] Failed to decrypt password for account "${raw.username}"`);
        }
      }

      return {
        id: raw.id ?? raw.username,
        username: raw.username,
        password,
        status,
        assignedTo: raw.assignedTo ?? null,
        assignedAt: raw.assignedAt ?? null,
        faction: raw.faction,
        notes: raw.notes,
        lastLogin: raw.lastLogin,
      };
    });

    return { accounts, poolConfig };
  }

  persist(): void {
    // Encrypt passwords before writing to disk
    const secret = getEncryptionSecret();
    const encryptedAccounts = this.accounts.map((account) => ({
      ...account,
      password: encrypt(account.password, secret),
    }));

    const data: AccountPoolFile = {
      accounts: encryptedAccounts,
      config: this.poolConfig,
    };
    try {
      writeFileSync(this.poolFile, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      log.error(`Failed to persist pool to ${this.poolFile}: ${err}`);
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Automatically assign an available account to an agent.
   * If matchFaction is enabled and the agent has a faction hint, prefers matching.
   * Returns null if no accounts are available.
   */
  assignAccount(agentName: string, factionHint?: string): Account | null {
    // If agent already has an assignment, return it
    const existing = this.accounts.find(
      (a) => a.assignedTo === agentName && a.status === "assigned"
    );
    if (existing) return existing;

    const available = this.accounts.filter((a) => a.status === "available");
    if (available.length === 0) return null;

    let chosen: Account | undefined;

    // Prefer faction match when matchFaction is on and we have a hint
    if (this.poolConfig.matchFaction && factionHint) {
      chosen = available.find((a) => a.faction === factionHint);
    }

    // Fall back to first available
    if (!chosen) {
      chosen = available[0];
    }

    this.markAssigned(chosen, agentName);
    this.persist();
    return chosen;
  }

  /**
   * Explicitly assign a specific username to an agent.
   * Fails if the account doesn't exist or is disabled.
   * Returns false if assignment failed.
   */
  assignAccountTo(agentName: string, username: string): boolean {
    const account = this.accounts.find((a) => a.username === username);
    if (!account) {
      log.warn(`assignAccountTo: account "${username}" not found`);
      return false;
    }
    if (account.status === "disabled") {
      log.warn(`assignAccountTo: account "${username}" is disabled`);
      return false;
    }
    // Already assigned to this agent
    if (account.assignedTo === agentName) return true;

    this.markAssigned(account, agentName);
    this.persist();
    return true;
  }

  /**
   * Release an agent's account back to "available".
   * No-op if the agent has no assignment.
   */
  releaseAccount(agentName: string): void {
    const account = this.accounts.find((a) => a.assignedTo === agentName);
    if (!account) return;

    this.markAvailable(account);
    this.persist();
  }

  /**
   * Release all assignments. Used on shutdown when releaseOnShutdown is true.
   */
  releaseAll(): void {
    let changed = false;
    for (const account of this.accounts) {
      if (account.status === "assigned") {
        this.markAvailable(account);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Return all accounts with current status.
   * Does not expose passwords.
   */
  listAccounts(): AccountPublic[] {
    return this.accounts.map(({ password: _pw, ...rest }) => rest);
  }

  /**
   * Get credentials for the agent's assigned account.
   * Returns null if no account is assigned.
   */
  getCredentials(agentName: string): { username: string; password: string } | null {
    const account = this.accounts.find(
      (a) => a.assignedTo === agentName && a.status === "assigned"
    );
    if (!account) return null;
    return { username: account.username, password: account.password };
  }

  /**
   * Update lastLogin timestamp for the agent's assigned account.
   * Called after successful game login.
   */
  recordLogin(agentName: string): void {
    const account = this.accounts.find((a) => a.assignedTo === agentName);
    if (!account) return;
    account.lastLogin = new Date().toISOString();
    this.persist();
  }

  /**
   * Whether the pool is configured to auto-assign.
   */
  get autoAssign(): boolean {
    return this.poolConfig.autoAssign;
  }

  /**
   * Whether assignments should be released on shutdown.
   */
  get releaseOnShutdown(): boolean {
    return this.poolConfig.releaseOnShutdown;
  }

  /**
   * Get raw pool config (for diagnostics/API).
   */
  getPoolConfig(): AccountPoolConfig {
    return { ...this.poolConfig };
  }

  /**
   * Reload pool from disk. Useful after external edits.
   */
  reload(): void {
    const { accounts, poolConfig } = this.load(this.poolFile);
    this.accounts = accounts;
    this.poolConfig = poolConfig;
  }
}
