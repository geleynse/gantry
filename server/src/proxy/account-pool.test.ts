/**
 * Tests for AccountPool — centralized game account credential management.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountPool } from "./account-pool.js";
import type { AccountPoolFile } from "../shared/types/account-pool.js";

// Minimal fixture that covers all status values
function makePoolFile(overrides?: Partial<AccountPoolFile>): AccountPoolFile {
  return {
    accounts: [
      {
        id: "acct-001",
        username: "pilot-alpha",
        password: "secret-alpha",
        status: "available",
        assignedTo: null,
        assignedAt: null,
        faction: "solarian",
        notes: "Primary account",
      },
      {
        id: "acct-002",
        username: "pilot-bravo",
        password: "secret-bravo",
        status: "assigned",
        assignedTo: "existing-agent",
        assignedAt: "2026-02-25T10:00:00Z",
        faction: "crimson",
      },
      {
        id: "acct-003",
        username: "pilot-charlie",
        password: "secret-charlie",
        status: "disabled",
        assignedTo: null,
        assignedAt: null,
        faction: "nebula",
      },
      {
        id: "acct-004",
        username: "pilot-delta",
        password: "secret-delta",
        status: "available",
        assignedTo: null,
        assignedAt: null,
        faction: "crimson",
      },
    ],
    config: {
      autoAssign: true,
      matchFaction: true,
      releaseOnShutdown: false,
      maxAssignmentsPerAccount: 1,
    },
    ...overrides,
  };
}

// Write a pool file and return its path
function writePool(data: AccountPoolFile, suffix = ""): string {
  const path = join(tmpdir(), `account-pool-test${suffix}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

describe("AccountPool", () => {
  const paths: string[] = [];

  function makePool(overrides?: Partial<AccountPoolFile>): { pool: AccountPool; path: string } {
    const path = writePool(makePoolFile(overrides));
    paths.push(path);
    return { pool: new AccountPool(path), path };
  }

  afterEach(() => {
    for (const p of paths) {
      if (existsSync(p)) unlinkSync(p);
    }
    paths.length = 0;
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  it("loads accounts from JSON file", () => {
    const { pool } = makePool();
    const accounts = pool.listAccounts();
    expect(accounts).toHaveLength(4);
  });

  it("throws if pool file does not exist", () => {
    expect(() => new AccountPool("/nonexistent/path/pool.json")).toThrow("Pool file not found");
  });

  it("throws if pool file has invalid JSON", () => {
    const path = join(tmpdir(), `bad-pool-${Date.now()}.json`);
    paths.push(path);
    writeFileSync(path, "NOT JSON");
    expect(() => new AccountPool(path)).toThrow();
  });

  it("throws if accounts array is missing", () => {
    const path = join(tmpdir(), `empty-pool-${Date.now()}.json`);
    paths.push(path);
    writeFileSync(path, JSON.stringify({ config: {} }));
    expect(() => new AccountPool(path)).toThrow('must have an "accounts" array');
  });

  it("throws if an account is missing username", () => {
    const path = join(tmpdir(), `missing-un-pool-${Date.now()}.json`);
    paths.push(path);
    writeFileSync(path, JSON.stringify({
      accounts: [{ password: "pw", status: "available", assignedTo: null, assignedAt: null }],
    }));
    expect(() => new AccountPool(path)).toThrow('missing "username"');
  });

  it("throws if an account is missing password", () => {
    const path = join(tmpdir(), `missing-pw-pool-${Date.now()}.json`);
    paths.push(path);
    writeFileSync(path, JSON.stringify({
      accounts: [{ username: "user", status: "available", assignedTo: null, assignedAt: null }],
    }));
    expect(() => new AccountPool(path)).toThrow('missing "password"');
  });

  it("normalizes unknown status to 'available'", () => {
    const path = join(tmpdir(), `bad-status-pool-${Date.now()}.json`);
    paths.push(path);
    writeFileSync(path, JSON.stringify({
      accounts: [{ username: "user", password: "pw", status: "unknown_status", assignedTo: null, assignedAt: null }],
    }));
    const pool = new AccountPool(path);
    expect(pool.listAccounts()[0].status).toBe("available");
  });

  // -----------------------------------------------------------------------
  // listAccounts — no password leakage
  // -----------------------------------------------------------------------

  it("listAccounts does not expose passwords", () => {
    const { pool } = makePool();
    const accounts = pool.listAccounts();
    for (const a of accounts) {
      expect(a).not.toHaveProperty("password");
    }
  });

  it("listAccounts returns all fields including status and assignedTo", () => {
    const { pool } = makePool();
    const accounts = pool.listAccounts();
    const bravo = accounts.find((a) => a.username === "pilot-bravo");
    expect(bravo).toBeDefined();
    expect(bravo!.status).toBe("assigned");
    expect(bravo!.assignedTo).toBe("existing-agent");
  });

  // -----------------------------------------------------------------------
  // assignAccount — auto-assign
  // -----------------------------------------------------------------------

  it("assignAccount returns an available account", () => {
    const { pool } = makePool();
    const account = pool.assignAccount("new-agent");
    expect(account).not.toBeNull();
    expect(account!.status).toBe("assigned");
    expect(account!.assignedTo).toBe("new-agent");
  });

  it("assignAccount prefers faction-matching account when matchFaction is true", () => {
    const { pool } = makePool();
    // crimson faction — should prefer pilot-delta (acct-004) over pilot-alpha (solarian)
    const account = pool.assignAccount("crimson-agent", "crimson");
    expect(account).not.toBeNull();
    expect(account!.username).toBe("pilot-delta");
  });

  it("assignAccount falls back to first available if no faction match", () => {
    const { pool } = makePool();
    const account = pool.assignAccount("outerrim-agent", "outerrim");
    expect(account).not.toBeNull();
    // pilot-alpha is first available
    expect(account!.username).toBe("pilot-alpha");
  });

  it("assignAccount returns existing assignment if agent already has one", () => {
    const { pool } = makePool();
    const first = pool.assignAccount("new-agent");
    const second = pool.assignAccount("new-agent");
    expect(first!.username).toBe(second!.username);
  });

  it("assignAccount returns null when no accounts are available", () => {
    const { pool } = makePool({
      accounts: [
        {
          id: "a",
          username: "taken",
          password: "pw",
          status: "assigned",
          assignedTo: "other-agent",
          assignedAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "b",
          username: "disabled",
          password: "pw",
          status: "disabled",
          assignedTo: null,
          assignedAt: null,
        },
      ],
    });
    const result = pool.assignAccount("new-agent");
    expect(result).toBeNull();
  });

  it("assignAccount persists the assignment to file", () => {
    const { pool, path } = makePool();
    pool.assignAccount("persist-agent");
    const reloaded = new AccountPool(path);
    const creds = reloaded.getCredentials("persist-agent");
    expect(creds).not.toBeNull();
    expect(creds!.username).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // assignAccountTo — explicit assignment
  // -----------------------------------------------------------------------

  it("assignAccountTo assigns a specific account to an agent", () => {
    const { pool } = makePool();
    const ok = pool.assignAccountTo("my-agent", "pilot-alpha");
    expect(ok).toBe(true);
    const creds = pool.getCredentials("my-agent");
    expect(creds).not.toBeNull();
    expect(creds!.username).toBe("pilot-alpha");
  });

  it("assignAccountTo returns false for unknown username", () => {
    const { pool } = makePool();
    const ok = pool.assignAccountTo("my-agent", "nonexistent-user");
    expect(ok).toBe(false);
  });

  it("assignAccountTo returns false for disabled account", () => {
    const { pool } = makePool();
    const ok = pool.assignAccountTo("my-agent", "pilot-charlie");
    expect(ok).toBe(false);
  });

  it("assignAccountTo returns true if already assigned to same agent (idempotent)", () => {
    const { pool } = makePool();
    pool.assignAccountTo("my-agent", "pilot-alpha");
    const ok = pool.assignAccountTo("my-agent", "pilot-alpha");
    expect(ok).toBe(true);
  });

  // -----------------------------------------------------------------------
  // releaseAccount
  // -----------------------------------------------------------------------

  it("releaseAccount marks assigned account as available", () => {
    const { pool } = makePool();
    pool.releaseAccount("existing-agent");
    const accounts = pool.listAccounts();
    const bravo = accounts.find((a) => a.username === "pilot-bravo");
    expect(bravo!.status).toBe("available");
    expect(bravo!.assignedTo).toBeNull();
  });

  it("releaseAccount is a no-op for agents with no assignment", () => {
    const { pool } = makePool();
    // Should not throw
    expect(() => pool.releaseAccount("nobody")).not.toThrow();
  });

  it("releaseAccount persists the change", () => {
    const { pool, path } = makePool();
    pool.releaseAccount("existing-agent");
    const reloaded = new AccountPool(path);
    const creds = reloaded.getCredentials("existing-agent");
    expect(creds).toBeNull();
  });

  // -----------------------------------------------------------------------
  // releaseAll
  // -----------------------------------------------------------------------

  it("releaseAll clears all assigned accounts", () => {
    const { pool } = makePool();
    pool.assignAccount("agent-x");
    pool.releaseAll();
    const accounts = pool.listAccounts();
    const assigned = accounts.filter((a) => a.status === "assigned");
    expect(assigned).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // getCredentials
  // -----------------------------------------------------------------------

  it("getCredentials returns username and password for assigned agent", () => {
    const { pool } = makePool();
    const creds = pool.getCredentials("existing-agent");
    expect(creds).not.toBeNull();
    expect(creds!.username).toBe("pilot-bravo");
    expect(creds!.password).toBe("secret-bravo");
  });

  it("getCredentials returns null for unassigned agent", () => {
    const { pool } = makePool();
    const creds = pool.getCredentials("unassigned-agent");
    expect(creds).toBeNull();
  });

  // -----------------------------------------------------------------------
  // recordLogin
  // -----------------------------------------------------------------------

  it("recordLogin updates lastLogin for assigned agent", () => {
    const { pool, path } = makePool();
    pool.recordLogin("existing-agent");
    const reloaded = new AccountPool(path);
    const accounts = reloaded.listAccounts();
    const bravo = accounts.find((a) => a.username === "pilot-bravo");
    expect(bravo!.lastLogin).toBeTruthy();
    // Should be an ISO timestamp
    expect(new Date(bravo!.lastLogin!).getTime()).not.toBeNaN();
  });

  it("recordLogin is a no-op for unassigned agent", () => {
    const { pool } = makePool();
    // Should not throw
    expect(() => pool.recordLogin("nobody")).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // autoAssign / config accessors
  // -----------------------------------------------------------------------

  it("autoAssign returns true from config", () => {
    const { pool } = makePool();
    expect(pool.autoAssign).toBe(true);
  });

  it("autoAssign returns false when configured off", () => {
    const { pool } = makePool({ config: { autoAssign: false } });
    expect(pool.autoAssign).toBe(false);
  });

  it("releaseOnShutdown returns false from config", () => {
    const { pool } = makePool();
    expect(pool.releaseOnShutdown).toBe(false);
  });

  it("getPoolConfig returns pool config object", () => {
    const { pool } = makePool();
    const cfg = pool.getPoolConfig();
    expect(cfg.autoAssign).toBe(true);
    expect(cfg.matchFaction).toBe(true);
  });

  // -----------------------------------------------------------------------
  // reload
  // -----------------------------------------------------------------------

  it("reload picks up changes from disk", () => {
    const { pool, path } = makePool();
    // Assign agent, verify
    pool.assignAccount("reload-agent");
    expect(pool.getCredentials("reload-agent")).not.toBeNull();

    // Write a fresh pool file with different content
    const newData = makePoolFile();
    writeFileSync(path, JSON.stringify(newData, null, 2));

    pool.reload();
    // reload-agent's assignment was on the old state; fresh pool has no assignment
    expect(pool.getCredentials("reload-agent")).toBeNull();
  });
});

// -----------------------------------------------------------------------
// SessionManager integration
// -----------------------------------------------------------------------

import { SessionManager } from "./session-manager.js";
import { BreakerRegistry } from "./circuit-breaker.js";
import { MetricsWindow } from "./instability-metrics.js";

describe("SessionManager + AccountPool", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const p of paths) {
      if (existsSync(p)) unlinkSync(p);
    }
    paths.length = 0;
  });

  it("getCredentialsFromPool returns null when no pool is configured", async () => {
    const config = {
      agents: [{ name: "my-agent" }],
      gameUrl: "https://game.spacemolt.com/mcp",
      gameApiUrl: "https://game.spacemolt.com/api/v1",
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 90,
      staggerDelay: 20,
    };
    const mgr = new SessionManager(config, new BreakerRegistry(), new MetricsWindow());
    expect(mgr.getCredentialsFromPool("my-agent")).toBeNull();
  });

  it("getCredentialsFromPool returns pool credentials when pool is configured", async () => {
    const poolData = makePoolFile();
    // Pre-assign the account so it's immediately available
    poolData.accounts[0].status = "available";
    const poolPath = writePool(poolData);
    paths.push(poolPath);

    const config = {
      agents: [{ name: "my-agent", faction: "solarian" }],
      gameUrl: "https://game.spacemolt.com/mcp",
      gameApiUrl: "https://game.spacemolt.com/api/v1",
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 90,
      staggerDelay: 20,
      accountPool: { poolFile: poolPath },
    };
    const mgr = new SessionManager(config, new BreakerRegistry(), new MetricsWindow());
    const creds = mgr.getCredentialsFromPool("my-agent");
    expect(creds).not.toBeNull();
    expect(creds!.username).toBeTruthy();
    expect(creds!.password).toBeTruthy();
  });

  it("getCredentialsFromPool returns null when autoAssign is false and no prior assignment", async () => {
    const poolData = makePoolFile({ config: { autoAssign: false } });
    const poolPath = writePool(poolData);
    paths.push(poolPath);

    const config = {
      agents: [{ name: "new-agent" }],
      gameUrl: "https://game.spacemolt.com/mcp",
      gameApiUrl: "https://game.spacemolt.com/api/v1",
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 90,
      staggerDelay: 20,
      accountPool: { poolFile: poolPath },
    };
    const mgr = new SessionManager(config, new BreakerRegistry(), new MetricsWindow());
    const creds = mgr.getCredentialsFromPool("new-agent");
    expect(creds).toBeNull();
  });

  it("getPoolInstance returns null when no pool configured", async () => {
    const config = {
      agents: [{ name: "my-agent" }],
      gameUrl: "https://game.spacemolt.com/mcp",
      gameApiUrl: "https://game.spacemolt.com/api/v1",
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 90,
      staggerDelay: 20,
    };
    const mgr = new SessionManager(config, new BreakerRegistry(), new MetricsWindow());
    expect(mgr.getPoolInstance()).toBeNull();
  });

  it("getPoolInstance returns AccountPool when configured", async () => {
    const poolPath = writePool(makePoolFile());
    paths.push(poolPath);

    const config = {
      agents: [{ name: "my-agent" }],
      gameUrl: "https://game.spacemolt.com/mcp",
      gameApiUrl: "https://game.spacemolt.com/api/v1",
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 90,
      staggerDelay: 20,
      accountPool: { poolFile: poolPath },
    };
    const mgr = new SessionManager(config, new BreakerRegistry(), new MetricsWindow());
    const instance = mgr.getPoolInstance();
    expect(instance).not.toBeNull();
    expect(instance).toBeInstanceOf(AccountPool);
  });
});
