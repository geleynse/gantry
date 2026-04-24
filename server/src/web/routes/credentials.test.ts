import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { setFleetDirForTesting } from "../../config/index.js";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { setSecretPathsForTesting, resetCachedSecrets } from "../../services/crypto.js";
import { decryptPassword } from "../../services/credentials-crypto.js";

const TMP_FLEET_DIR = join(import.meta.dir, "tmp-fleet-credentials");

// Set it as early as possible
setFleetDirForTesting(TMP_FLEET_DIR);

import request from "supertest";
import express from "express";
import { createCredentialsRouter } from "./credentials.js";
import { createDatabase, closeDb } from "../../services/database.js";
import { setConfigForTesting } from "../../config/index.js";
import { logEnrollmentEvent } from "../../services/enrollment-audit.js";

const TEST_AGENTS = ["test-cred-alpha", "test-cred-beta"];

function setTestConfig() {
  setConfigForTesting({
    agents: TEST_AGENTS.map((name) => ({ name, roleType: "trader" }) as any),
    gameUrl: "http://localhost/mcp",
    gameApiUrl: "http://localhost/api/v1",
    gameMcpUrl: "http://localhost/mcp",
    agentDeniedTools: {},
    callLimits: {},
    turnSleepMs: 300000,
    staggerDelay: 5000,
    maxIterationsPerSession: 200,
    maxTurnDurationMs: 300000,
    idleTimeoutMs: 120000,
  });
}

describe("credentials-routes", () => {
  let app: express.Express;

  beforeEach(() => {
    createDatabase(":memory:");
    if (existsSync(TMP_FLEET_DIR)) rmSync(TMP_FLEET_DIR, { recursive: true });
    mkdirSync(TMP_FLEET_DIR);

    // Wire crypto to use tmp dir for secret persistence
    setSecretPathsForTesting(
      join(TMP_FLEET_DIR, ".gantry-secret"),
      join(TMP_FLEET_DIR, ".gantry-secret.prev"),
    );

    // Write plaintext credentials file (legacy format — migration will handle it on first read)
    const credsPath = join(TMP_FLEET_DIR, "fleet-credentials.json");
    writeFileSync(credsPath, JSON.stringify({
      [TEST_AGENTS[0]]: { username: "u1", password: "p1" }
    }));

    setFleetDirForTesting(TMP_FLEET_DIR);
    setTestConfig();

    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.auth = { role: "admin", identity: "test-admin" };
      next();
    });
    app.use("/", createCredentialsRouter());
  });

  afterEach(() => {
    closeDb();
    resetCachedSecrets();
    if (existsSync(TMP_FLEET_DIR)) rmSync(TMP_FLEET_DIR, { recursive: true });
  });

  it("GET / returns credential status without passwords", async () => {
    setTestConfig(); // Re-assert config before request (parallel safety)
    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const agent1 = res.body.find((a: any) => a.name === TEST_AGENTS[0]);
    expect(agent1.hasCredentials).toBe(true);
    expect(agent1.username).toBe("u1");
    expect(agent1.password).toBeUndefined();

    const agent2 = res.body.find((a: any) => a.name === TEST_AGENTS[1]);
    expect(agent2.hasCredentials).toBe(false);
  });

  it("POST /:agent/update writes encrypted password to file", async () => {
    setTestConfig();
    const res = await request(app)
      .post(`/${TEST_AGENTS[1]}/update`)
      .send({ username: "u2", password: "p2" });

    expect(res.status).toBe(200);

    // File may be fleet-credentials.json (legacy) or fleet-credentials.enc.json —
    // check whichever exists
    const encPath = join(TMP_FLEET_DIR, "fleet-credentials.enc.json");
    const plainPath = join(TMP_FLEET_DIR, "fleet-credentials.json");
    const activePath = existsSync(encPath) ? encPath : plainPath;
    const creds = JSON.parse(readFileSync(activePath, "utf-8"));
    expect(creds[TEST_AGENTS[1]].username).toBe("u2");
    // Password on disk must be encrypted
    expect(creds[TEST_AGENTS[1]].password).toMatch(/^enc:/);
    // And it must decrypt to the original value
    expect(decryptPassword(creds[TEST_AGENTS[1]].password)).toBe("p2");
  });

  it("DELETE /:agent removes credentials", async () => {
    setTestConfig();
    const res = await request(app).delete(`/${TEST_AGENTS[0]}`);
    expect(res.status).toBe(200);

    const encPath = join(TMP_FLEET_DIR, "fleet-credentials.enc.json");
    const plainPath = join(TMP_FLEET_DIR, "fleet-credentials.json");
    const activePath = existsSync(encPath) ? encPath : plainPath;
    const creds = JSON.parse(readFileSync(activePath, "utf-8"));
    expect(creds[TEST_AGENTS[0]]).toBeUndefined();
  });

  it("GET /audit returns audit log", async () => {
    logEnrollmentEvent(TEST_AGENTS[0], "enrolled", "admin");

    const res = await request(app).get("/audit");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].agent_name).toBe(TEST_AGENTS[0]);
  });
});
