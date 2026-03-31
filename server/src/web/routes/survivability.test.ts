import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import request from "supertest";
import express from "express";
import { createDatabase, closeDb, getDb } from "../../services/database.js";
import { createSurvivabilityRouter } from "./survivability.js";
import { _resetCloakState, evaluateCloakPolicy } from "../../proxy/auto-cloak.js";
import { clearThreatCache } from "../../proxy/threat-assessment.js";
import { setConfigForTesting } from "../../config.js";
import type { GantryConfig } from "../../config.js";

const testConfig: GantryConfig = {
  agents: [
    { name: "rust-vane", roleType: "trader" },
    { name: "sable-thorn", roleType: "explorer" },
    { name: "iron-hawk", roleType: "combat" },
  ] as GantryConfig["agents"],
  gameUrl: "ws://localhost",
  gameApiUrl: "http://localhost",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
  survivability: { autoCloakEnabled: false },
};

type StatusCache = Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
let statusCache: StatusCache;
let app: express.Express;

beforeAll(() => {
  createDatabase(":memory:");
  setConfigForTesting(testConfig);
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  // Reset config state for test isolation (other tests may have changed global AGENTS/AGENT_NAMES)
  setConfigForTesting(testConfig);
  _resetCloakState();
  clearThreatCache();
  statusCache = new Map();
  app = express();
  app.use(express.json());
  app.use("/api/survivability", createSurvivabilityRouter(statusCache, testConfig));
});

afterEach(() => {
  // Reset config after each test to prevent state leakage to subsequent tests
  setConfigForTesting(testConfig);
});

// ---------------------------------------------------------------------------
// GET /api/survivability/threat/:system
// ---------------------------------------------------------------------------

