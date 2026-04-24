import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { setFleetDirForTesting } from "../../config/env.js";
import { join } from "node:path";
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { setSecretPathsForTesting, resetCachedSecrets } from "../../services/crypto.js";
import { decryptPassword } from "../../services/credentials-crypto.js";

const TMP_FLEET_DIR = join(import.meta.dir, "tmp-fleet-enrollment");

// Set it as early as possible
console.log(`Setting FLEET_DIR to ${TMP_FLEET_DIR}`);
setFleetDirForTesting(TMP_FLEET_DIR);

import request from "supertest";
import express from "express";
import { createEnrollmentRouter } from "./enrollment.js";
import { createDatabase, closeDb } from "../../services/database.js";
import { setConfigForTesting } from "../../config/index.js";

describe("enrollment-routes", () => {
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
    
    // Setup minimal fleet config
    const configPath = join(TMP_FLEET_DIR, "gantry.json");
    writeFileSync(configPath, JSON.stringify({
      mcpGameUrl: "http://localhost/mcp",
      agents: [
        { name: "existing-agent", roleType: "trader" }
      ]
    }));

    // Setup template
    writeFileSync(join(TMP_FLEET_DIR, "agent-template.txt"), "Template");

    setFleetDirForTesting(TMP_FLEET_DIR);
    
    // Set config for testing to avoid loading from real FLEET_DIR
    setConfigForTesting({
      agents: [{ name: "existing-agent", roleType: "trader" } as any],
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

    app = express();
    app.use(express.json());
    // Mock auth middleware
    app.use((req: any, res, next) => {
      req.auth = { role: "admin", identity: "test-admin" };
      next();
    });
    app.use("/", createEnrollmentRouter());

    mock.restore();
  });

  afterEach(() => {
    closeDb();
    resetCachedSecrets();
    if (existsSync(TMP_FLEET_DIR)) rmSync(TMP_FLEET_DIR, { recursive: true });
  });

  it("GET /enrollment-options returns options", async () => {
    const res = await request(app).get("/enrollment-options");
    expect(res.status).toBe(200);
    expect(res.body.roleTypes).toContain("trader");
    expect(res.body.empires).toContain("Solarian");
  });

  it("POST /enroll with existing credentials", async () => {
    const payload = {
      agentName: "new-agent",
      username: "user1",
      password: "pass1",
      role: "Miner",
      roleType: "miner",
      faction: "Nebula",
      mcpPreset: "standard"
    };

    const res = await request(app).post("/enroll").send(payload);
    
    if (res.status !== 200) {
      console.error("Enrollment failed:", res.body);
    }

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.agent.name).toBe("new-agent");
    expect(res.body.registered).toBe(false);

    // Verify config update
    const config = JSON.parse(readFileSync(join(TMP_FLEET_DIR, "gantry.json"), "utf-8"));
    expect(config.agents.find((a: any) => a.name === "new-agent")).toBeDefined();

    // Verify credentials update — password is encrypted on disk
    const encPath = join(TMP_FLEET_DIR, "fleet-credentials.enc.json");
    const plainPath = join(TMP_FLEET_DIR, "fleet-credentials.json");
    const activePath = existsSync(encPath) ? encPath : plainPath;
    const creds = JSON.parse(readFileSync(activePath, "utf-8"));
    expect(creds["new-agent"].username).toBe("user1");
    expect(creds["new-agent"].password).toMatch(/^enc:/);
    expect(decryptPassword(creds["new-agent"].password)).toBe("pass1");
  });

  it("POST /enroll with registration code", async () => {
    // Mock registration API
    globalThis.fetch = mock(() => 
      Promise.resolve(new Response(JSON.stringify({ player_id: "p123", password: "generated-pass" }), { status: 200 }))
    ) as any;

    const payload = {
      agentName: "registered-agent",
      username: "user2",
      registrationCode: "CODE123",
      empire: "Solarian",
      role: "Trader",
      roleType: "trader",
      faction: "Solarian",
      mcpPreset: "standard"
    };

    const res = await request(app).post("/enroll").send(payload);
    
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.registered).toBe(true);
    expect(res.body.password).toBe("generated-pass");

    const encPath2 = join(TMP_FLEET_DIR, "fleet-credentials.enc.json");
    const plainPath2 = join(TMP_FLEET_DIR, "fleet-credentials.json");
    const activePath2 = existsSync(encPath2) ? encPath2 : plainPath2;
    const creds = JSON.parse(readFileSync(activePath2, "utf-8"));
    expect(creds["registered-agent"].password).toMatch(/^enc:/);
    expect(decryptPassword(creds["registered-agent"].password)).toBe("generated-pass");
  });

  it("rejects duplicate agent name", async () => {
    const payload = {
      agentName: "existing-agent",
      username: "user1",
      password: "pass1",
      role: "Trader",
      roleType: "trader",
      faction: "Solarian",
      mcpPreset: "standard"
    };

    const res = await request(app).post("/enroll").send(payload);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already taken");
  });

  it("rejects invalid roleType", async () => {
    const payload = {
      agentName: "new-agent",
      username: "user1",
      password: "pass1",
      role: "Chef",
      roleType: "chef", // Invalid
      faction: "Solarian",
      mcpPreset: "standard"
    };

    const res = await request(app).post("/enroll").send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid roleType");
  });
});
