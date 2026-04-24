/**
 * Tests for credentials-crypto.ts — fleet credential encryption at rest.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { setSecretPathsForTesting, resetCachedSecrets } from "./crypto.js";
import {
  encryptCredentials,
  decryptCredentials,
  encryptPassword,
  decryptPassword,
  migrateCredentialsIfNeeded,
  getCredentialsFilePath,
  validateCredentials,
  validateCredentialForAgent,
  validateAllCredentials,
  type RawCredentialsFile,
  type ValidationGameClient,
} from "./credentials-crypto.js";
import { getEncryptionSecret } from "./crypto.js";

const TMP_DIR = join(import.meta.dir, "tmp-creds-crypto-test");

function setupTmpDir() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  // Wire crypto to use tmp dir for secret persistence
  setSecretPathsForTesting(
    join(TMP_DIR, ".gantry-secret"),
    join(TMP_DIR, ".gantry-secret.prev"),
  );
}

function teardownTmpDir() {
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  resetCachedSecrets();
}

describe("credentials-crypto", () => {
  beforeEach(setupTmpDir);
  afterEach(teardownTmpDir);

  // -------------------------------------------------------------------------
  // encryptPassword / decryptPassword
  // -------------------------------------------------------------------------

  it("encryptPassword produces enc: prefix", () => {
    const enc = encryptPassword("hunter2");
    expect(enc).toMatch(/^enc:/);
  });

  it("encryptPassword is idempotent — already-encrypted values unchanged", () => {
    const enc = encryptPassword("hunter2");
    const enc2 = encryptPassword(enc);
    expect(enc2).toBe(enc);
  });

  it("decryptPassword roundtrips correctly", () => {
    const enc = encryptPassword("supersecret");
    expect(decryptPassword(enc)).toBe("supersecret");
  });

  it("decryptPassword returns plaintext as-is (no enc: prefix)", () => {
    expect(decryptPassword("plaintext-pass")).toBe("plaintext-pass");
  });

  // -------------------------------------------------------------------------
  // encryptCredentials / decryptCredentials
  // -------------------------------------------------------------------------

  it("encryptCredentials encrypts all passwords, leaves usernames plain", () => {
    const raw: RawCredentialsFile = {
      "drifter-gale": { username: "drifter", password: "pw1" },
      "sable-thorn": { username: "sable", password: "pw2" },
    };
    const secret = "test-secret-abc";
    const enc = encryptCredentials(raw, secret);

    expect(enc["drifter-gale"].username).toBe("drifter");
    expect(enc["drifter-gale"].password).toMatch(/^enc:/);
    expect(enc["sable-thorn"].username).toBe("sable");
    expect(enc["sable-thorn"].password).toMatch(/^enc:/);
  });

  it("encryptCredentials skips already-encrypted passwords", () => {
    const enc1 = encryptPassword("original");
    const raw: RawCredentialsFile = {
      "rust-vane": { username: "rust", password: enc1 },
    };
    const secret = "doesn't matter";
    const enc2 = encryptCredentials(raw, secret);
    // Should be unchanged — already has enc: prefix
    expect(enc2["rust-vane"].password).toBe(enc1);
  });

  it("decryptCredentials roundtrip: encrypt then decrypt returns originals", () => {
    const raw: RawCredentialsFile = {
      "lumen-shoal": { username: "lumen", password: "secret123" },
      "cinder-wake": { username: "cinder", password: "abc!xyz" },
    };
    // Use the actual secret so decryptWithFallback can find it
    const secret = getEncryptionSecret();
    const encrypted = encryptCredentials(raw, secret);
    const decrypted = decryptCredentials(encrypted);

    expect(decrypted["lumen-shoal"].password).toBe("secret123");
    expect(decrypted["cinder-wake"].password).toBe("abc!xyz");
    expect(decrypted["lumen-shoal"].username).toBe("lumen");
  });

  it("decryptCredentials leaves plaintext passwords as-is (legacy fallback)", () => {
    const raw: RawCredentialsFile = {
      "old-agent": { username: "old", password: "legacyplaintext" },
    };
    const decrypted = decryptCredentials(raw);
    expect(decrypted["old-agent"].password).toBe("legacyplaintext");
  });

  // -------------------------------------------------------------------------
  // migrateCredentialsIfNeeded
  // -------------------------------------------------------------------------

  it("migrates fleet-credentials.json → fleet-credentials.enc.json", () => {
    const src = join(TMP_DIR, "fleet-credentials.json");
    const dst = join(TMP_DIR, "fleet-credentials.enc.json");
    const bak = join(TMP_DIR, "fleet-credentials.json.bak");

    const original: RawCredentialsFile = {
      "drifter-gale": { username: "drifter", password: "plainpass" },
    };
    writeFileSync(src, JSON.stringify(original));

    const migrated = migrateCredentialsIfNeeded(TMP_DIR);
    expect(migrated).toBe(true);

    // Original should be gone (renamed to .bak)
    expect(existsSync(src)).toBe(false);
    expect(existsSync(bak)).toBe(true);
    // Encrypted file should exist
    expect(existsSync(dst)).toBe(true);

    const enc = JSON.parse(readFileSync(dst, "utf-8")) as RawCredentialsFile;
    expect(enc["drifter-gale"].username).toBe("drifter");
    expect(enc["drifter-gale"].password).toMatch(/^enc:/);
    // Verify the encrypted password decrypts to original
    expect(decryptPassword(enc["drifter-gale"].password)).toBe("plainpass");
  });

  it("skips migration if enc file already exists", () => {
    const src = join(TMP_DIR, "fleet-credentials.json");
    const dst = join(TMP_DIR, "fleet-credentials.enc.json");

    writeFileSync(src, JSON.stringify({ agent: { username: "u", password: "p" } }));
    writeFileSync(dst, JSON.stringify({}));

    const migrated = migrateCredentialsIfNeeded(TMP_DIR);
    expect(migrated).toBe(false);
    // Source file should still be there
    expect(existsSync(src)).toBe(true);
  });

  it("skips migration if source file does not exist", () => {
    const migrated = migrateCredentialsIfNeeded(TMP_DIR);
    expect(migrated).toBe(false);
  });

  it("handles multiple agents in migration", () => {
    const src = join(TMP_DIR, "fleet-credentials.json");
    const dst = join(TMP_DIR, "fleet-credentials.enc.json");

    const original: RawCredentialsFile = {
      "agent-a": { username: "ua", password: "pa" },
      "agent-b": { username: "ub", password: "pb" },
      "agent-c": { username: "uc", password: "pc" },
    };
    writeFileSync(src, JSON.stringify(original));

    migrateCredentialsIfNeeded(TMP_DIR);

    const enc = JSON.parse(readFileSync(dst, "utf-8")) as RawCredentialsFile;
    for (const [agent, entry] of Object.entries(enc)) {
      expect(entry.password).toMatch(/^enc:/);
      const orig = original[agent];
      expect(decryptPassword(entry.password)).toBe(orig.password);
    }
  });

  // -------------------------------------------------------------------------
  // getCredentialsFilePath
  // -------------------------------------------------------------------------

  it("returns enc file path when it exists", () => {
    const enc = join(TMP_DIR, "fleet-credentials.enc.json");
    writeFileSync(enc, "{}");
    expect(getCredentialsFilePath(TMP_DIR)).toBe(enc);
  });

  it("returns plain file path when enc does not exist", () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    expect(getCredentialsFilePath(TMP_DIR)).toBe(plain);
  });

  it("prefers enc over plain when both exist", () => {
    const enc = join(TMP_DIR, "fleet-credentials.enc.json");
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(enc, "{}");
    writeFileSync(plain, "{}");
    expect(getCredentialsFilePath(TMP_DIR)).toBe(enc);
  });

  it("re-encrypts when plaintext file is newer than enc file", () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    const enc = join(TMP_DIR, "fleet-credentials.enc.json");

    // Write and encrypt the original credentials
    const original: RawCredentialsFile = {
      "agent-a": { username: "alice", password: "old-password" },
    };
    writeFileSync(plain, JSON.stringify(original));
    migrateCredentialsIfNeeded(TMP_DIR);
    // At this point: plain is gone (renamed .bak), enc exists

    // Restore plain with updated credentials (simulating a manual edit)
    const updated: RawCredentialsFile = {
      "agent-a": { username: "alice", password: "new-password" },
    };
    writeFileSync(plain, JSON.stringify(updated));

    // Make plain appear 10 seconds newer than enc
    const encStat = require("node:fs").statSync(enc);
    const futureTime = new Date(encStat.mtimeMs + 10_000);
    utimesSync(plain, futureTime, futureTime);

    // getCredentialsFilePath should detect the newer plain file and re-encrypt
    const result = getCredentialsFilePath(TMP_DIR);
    expect(result).toBe(enc);

    // The enc file should now contain the updated credentials
    const encContents = JSON.parse(readFileSync(enc, "utf-8")) as RawCredentialsFile;
    expect(decryptPassword(encContents["agent-a"].password)).toBe("new-password");
  });

  it("does not re-encrypt when enc file is newer than plaintext", () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    const enc = join(TMP_DIR, "fleet-credentials.enc.json");

    const creds: RawCredentialsFile = {
      "agent-a": { username: "alice", password: "pass" },
    };
    writeFileSync(plain, JSON.stringify(creds));
    migrateCredentialsIfNeeded(TMP_DIR);

    // Restore plain, but make it older than enc
    writeFileSync(plain, JSON.stringify(creds));
    const encStat = require("node:fs").statSync(enc);
    const pastTime = new Date(encStat.mtimeMs - 10_000);
    utimesSync(plain, pastTime, pastTime);

    // Read the enc content before — it should not change
    const encBefore = readFileSync(enc, "utf-8");
    getCredentialsFilePath(TMP_DIR);
    const encAfter = readFileSync(enc, "utf-8");
    expect(encAfter).toBe(encBefore);
  });

  // -------------------------------------------------------------------------
  // validateCredentials
  // -------------------------------------------------------------------------

  function makeMockClient(loginResult: { error?: { code: string } | null }): ValidationGameClient {
    return {
      label: "",
      login: async (_u: string, _p: string) => loginResult,
      logout: async () => {},
      close: async () => {},
    };
  }

  it("returns ok:true when login succeeds", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({
      "drifter-gale": { username: "drifter", password: "correct-pass" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    const result = await validateCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => makeMockClient({ error: null }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agentName).toBe("drifter-gale");
      expect(result.username).toBe("drifter");
    }
  });

  it("returns auth_failed when login returns unauthorized", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({
      "sable-thorn": { username: "sable", password: "wrong-pass" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    const result = await validateCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => makeMockClient({ error: { code: "unauthorized" } }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("auth_failed");
      expect(result.agentName).toBe("sable-thorn");
    }
  });

  it("returns auth_failed for all auth error codes", async () => {
    const authCodes = ["unauthorized", "forbidden", "invalid_credentials", "auth_failed", "login_failed", "bad_credentials"];
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({
      "test-agent": { username: "user", password: "pass" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    for (const code of authCodes) {
      const result = await validateCredentials(
        TMP_DIR,
        "http://localhost:9999/mcp",
        () => makeMockClient({ error: { code } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("auth_failed");
      }
    }
  });

  it("returns network_error when login returns a non-auth server error", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({
      "rust-vane": { username: "rust", password: "pass" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    const result = await validateCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => makeMockClient({ error: { code: "connection_failed" } }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network_error");
    }
  });

  it("returns network_error when login throws", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({
      "lumen-shoal": { username: "lumen", password: "pass" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    const throwingClient: ValidationGameClient = {
      label: "",
      login: async () => { throw new Error("ECONNREFUSED"); },
      logout: async () => {},
      close: async () => {},
    };

    const result = await validateCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => throwingClient,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("network_error");
    }
  });

  it("returns no_credentials when credentials file is missing", async () => {
    // TMP_DIR has no credentials file
    const result = await validateCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => makeMockClient({ error: null }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_credentials");
    }
  });

  it("returns no_credentials when credentials file is empty", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({}));

    const result = await validateCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => makeMockClient({ error: null }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_credentials");
    }
  });

  it("uses first agent entry from credentials file", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    // Multiple agents — should use first one
    writeFileSync(plain, JSON.stringify({
      "first-agent": { username: "first-user", password: "pass1" },
      "second-agent": { username: "second-user", password: "pass2" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    let calledWith: { username: string; password: string } | null = null;
    const captureClient: ValidationGameClient = {
      label: "",
      login: async (u: string, p: string) => {
        calledWith = { username: u, password: p };
        return { error: null };
      },
      logout: async () => {},
      close: async () => {},
    };

    const result = await validateCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => captureClient,
    );

    expect(result.ok).toBe(true);
    expect(calledWith).not.toBeNull();
    expect((calledWith as unknown as { username: string }).username).toBe("first-user");
  });

  it("validates a requested agent entry", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({
      "first-agent": { username: "first-user", password: "pass1" },
      "rust-vane": { username: "rust-user", password: "pass2" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    let calledWith: { username: string; password: string } | null = null;
    const captureClient: ValidationGameClient = {
      label: "",
      login: async (u: string, p: string) => {
        calledWith = { username: u, password: p };
        return { error: null };
      },
      logout: async () => {},
      close: async () => {},
    };

    const result = await validateCredentialForAgent(
      TMP_DIR,
      "http://localhost:9999/mcp",
      "rust-vane",
      () => captureClient,
    );

    expect(result.ok).toBe(true);
    expect(calledWith).not.toBeNull();
    expect((calledWith as unknown as { username: string }).username).toBe("rust-user");
  });

  it("validates all credential entries", async () => {
    const plain = join(TMP_DIR, "fleet-credentials.json");
    writeFileSync(plain, JSON.stringify({
      "first-agent": { username: "first-user", password: "pass1" },
      "second-agent": { username: "second-user", password: "pass2" },
    }));
    migrateCredentialsIfNeeded(TMP_DIR);

    const seen: string[] = [];
    const result = await validateAllCredentials(
      TMP_DIR,
      "http://localhost:9999/mcp",
      () => ({
        label: "",
        login: async (u: string) => {
          seen.push(u);
          return { error: null };
        },
        logout: async () => {},
        close: async () => {},
      }),
    );

    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.ok)).toBe(true);
    expect(seen).toEqual(["first-user", "second-user"]);
  });
});