describe("GET /threat/:system", () => {
  it("returns safe for a system with no combat history", async () => {
    const res = await request(app).get("/api/survivability/threat/Peaceful");
    expect(res.status).toBe(200);
    expect(res.body.system).toBe("Peaceful");
    expect(res.body.level).toBe("safe");
    expect(res.body.score).toBe(0);
  });

  it("includes hull factor when agent param given and agent in statusCache", async () => {
    statusCache.set("rust-vane", {
      data: {
        ship: { hull: 20, max_hull: 100 },
      },
      fetchedAt: Date.now(),
    });
    const res = await request(app).get("/api/survivability/threat/Peaceful?agent=rust-vane");
    expect(res.status).toBe(200);
    // hull=20% → +20 bonus → score=20 (safe system base 0 + 20 = 20 = safe level)
    expect(res.body.score).toBe(20);
  });

  it("ignores hull factor when agent not in statusCache", async () => {
    const res = await request(app).get("/api/survivability/threat/Peaceful?agent=unknown-agent");
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/survivability/policy/:agent
// ---------------------------------------------------------------------------

describe("GET /policy/:agent", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await request(app).get("/api/survivability/policy/ghost-agent");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns role and autoCloakEnabled for known agent", async () => {
    const res = await request(app).get("/api/survivability/policy/rust-vane");
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe("rust-vane");
    expect(res.body.roleType).toBe("trader");
    expect(res.body.autoCloakEnabled).toBe(false);
    expect(res.body.override).toBeNull();
  });

  it("reflects override when set", async () => {
    await request(app).post("/api/survivability/cloak-policy").send({ agent: "rust-vane", enabled: true });
    const res = await request(app).get("/api/survivability/policy/rust-vane");
    expect(res.body.override).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/survivability/mods/:agent
// ---------------------------------------------------------------------------

describe("GET /mods/:agent", () => {
  it("returns 404 for unknown agent", async () => {
    const res = await request(app).get("/api/survivability/mods/ghost-agent");
    expect(res.status).toBe(404);
  });

  it("returns role-based mod recommendations for trader", async () => {
    const res = await request(app).get("/api/survivability/mods/rust-vane");
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe("rust-vane");
    expect(res.body.roleType).toBe("trader");
    expect(Array.isArray(res.body.recommendations)).toBe(true);
    expect(res.body.recommendations.length).toBeGreaterThan(0);
    expect(res.body.recommendations[0]).toHaveProperty("mod_type");
    expect(res.body.recommendations[0]).toHaveProperty("priority");
  });

  it("returns explorer mods for explorer agent", async () => {
    const res = await request(app).get("/api/survivability/mods/sable-thorn");
    expect(res.status).toBe(200);
    expect(res.body.roleType).toBe("explorer");
    // Explorer's top priority should be fuel_optimizer
    expect(res.body.recommendations[0].mod_type).toBe("fuel_optimizer");
  });
});

// ---------------------------------------------------------------------------
// POST /api/survivability/cloak-policy
// ---------------------------------------------------------------------------

describe("POST /cloak-policy", () => {
  it("returns 400 when enabled field is missing", async () => {
    const res = await request(app).post("/api/survivability/cloak-policy").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when enabled is not boolean or null", async () => {
    const res = await request(app).post("/api/survivability/cloak-policy").send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown agent", async () => {
    const res = await request(app)
      .post("/api/survivability/cloak-policy")
      .send({ agent: "ghost-agent", enabled: true });
    expect(res.status).toBe(404);
  });

  it("sets per-agent override", async () => {
    const res = await request(app)
      .post("/api/survivability/cloak-policy")
      .send({ agent: "rust-vane", enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.agent).toBe("rust-vane");
    expect(res.body.enabled).toBe(false);
  });

  it("sets override for all agents when no agent param", async () => {
    const res = await request(app)
      .post("/api/survivability/cloak-policy")
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.agent).toBe("all");
  });

  it("clears override when enabled is null", async () => {
    // Set then clear
    await request(app).post("/api/survivability/cloak-policy").send({ agent: "rust-vane", enabled: true });
    const clearRes = await request(app)
      .post("/api/survivability/cloak-policy")
      .send({ agent: "rust-vane", enabled: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.enabled).toBeNull();
    // Confirm policy shows override cleared
    const policy = await request(app).get("/api/survivability/policy/rust-vane");
    expect(policy.body.override).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #519 — GET /api/survivability/cloak-stats
// ---------------------------------------------------------------------------

describe("GET /cloak-stats", () => {
  it("returns stats for all configured agents", async () => {
    const res = await request(app).get("/api/survivability/cloak-stats");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("windowHours", 24);
    expect(Array.isArray(res.body.stats)).toBe(true);
    // Should have one entry per configured agent
    expect(res.body.stats.length).toBe(testConfig.agents.length);
  });

  it("returns zero counts when no cloak calls recorded", async () => {
    const res = await request(app).get("/api/survivability/cloak-stats");
    expect(res.status).toBe(200);
    for (const stat of res.body.stats) {
      expect(stat.cloakActivations).toBe(0);
      expect(stat.threatsDetected).toBe(0);
      expect(stat.threatsAvoided).toBe(0);
    }
  });

  it("counts cloak tool calls from proxy_tool_calls", async () => {
    // Insert a synthetic cloak call within the last 24h
    const db = getDb();
    db.prepare(
      `INSERT INTO proxy_tool_calls (agent, tool_name, success, status, timestamp, created_at)
       VALUES (?, 'spacemolt_cloak', 1, 'complete', datetime('now'), datetime('now'))`,
    ).run("rust-vane");

    const res = await request(app).get("/api/survivability/cloak-stats");
    expect(res.status).toBe(200);
    const stat = res.body.stats.find((s: { agent: string }) => s.agent === "rust-vane");
    expect(stat?.cloakActivations).toBe(1);

    // Clean up
    db.prepare("DELETE FROM proxy_tool_calls WHERE tool_name = 'spacemolt_cloak'").run();
  });
});

// ---------------------------------------------------------------------------
// #519 — GET /api/survivability/thresholds
// ---------------------------------------------------------------------------

describe("GET /thresholds", () => {
  it("returns effective thresholds with defaults when not configured", async () => {
    const res = await request(app).get("/api/survivability/thresholds");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("thresholds");
    expect(res.body.thresholds).toHaveProperty("combat");
    expect(res.body.thresholds).toHaveProperty("explorer");
    expect(res.body.thresholds).toHaveProperty("default");
    expect(res.body.source).toBe("defaults");
  });
});

// ---------------------------------------------------------------------------
// #519 — POST /api/survivability/thresholds
// ---------------------------------------------------------------------------

describe("POST /thresholds", () => {
  it("returns 400 for empty body", async () => {
    const res = await request(app).post("/api/survivability/thresholds").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid threat level value", async () => {
    const res = await request(app)
      .post("/api/survivability/thresholds")
      .send({ combat: "apocalyptic" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid threshold/i);
  });

  it("updates threshold for a known role", async () => {
    const res = await request(app)
      .post("/api/survivability/thresholds")
      .send({ combat: "high" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.thresholds.combat).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// #519 — evaluateCloakPolicy with config thresholds
// ---------------------------------------------------------------------------

describe("evaluateCloakPolicy — config-driven thresholds", () => {
  it("uses hardcoded defaults when no config supplied", () => {
    // combat default = extreme — should NOT cloak at high
    expect(evaluateCloakPolicy("combat", "high")).toBe(false);
    // combat default = extreme — should cloak at extreme
    expect(evaluateCloakPolicy("combat", "extreme")).toBe(true);
  });

  it("uses config thresholds when supplied", () => {
    const config: GantryConfig = {
      ...testConfig,
      survivability: { autoCloakEnabled: true, thresholds: { combat: "high" } as NonNullable<NonNullable<GantryConfig["survivability"]>["thresholds"]> },
    };
    // With combat threshold = high, should cloak at high
    expect(evaluateCloakPolicy("combat", "high", undefined, config)).toBe(true);
    // medium is below high — should not cloak
    expect(evaluateCloakPolicy("combat", "medium", undefined, config)).toBe(false);
  });

  it("falls back to config default threshold for unknown roles", () => {
    const config: GantryConfig = {
      ...testConfig,
      survivability: { autoCloakEnabled: true, thresholds: { default: "low" } as NonNullable<NonNullable<GantryConfig["survivability"]>["thresholds"]> },
    };
    // Unknown role uses default = low — should cloak at low or above
    expect(evaluateCloakPolicy("unknown-role", "low", undefined, config)).toBe(true);
    expect(evaluateCloakPolicy("unknown-role", "safe", undefined, config)).toBe(false);
  });
});
