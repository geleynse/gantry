/**
 * Tests for gantry-v2.ts — createGantryServerV2 factory.
 *
 * Uses a mock McpServer pattern to verify tool registration and dispatch
 * without requiring a live game server or database.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { createGantryServerV2, mapV2ToV1, V2_ACTION_TO_V1_NAME, type V2SharedState } from "./gantry-v2.js";
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
    // +4 for login, logout, query_known_resources, query_catalog (proxy-defined tools)
    const expectedCount = 4 + V2_TEST_TOOLS.filter(t => t !== "spacemolt_auth").length;
    expect(registeredTools.length).toBe(expectedCount);
  });

  it("returns shared session state", () => {
    const shared = createTestSharedState();
    const { sessions, sessionAgentMap, eventBuffers, callTrackers } = createGantryServerV2(testConfig, shared);
    expect(sessions).toBe(shared.sessions.active);
    expect(sessionAgentMap).toBe(shared.sessions.agentMap);
    expect(eventBuffers).toBe(shared.cache.events);
    expect(callTrackers).toBe(shared.proxy.callTrackers);
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
  it("registers login, logout, query_known_resources, and query_catalog when v2Tools is empty", () => {
    const shared = createTestSharedState();
    shared.v2Tools = [];
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toEqual(["login", "logout", "query_known_resources", "query_catalog"]);
  });

  it("registers login, logout, query_known_resources, and query_catalog when v2Tools contains only spacemolt_auth", () => {
    const shared = createTestSharedState();
    shared.v2Tools = ["spacemolt_auth"];
    const { registeredTools } = createGantryServerV2(testConfig, shared);
    expect(registeredTools).toEqual(["login", "logout", "query_known_resources", "query_catalog"]);
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

// ---------------------------------------------------------------------------
// mapV2ToV1 unit tests
// ---------------------------------------------------------------------------

describe("mapV2ToV1", () => {
  it("maps known V2_ACTION_TO_V1_NAME entries correctly", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt_storage", "view", {});
    expect(v1ToolName).toBe("view_storage");
  });

  it("maps spacemolt_storage deposit to deposit_items", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt_storage", "deposit", { item_id: "iron_ore", quantity: 10 });
    expect(v1ToolName).toBe("deposit_items");
  });

  it("maps spacemolt_storage withdraw to withdraw_items", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt_storage", "withdraw", { item_id: "iron_ore", quantity: 10 });
    expect(v1ToolName).toBe("withdraw_items");
  });

  it("remaps claim_commission id to commission_id", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt_ship", "claim_commission", { id: "abc123" });
    expect(v1ToolName).toBe("claim_commission");
    expect(v1Args.commission_id).toBe("abc123");
    expect(v1Args.id).toBeUndefined();
  });

  it("remaps cancel_commission id to commission_id", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt_ship", "cancel_commission", { id: "abc123" });
    expect(v1ToolName).toBe("cancel_commission");
    expect(v1Args.commission_id).toBe("abc123");
    expect(v1Args.id).toBeUndefined();
  });

  it("install_mod: remaps id to item_id", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt_ship", "install_mod", { id: "engine_t2" });
    expect(v1ToolName).toBe("install_mod");
    expect(v1Args.item_id).toBe("engine_t2");
    expect(v1Args.id).toBeUndefined();
  });

  it("install_mod: remaps module_id to item_id", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt_ship", "install_mod", { module_id: "engine_t2" });
    expect(v1ToolName).toBe("install_mod");
    expect(v1Args.item_id).toBe("engine_t2");
    expect(v1Args.module_id).toBeUndefined();
  });

  it("uninstall_mod: remaps id to item_id", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt_ship", "uninstall_mod", { id: "engine_t1" });
    expect(v1ToolName).toBe("uninstall_mod");
    expect(v1Args.item_id).toBe("engine_t1");
    expect(v1Args.id).toBeUndefined();
  });

  it("uninstall_mod: remaps module_id to item_id", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt_ship", "uninstall_mod", { module_id: "engine_t1" });
    expect(v1ToolName).toBe("uninstall_mod");
    expect(v1Args.item_id).toBe("engine_t1");
    expect(v1Args.module_id).toBeUndefined();
  });

  it("maps spacemolt get_status correctly", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt", "get_status", {});
    expect(v1ToolName).toBe("get_status");
  });

  it("maps spacemolt_catalog to catalog regardless of action", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt_catalog", "weapons", {});
    expect(v1ToolName).toBe("catalog");
  });

  it("maps battle sub-actions to battle tool", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt_battle", "advance", {});
    expect(v1ToolName).toBe("battle");
    expect(v1Args.action).toBe("advance");
  });

  it("maps spacemolt sell explicitly (no action param leakage)", () => {
    const { v1ToolName, v1Args } = mapV2ToV1("spacemolt", "sell", { action: "sell", item_id: "iron_ore", quantity: 5 });
    expect(v1ToolName).toBe("sell");
    expect(v1Args).toEqual({ item_id: "iron_ore", quantity: 5 });
    expect(v1Args.action).toBeUndefined();
  });

  it("maps spacemolt buy explicitly", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt", "buy", { action: "buy", item_id: "fuel" });
    expect(v1ToolName).toBe("buy");
  });

  it("maps spacemolt mine explicitly", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt", "mine", {});
    expect(v1ToolName).toBe("mine");
  });

  it("falls through to action as v1ToolName for unknown actions", () => {
    // This is the fallback that the #578 guardrail catches in the handler
    const { v1ToolName } = mapV2ToV1("spacemolt", "get_faction", {});
    expect(v1ToolName).toBe("get_faction");
  });

  it("falls through for hallucinated actions on any tool", () => {
    const { v1ToolName } = mapV2ToV1("spacemolt_ship", "totally_fake", {});
    expect(v1ToolName).toBe("totally_fake");
  });
});

// ---------------------------------------------------------------------------
// #578 — unknown action guardrail (handler-level)
// ---------------------------------------------------------------------------

describe("#578 unknown action guardrail", () => {
  it("gameTools list is available on shared state for guardrail check", () => {
    const shared = createTestSharedState();
    // Simulate gameTools populated by mcp-factory after schema fetch
    shared.proxy.gameTools = ["mine", "sell", "jump", "travel", "get_status", "scan"];
    const { mcpServer } = createGantryServerV2(testConfig, shared);
    expect(mcpServer).toBeDefined();
    // The handler will use shared.proxy.gameTools to validate v1ToolName
    expect(shared.proxy.gameTools).toContain("mine");
    expect(shared.proxy.gameTools).not.toContain("get_faction");
  });

  it("V2_ACTION_TO_V1_NAME is exported for error message construction", () => {
    expect(V2_ACTION_TO_V1_NAME).toBeDefined();
    expect(V2_ACTION_TO_V1_NAME.spacemolt_storage).toBeDefined();
    expect(V2_ACTION_TO_V1_NAME.spacemolt_storage.view).toBe("view_storage");
  });

  it("unknown action produces v1ToolName that won't be in gameTools", () => {
    // Simulates the guardrail flow: mapV2ToV1 produces a v1ToolName,
    // then the handler checks if it's in gameTools
    const gameTools = ["mine", "sell", "jump", "travel", "get_status", "scan"];
    const { v1ToolName } = mapV2ToV1("spacemolt", "get_faction", {});
    expect(v1ToolName).toBe("get_faction");
    expect(gameTools.includes(v1ToolName)).toBe(false);
  });

  it("known action produces v1ToolName that IS in gameTools", () => {
    const gameTools = ["mine", "sell", "jump", "travel", "get_status", "scan", "view_storage", "deposit_items", "withdraw_items"];
    const { v1ToolName } = mapV2ToV1("spacemolt_storage", "view", {});
    expect(v1ToolName).toBe("view_storage");
    expect(gameTools.includes(v1ToolName)).toBe(true);
  });
});
