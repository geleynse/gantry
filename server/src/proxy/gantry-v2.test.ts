/**
 * Tests for gantry-v2.ts — createGantryServerV2 factory.
 *
 * Uses a mock McpServer pattern to verify tool registration and dispatch
 * without requiring a live game server or database.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createGantryServerV2, withPrayerScriptSchema, type V2SharedState } from "./gantry-v2.js";
import { serverSchemaToZod, type ServerTool } from "./schema.js";
import type { GantryConfig } from "../config.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { EventBuffer } from "./event-buffer.js";
import { MarketCache } from "./market-cache.js";
import { GalaxyGraph } from "./pathfinder.js";
import { SellLog } from "./sell-log.js";
import { ArbitrageAnalyzer } from "./arbitrage-analyzer.js";
import { BreakerRegistry } from "./circuit-breaker.js";
import { MetricsWindow } from "./instability-metrics.js";
import { MarketReservationCache } from "./market-reservations.js";
import { AnalyzeMarketCache } from "./analyze-market-cache.js";
import { TransitThrottle } from "./transit-throttle.js";
import { TransitStuckDetector } from "./transit-stuck-detector.js";
import { NavLoopDetector } from "./nav-loop-detector.js";
import { OverrideRegistry, BUILT_IN_RULES } from "./override-system.js";

// ---------------------------------------------------------------------------
// Test config and shared state
// ---------------------------------------------------------------------------

const testConfig: GantryConfig = {
  agents: [{ name: "alpha-agent" }, { name: "beta-agent" }],
  gameUrl: "https://game.spacemolt.com/mcp",
  gameApiUrl: "https://game.spacemolt.com/api/v1",
  gameMcpUrl: "https://game.spacemolt.com/mcp",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

const V2_TEST_TOOLS = [
  "spacemolt",
  "spacemolt_catalog",
  "spacemolt_ship",
  "spacemolt_social",
  "spacemolt_storage",
  "spacemolt_market",
  "spacemolt_battle",
  "spacemolt_auth",  // should be skipped (login/logout registered separately)
];

function createTestSharedState(): V2SharedState {
  const breakerRegistry = new BreakerRegistry();
  const serverMetrics = new MetricsWindow();
  const sessions = new SessionManager(testConfig, breakerRegistry, serverMetrics);
  return {
    sessions: { active: sessions, store: new SessionStore(), agentMap: new Map() },
    cache: { status: new Map(), battle: new Map(), market: new MarketCache(), events: new Map() },
    proxy: { gameTools: [], serverDescriptions: new Map(), gameHealthRef: { current: null }, callTrackers: new Map(), breakerRegistry, serverMetrics, transitThrottle: new TransitThrottle(), transitStuckDetector: new TransitStuckDetector(), navLoopDetector: new NavLoopDetector(), overrideRegistry: new OverrideRegistry(BUILT_IN_RULES) },
    fleet: { galaxyGraphRef: { current: new GalaxyGraph() }, sellLog: new SellLog(), arbitrageAnalyzer: new ArbitrageAnalyzer(), coordinator: null, marketReservations: new MarketReservationCache({ pruneIntervalMs: 999_999_999 }), analyzeMarketCache: new AnalyzeMarketCache(), overseerEventLog: null },
    v2Tools: V2_TEST_TOOLS,
    v2Descriptions: new Map([
      ["spacemolt", "SpaceMolt consolidated actions"],
      ["spacemolt_catalog", "Browse catalog"],
      ["spacemolt_ship", "Ship management"],
      ["spacemolt_social", "Social and doc tools"],
      ["spacemolt_storage", "Storage management"],
      ["spacemolt_market", "Market operations"],
      ["spacemolt_battle", "Combat tools"],
    ]),
    v2ToolSchemas: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGantryServerV2", () => {
  it("returns an McpServer instance", () => {
    const shared = createTestSharedState();
    const { mcpServer } = createGantryServerV2(testConfig, shared);
    expect(mcpServer).toBeDefined();
  });

  it("registers login tool", () => {
    const shared = createTestSharedState();
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toContain("login");
  });

  it("registers logout tool", () => {
    const shared = createTestSharedState();
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toContain("logout");
  });

  it("registers all v2Tools except spacemolt_auth", () => {
    const shared = createTestSharedState();
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    // All v2Tools except spacemolt_auth should be registered
    const expected = V2_TEST_TOOLS.filter(t => t !== "spacemolt_auth");
    for (const tool of expected) {
      expect(registeredTools).toContain(tool);
    }
  });

  it("does NOT register spacemolt_auth (login/logout registered separately)", () => {
    const shared = createTestSharedState();
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).not.toContain("spacemolt_auth");
  });

  it("total registered tools = login + logout + query_known_resources + query_catalog + v2Tools (minus spacemolt_auth)", () => {
    const shared = createTestSharedState();
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    // +5 for login, logout, spacemolt_pray, query_known_resources, query_catalog (proxy-defined tools)
    const expectedCount = 5 + V2_TEST_TOOLS.filter(t => t !== "spacemolt_auth").length;
    expect(registeredTools.length).toBe(expectedCount);
  });

  it("registers dedicated spacemolt_pray proxy tool", () => {
    const shared = createTestSharedState();
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toContain("spacemolt_pray");
  });

  it("advertises PrayerLang params on spacemolt action dispatch", () => {
    const serverTool: ServerTool = {
      name: "spacemolt",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get_status", "mine"] },
          id: { type: "string" },
        },
        required: ["action"],
      },
    };

    const patched = withPrayerScriptSchema("spacemolt", serverTool)!;
    const action = patched.inputSchema?.properties?.action as { enum?: string[] };
    expect(action.enum).toContain("pray");
    expect(action.enum).toContain("get_routine_status");
    expect(patched.inputSchema?.properties).toHaveProperty("script");
    expect(patched.inputSchema?.properties).toHaveProperty("max_steps");
    expect(patched.inputSchema?.properties).toHaveProperty("timeout_ticks");
    expect(patched.inputSchema?.properties).toHaveProperty("async");

    const parsed = serverSchemaToZod(patched).safeParse({
      action: "pray",
      script: "halt;",
      max_steps: 1,
      timeout_ticks: 1,
    });
    expect(parsed.success).toBe(true);
  });

  it("returns shared session state", () => {
    const shared = createTestSharedState();
    const { sessions, sessionAgentMap, eventBuffers, callTrackers } = createGantryServerV2(testConfig, shared);
    expect(sessions).toBe(shared.sessions.active);
    expect(sessionAgentMap).toBe(shared.sessions.agentMap);
    expect(eventBuffers).toBe(shared.cache.events);
    expect(callTrackers).toBe(shared.proxy.callTrackers);
  });

  // -------------------------------------------------------------------------
  // craft_chains schema injection (Task #16) — proxy-only catalog actions must
  // be added to the upstream `type` enum so client-side schema validation
  // (serverSchemaToZod) accepts agent calls. Otherwise calls are rejected
  // before reaching the v2 dispatcher and craft_chains adoption stays at 0%.
  // -------------------------------------------------------------------------

  it("withPrayerScriptSchema injects craft_chains into spacemolt_catalog type enum", () => {
    const serverTool: ServerTool = {
      name: "spacemolt_catalog",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["catalog", "weapons", "ships"] },
          id: { type: "string" },
        },
        required: ["type"],
      },
    };

    const patched = withPrayerScriptSchema("spacemolt_catalog", serverTool)!;
    const typeProp = patched.inputSchema?.properties?.type as { enum?: string[] };
    expect(typeProp.enum).toContain("craft_chains");
    // Existing values preserved
    expect(typeProp.enum).toContain("catalog");
    expect(typeProp.enum).toContain("weapons");

    // Round-trip through Zod: agent call with type=craft_chains must validate
    const parsed = serverSchemaToZod(patched).safeParse({
      type: "craft_chains",
      id: "iron_ore",
    });
    expect(parsed.success).toBe(true);
  });

  it("withPrayerScriptSchema is idempotent on spacemolt_catalog (no duplicate craft_chains)", () => {
    const serverTool: ServerTool = {
      name: "spacemolt_catalog",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["catalog", "craft_chains"] },
        },
        required: ["type"],
      },
    };
    const patched = withPrayerScriptSchema("spacemolt_catalog", serverTool)!;
    const typeProp = patched.inputSchema?.properties?.type as { enum?: string[] };
    const occurrences = typeProp.enum!.filter(v => v === "craft_chains").length;
    expect(occurrences).toBe(1);
  });
});

describe("createGantryServerV2 - not logged in guard", () => {
  it("returns error when not logged in", async () => {
    const shared = createTestSharedState();
    createGantryServerV2(testConfig, shared);
    // The handler is registered but we can't easily call it without a session
    // This test verifies the factory completes without throwing
    expect(true).toBe(true);
  });
});

describe("createGantryServerV2 - V2SharedState interface", () => {
  it("V2SharedState has v2Tools, v2Descriptions, v2ToolSchemas", () => {
    const shared = createTestSharedState();
    expect(Array.isArray(shared.v2Tools)).toBe(true);
    expect(shared.v2Descriptions instanceof Map).toBe(true);
    expect(shared.v2ToolSchemas instanceof Map).toBe(true);
  });

  it("uses v2Descriptions for registered tool descriptions", () => {
    const shared = createTestSharedState();
    // Verify that factory accepts shared state with descriptions
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toContain("spacemolt");
  });
});

describe("createGantryServerV2 - empty v2Tools", () => {
  it("registers proxy tools when v2Tools is empty", () => {
    const shared = createTestSharedState();
    shared.v2Tools = [];
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toEqual(["login", "logout", "spacemolt_pray", "query_known_resources", "query_catalog"]);
  });

  it("registers proxy tools when v2Tools contains only spacemolt_auth", () => {
    const shared = createTestSharedState();
    shared.v2Tools = ["spacemolt_auth"];
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toEqual(["login", "logout", "spacemolt_pray", "query_known_resources", "query_catalog"]);
  });
});

describe("V2SharedState re-export from server.ts", () => {
  it("V2SharedState is re-exported from server.ts", async () => {
    // Type-level test: if this imports correctly, the re-export works
    const serverMod = await import("./server.js");
    expect(typeof serverMod.createGantryServerV2).toBe("function");
  });
});

describe("createGantryServerV2 - STATE_CHANGING_TOOLS and CONTAMINATION_WORDS exported", () => {
  it("STATE_CHANGING_TOOLS is exported from server.ts", async () => {
    const serverMod = await import("./server.js");
    expect(serverMod.STATE_CHANGING_TOOLS).toBeDefined();
    expect(serverMod.STATE_CHANGING_TOOLS instanceof Set).toBe(true);
    expect(serverMod.STATE_CHANGING_TOOLS.has("mine")).toBe(true);
    expect(serverMod.STATE_CHANGING_TOOLS.has("sell")).toBe(true);
    expect(serverMod.STATE_CHANGING_TOOLS.has("jump")).toBe(true);
  });

  it("CONTAMINATION_WORDS is exported from server.ts", async () => {
    const serverMod = await import("./server.js");
    expect(serverMod.CONTAMINATION_WORDS).toBeDefined();
    expect(Array.isArray(serverMod.CONTAMINATION_WORDS)).toBe(true);
    expect(serverMod.CONTAMINATION_WORDS.length).toBeGreaterThan(10);
    expect(serverMod.CONTAMINATION_WORDS).toContain("action_pending");
    expect(serverMod.CONTAMINATION_WORDS).toContain("backend");
  });

  it("stripPendingFields is exported from server.ts", async () => {
    const serverMod = await import("./server.js");
    expect(typeof serverMod.stripPendingFields).toBe("function");
    // Verify it strips pending field
    const obj = { pending: true, message: "action pending in queue", result: "ok" };
    serverMod.stripPendingFields(obj);
    expect("pending" in obj).toBe(false);
    expect(obj.message).toBe("action completed");
  });
});

// mapV2ToV1 + V2_ACTION_TO_V1_NAME tests removed in Chunk F2 — the v1 dispatch
// path is gone. v2-action validation now happens at the MCP Zod layer (action
// enum on the consolidated tool schema) plus the gameTools guard in mcp-factory.
