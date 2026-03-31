import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createGameClient } from "./game-client.js";
import type { GameTransport } from "./game-transport.js";
import { MockGameClient } from "./mock-game-client.js";
import type { BreakerRegistry } from "./circuit-breaker.js";
import type { MetricsWindow } from "./instability-metrics.js";
import type { GantryConfig, AgentConfig } from "../config.js";
import { getDb, getDbIfInitialized } from "../services/database.js";
import { encrypt, decrypt, isEncrypted, getEncryptionSecret } from "../services/crypto.js";
import { AccountPool } from "./account-pool.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("session");

interface PersistedSession {
  agentName: string;
  credentials: { username: string; password: string };
}

/** Stale session threshold: skip graceful logout if no activity within this window */
const STALE_SESSION_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export class SessionManager {
  private config: GantryConfig;
  private clients = new Map<string, GameTransport | MockGameClient>();
  private agentMap: Map<string, AgentConfig>;
  private persistPath: string | undefined;
  private breakerRegistry: BreakerRegistry;
  private serverMetrics: MetricsWindow;
  /** Tracks last activity time per agent (ms since epoch). Updated on client access. */
  private lastActivity = new Map<string, number>();
  /** Account pool, if configured. Initialized lazily on first use. */
  private accountPool: AccountPool | null = null;
  private accountPoolInitialized = false;

  constructor(config: GantryConfig, breakerRegistry: BreakerRegistry, serverMetrics: MetricsWindow, persistPath?: string) {
    this.config = config;
    this.agentMap = new Map(config.agents.map((a) => [a.name, a]));
    this.persistPath = persistPath;
    this.breakerRegistry = breakerRegistry;
    this.serverMetrics = serverMetrics;
  }

  // -------------------------------------------------------------------------
  // Account Pool helpers
  // -------------------------------------------------------------------------

  /**
   * Get or lazily initialize the AccountPool.
   * Returns null if no pool is configured.
   */
  private getAccountPool(): AccountPool | null {
    if (this.accountPoolInitialized) return this.accountPool;
    this.accountPoolInitialized = true;

    const poolConfig = this.config.accountPool;
    if (!poolConfig) return null;

    try {
      this.accountPool = new AccountPool(poolConfig.poolFile);
      log.info(`Account pool loaded from ${poolConfig.poolFile}`);
    } catch (err) {
      log.error(`Failed to initialize account pool: ${(err as Error).message}`);
      this.accountPool = null;
    }
    return this.accountPool;
  }

  /**
   * Get credentials for an agent from the account pool.
   * Auto-assigns an available account if none is currently assigned.
   * Returns null if no pool is configured or no account is available.
   */
  getCredentialsFromPool(agentName: string): { username: string; password: string } | null {
    const pool = this.getAccountPool();
    if (!pool) return null;

    // Check if already assigned
    const existing = pool.getCredentials(agentName);
    if (existing) return existing;

    // Auto-assign if pool has autoAssign enabled
    if (!pool.autoAssign) return null;

    const agentConfig = this.agentMap.get(agentName);
    const assigned = pool.assignAccount(agentName, agentConfig?.faction);
    if (!assigned) {
      log.warn(`Account pool: no available accounts for agent "${agentName}"`);
      return null;
    }
    log.info(`Account pool: assigned "${assigned.username}" to agent "${agentName}"`);
    return { username: assigned.username, password: assigned.password };
  }

  /**
   * Update the pool's lastLogin for an agent after successful login.
   */
  recordPoolLogin(agentName: string): void {
    const pool = this.getAccountPool();
    pool?.recordLogin(agentName);
  }

  /**
   * Release an agent's pool account (e.g., on logout or shutdown).
   */
  releasePoolAccount(agentName: string): void {
    const pool = this.getAccountPool();
    pool?.releaseAccount(agentName);
  }

  /**
   * Get the AccountPool instance (for API routes, diagnostics).
   */
  getPoolInstance(): AccountPool | null {
    return this.getAccountPool();
  }

  // -------------------------------------------------------------------------
  // Existing SessionManager API (unchanged)
  // -------------------------------------------------------------------------

  /**
   * Resolve a game username to a fleet-config agent name.
   * Handles case differences and spaces vs dashes:
   *   "My Agent" → "my-agent"
   *   "my-agent" → "my-agent"
   */
  resolveAgentName(username: string): string {
    // Direct match first
    if (this.agentMap.has(username)) return username;
    // Normalize: lowercase, spaces → dashes
    const normalized = username.toLowerCase().replace(/\s+/g, "-");
    if (this.agentMap.has(normalized)) return normalized;
    // No match
    return username;
  }

  getOrCreateClient(agentName: string): GameTransport | MockGameClient {
    const resolved = this.resolveAgentName(agentName);
    this.lastActivity.set(resolved, Date.now());
    const existing = this.clients.get(resolved);
    if (existing) return existing;

    const agentConfig = this.agentMap.get(resolved);
    if (!agentConfig) {
      throw new Error(`Unknown agent: ${agentName}`);
    }

    const mockMode = this.config.mockMode;
    if (mockMode?.enabled) {
      const client = new MockGameClient(mockMode);
      client.label = resolved;
      this.breakerRegistry.register(resolved, client.breaker);
      this.clients.set(resolved, client);
      return client;
    }

    const client = createGameClient(
      this.config.gameMcpUrl,
      this.serverMetrics,
      agentConfig.socksPort,
    );
    client.label = resolved;
    if (this.config.credentialsPath) {
      client.credentialsPath = this.config.credentialsPath;
    }
    this.breakerRegistry.register(resolved, client.breaker);
    this.clients.set(resolved, client);
    return client;
  }

  getClient(agentName: string): GameTransport | MockGameClient | undefined {
    return this.clients.get(this.resolveAgentName(agentName));
  }

  removeClient(agentName: string): void {
    const resolved = this.resolveAgentName(agentName);
    const client = this.clients.get(resolved);
    if (client) {
      client.close().catch(() => {});
    }
    this.clients.delete(resolved);
    this.lastActivity.delete(resolved);
    this.breakerRegistry.remove(resolved);
    this.persistSessions();
  }

  /**
   * Get the last activity time for an agent (ms since epoch).
   * Returns 0 if the agent has never been active.
   */
  getLastActivity(agentName: string): number {
    return this.lastActivity.get(agentName) ?? 0;
  }

  /**
   * Record activity for an agent (call this when a tool is executed).
   */
  recordActivity(agentName: string): void {
    this.lastActivity.set(agentName, Date.now());
  }

  listActive(): string[] {
    return [...this.clients.keys()];
  }

  /**
   * Save all active credentials to disk and SQL so they survive proxy restarts.
   * Encrypts passwords before storing.
   */
  persistSessions(): void {
    const entries: PersistedSession[] = [];
    for (const [agentName, client] of this.clients) {
      const creds = client.getCredentials();
      if (creds) {
        entries.push({ agentName, credentials: creds });
      }
    }
    // Write to file (primary fallback, encrypted)
    if (this.persistPath) {
      try {
        mkdirSync(dirname(this.persistPath), { recursive: true });
        const secret = getEncryptionSecret();
        const encryptedEntries = entries.map((e) => ({
          agentName: e.agentName,
          credentials: {
            username: e.credentials.username,
            password: encrypt(e.credentials.password, secret),
          },
        }));
        writeFileSync(this.persistPath, JSON.stringify(encryptedEntries, null, 2));
      } catch (err) {
        log.error(`Failed to persist sessions to file: ${err}`);
      }
    }
    // Write to SQLite (atomic clear-and-rewrite in a transaction, encrypted)
    // Skip if database not initialized (e.g., during test cleanup)
    try {
      const db = getDbIfInitialized();
      if (db) {
        const secret = getEncryptionSecret();
        const upsert = db.prepare(
          "INSERT OR REPLACE INTO proxy_sessions (agent, username, password, updated_at) VALUES (?, ?, ?, datetime('now'))"
        );
        const saveAll = db.transaction((ents: PersistedSession[]) => {
          db.prepare('DELETE FROM proxy_sessions').run();
          for (const entry of ents) {
            const encryptedPassword = encrypt(entry.credentials.password, secret);
            upsert.run(entry.agentName, entry.credentials.username, encryptedPassword);
          }
        });
        saveAll(entries);
      }
    } catch (err) {
      log.error(`Failed to persist sessions to SQL: ${(err as Error).message ?? err}`);
    }
  }

  /**
   * Restore credentials from SQL (fleet-web) or file fallback.
   * Creates GameClients and injects persisted credentials so agents
   * can reconnect on next command.
   * Auto-migrates plaintext passwords to encrypted storage.
   */
  async restoreSessions(): Promise<number> {
    let entries: PersistedSession[] = [];
    let needsMigration = false;
    const secret = getEncryptionSecret();

    function decryptPassword(raw: string, label: string): string {
      if (isEncrypted(raw)) {
        try {
          return decrypt(raw, secret);
        } catch {
          log.warn(`Failed to decrypt password for ${label} — using plaintext fallback`);
          return raw;
        }
      }
      if (raw) needsMigration = true;
      return raw;
    }

    // Try SQLite first
    try {
      const db = getDbIfInitialized();
      if (db) {
        const rows = db.prepare('SELECT agent, username, password FROM proxy_sessions').all() as Array<{
          agent: string;
          username: string;
          password: string;
        }>;
        entries = rows.map((r) => ({
          agentName: r.agent,
          credentials: { username: r.username, password: decryptPassword(r.password, r.agent) },
        }));
        if (entries.length > 0) {
          log.info(`Restored ${entries.length} session(s) from SQL`);
        }
      }
    } catch {
      // Database not initialized or table missing — fall through to file
    }

    // Fall back to file
    if (entries.length === 0 && this.persistPath) {
      try {
        const raw = readFileSync(this.persistPath, "utf-8");
        entries = JSON.parse(raw) as PersistedSession[];
        entries = entries.map((e) => ({
          agentName: e.agentName,
          credentials: { username: e.credentials.username, password: decryptPassword(e.credentials.password, e.agentName) },
        }));
        if (entries.length > 0) {
          log.info(`Restored ${entries.length} session(s) from file fallback`);
        }
      } catch {
        // File doesn't exist or is invalid
      }
    }

    let restored = 0;
    const mockMode = this.config.mockMode;
    for (const entry of entries) {
      const agentConfig = this.agentMap.get(entry.agentName);
      if (!agentConfig) continue;
      if (this.clients.has(entry.agentName)) continue;

      let client: GameTransport | MockGameClient;
      if (mockMode?.enabled) {
        client = new MockGameClient(mockMode);
      } else {
          client = createGameClient(
          this.config.gameMcpUrl,
          this.serverMetrics,
          agentConfig.socksPort,
        );
        if (this.config.credentialsPath) {
          client.credentialsPath = this.config.credentialsPath;
        }
      }
      client.label = entry.agentName;
      this.breakerRegistry.register(entry.agentName, client.breaker);
      client.restoreCredentials(entry.credentials);
      this.clients.set(entry.agentName, client);
      log.info(`Restored credentials for ${entry.agentName}`);
      restored++;
    }

    // Trigger re-persistence if migration occurred (encrypts plaintext passwords)
    if (needsMigration && entries.length > 0) {
      log.warn(`⚠ Migrating ${entries.length} plaintext credential(s) to encrypted storage`);
      this.persistSessions();
    }

    return restored;
  }

  async logoutAll(timeoutMs = 5_000, staleThresholdMs = STALE_SESSION_THRESHOLD_MS): Promise<void> {
    const names = this.listActive();
    const now = Date.now();

    const results = await Promise.allSettled(
      names.map(async (name) => {
        const client = this.clients.get(name);
        if (!client) return;

        const lastSeen = this.lastActivity.get(name) ?? 0;
        const idleMs = now - lastSeen;
        const isStale = lastSeen === 0 || idleMs > staleThresholdMs;

        if (isStale && client.getCredentials()) {
          const idleSec = lastSeen === 0 ? "never" : `${Math.round(idleMs / 1000)}s`;
          log.info(`Skipping logout for stale session ${name} (last activity: ${idleSec} ago)`);
          // Skip logout attempt — just close the transport
          await client.close().catch(() => {});
          this.clients.delete(name);
          return;
        }

        try {
          if (client.getCredentials()) {
            const logoutTimeout = new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("logout timeout")), timeoutMs),
            );
            await Promise.race([client.logout(), logoutTimeout]);
          }
        } catch (err) {
          log.warn(`Logout skipped for ${name}: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          await client.close().catch(() => {});
          this.clients.delete(name);
          this.lastActivity.delete(name);
        }
      }),
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        log.error(`Failed to logout ${names[i]}: ${(results[i] as PromiseRejectedResult).reason}`);
      } else {
        log.info(`Logged out ${names[i]}`);
      }
    }
    this.persistSessions(); // Clear the persisted file after full logout

    // Release pool accounts on shutdown if configured
    const pool = this.getAccountPool();
    if (pool?.releaseOnShutdown) {
      pool.releaseAll();
      log.info("Account pool: released all assignments on shutdown");
    }
  }
}
