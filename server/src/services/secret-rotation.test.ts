/**
 * Tests for secret rotation orchestration.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  getEncryptionSecret,
  setCachedSecret,
  setPreviousSecret,
  getPreviousSecret,
  decryptWithFallback,
  setSecretPathsForTesting,
  getSecretPath,
  getPrevSecretPath,
  resetCachedSecrets,
} from "./crypto.js";
import { rotateSecret } from "./secret-rotation.js";

// ---------------------------------------------------------------------------
// setCachedSecret / setPreviousSecret
// ---------------------------------------------------------------------------

describe("setCachedSecret", () => {
  beforeEach(() => {
    resetCachedSecrets();
  });

  afterEach(() => {
    resetCachedSecrets();
  });

  it("updates what getEncryptionSecret() returns", () => {
    const newSecret = randomBytes(32).toString("hex");
    setCachedSecret(newSecret);
    expect(getEncryptionSecret()).toBe(newSecret);
  });

  it("new secret can encrypt and decrypt", () => {
    const newSecret = randomBytes(32).toString("hex");
    setCachedSecret(newSecret);
    const secret = getEncryptionSecret();
    const ciphertext = encrypt("test-data", secret);
    expect(decrypt(ciphertext, secret)).toBe("test-data");
  });
});

describe("setPreviousSecret / getPreviousSecret", () => {
  afterEach(() => {
    setPreviousSecret(null);
  });

  it("stores and retrieves previous secret", () => {
    setPreviousSecret("old-secret-123");
    expect(getPreviousSecret()).toBe("old-secret-123");
  });

  it("can be cleared with null", () => {
    setPreviousSecret("something");
    setPreviousSecret(null);
    expect(getPreviousSecret()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decryptWithFallback
// ---------------------------------------------------------------------------

describe("decryptWithFallback", () => {
  beforeEach(() => {
    resetCachedSecrets();
  });

  afterEach(() => {
    resetCachedSecrets();
  });

  it("decrypts with current secret", () => {
    const originalSecret = getEncryptionSecret();
    const ciphertext = encrypt("hello", originalSecret);
    expect(decryptWithFallback(ciphertext)).toBe("hello");
  });

  it("falls back to previous secret when current fails", () => {
    const oldSecret = "old-secret-for-fallback-test";
    const ciphertext = encrypt("sensitive", oldSecret);

    // Set a new current secret (can't decrypt old ciphertext)
    const newSecret = randomBytes(32).toString("hex");
    setCachedSecret(newSecret);
    setPreviousSecret(oldSecret);

    expect(decryptWithFallback(ciphertext)).toBe("sensitive");
  });

  it("throws when both current and previous fail", () => {
    const unrelatedSecret = "completely-unrelated-secret";
    const ciphertext = encrypt("data", unrelatedSecret);

    setCachedSecret(randomBytes(32).toString("hex"));
    setPreviousSecret("also-wrong-secret");

    expect(() => decryptWithFallback(ciphertext)).toThrow("Failed to decrypt");
  });

  it("throws when no previous secret and current fails", () => {
    const otherSecret = "some-other-secret-value";
    const ciphertext = encrypt("data", otherSecret);

    setCachedSecret(randomBytes(32).toString("hex"));
    setPreviousSecret(null);

    expect(() => decryptWithFallback(ciphertext)).toThrow("Failed to decrypt");
  });
});

// ---------------------------------------------------------------------------
// rotateSecret — integration
// ---------------------------------------------------------------------------

describe("rotateSecret", () => {
  const originalSecret = getEncryptionSecret();

  // Mock session manager
  function createMockSessionManager(opts: { activeCount?: number; hasPool?: boolean; poolAccounts?: number } = {}) {
    let persistCalled = false;
    let poolPersistCalled = false;

    const pool = opts.hasPool ? {
      persist: () => { poolPersistCalled = true; },
      listAccounts: () => Array(opts.poolAccounts ?? 0).fill({ id: "test" }),
    } : null;

    return {
      mock: {
        persistSessions: () => { persistCalled = true; },
        listActive: () => Array(opts.activeCount ?? 0).fill("agent"),
        getPoolInstance: () => pool,
        get persistCalled() { return persistCalled; },
        get poolPersistCalled() { return poolPersistCalled; },
      } as any,
      wasPersistCalled: () => persistCalled,
      wasPoolPersistCalled: () => poolPersistCalled,
    };
  }

  let testTempDir: string;

  beforeEach(() => {
    // Create temporary directory for test files
    testTempDir = join(tmpdir(), `gantry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testTempDir, { recursive: true });
    const testSecretPath = join(testTempDir, ".gantry-secret");
    const testPrevSecretPath = join(testTempDir, ".gantry-secret.prev");
    setSecretPathsForTesting(testSecretPath, testPrevSecretPath);
  });

  afterEach(() => {
    resetCachedSecrets();
    // Clean up test temp directory
    try {
      const testSecretPath = getSecretPath();
      const testPrevSecretPath = getPrevSecretPath();
      if (existsSync(testSecretPath)) unlinkSync(testSecretPath);
      if (existsSync(testPrevSecretPath)) unlinkSync(testPrevSecretPath);
      const tmpFile = testSecretPath + ".tmp";
      if (existsSync(tmpFile)) unlinkSync(tmpFile);
      rmSync(testTempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("generates a new secret different from the old one", () => {
    const { mock } = createMockSessionManager();
    const oldSecret = getEncryptionSecret();
    rotateSecret(mock);
    expect(getEncryptionSecret()).not.toBe(oldSecret);
  });

  it("new secret is 64-char hex", () => {
    const { mock } = createMockSessionManager();
    rotateSecret(mock);
    expect(getEncryptionSecret()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("calls persistSessions on session manager", () => {
    const { mock, wasPersistCalled } = createMockSessionManager({ activeCount: 3 });
    rotateSecret(mock);
    expect(wasPersistCalled()).toBe(true);
  });

  it("calls persist on account pool when present", () => {
    const { mock, wasPoolPersistCalled } = createMockSessionManager({ hasPool: true, poolAccounts: 2 });
    rotateSecret(mock);
    expect(wasPoolPersistCalled()).toBe(true);
  });

  it("succeeds without account pool", () => {
    const { mock } = createMockSessionManager({ hasPool: false });
    const result = rotateSecret(mock);
    expect(result.accountsRotated).toBe(0);
  });

  it("returns correct rotation stats", () => {
    const { mock } = createMockSessionManager({ activeCount: 3, hasPool: true, poolAccounts: 5 });
    const result = rotateSecret(mock);
    expect(result.sessionsRotated).toBe(3);
    expect(result.accountsRotated).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sets previous secret for fallback", () => {
    const oldSecret = getEncryptionSecret();
    const { mock } = createMockSessionManager();
    rotateSecret(mock);
    expect(getPreviousSecret()).toBe(oldSecret);
  });

  it("cleans up .gantry-secret.prev after success", () => {
    const { mock } = createMockSessionManager();
    rotateSecret(mock);
    expect(existsSync(getPrevSecretPath())).toBe(false);
  });

  it("data encrypted with old secret is decryptable via fallback after rotation", () => {
    const oldSecret = getEncryptionSecret();
    const ciphertext = encrypt("my-password", oldSecret);

    const { mock } = createMockSessionManager();
    rotateSecret(mock);

    // Current secret can't decrypt old data
    expect(() => decrypt(ciphertext, getEncryptionSecret())).toThrow();

    // But fallback can
    expect(decryptWithFallback(ciphertext)).toBe("my-password");
  });

  it("data encrypted with new secret is decryptable", () => {
    const { mock } = createMockSessionManager();
    rotateSecret(mock);

    const newSecret = getEncryptionSecret();
    const ciphertext = encrypt("new-data", newSecret);
    expect(decrypt(ciphertext, newSecret)).toBe("new-data");
  });

  it("writes new secret to file", () => {
    const { mock } = createMockSessionManager();
    rotateSecret(mock);
    const fileSecret = readFileSync(getSecretPath(), "utf-8").trim();
    expect(fileSecret).toBe(getEncryptionSecret());
  });
});
