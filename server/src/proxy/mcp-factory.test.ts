import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createMcpServer, OUR_SCHEMA_PARAMS, pruneStaleAndOrphanTransports, validateToolCallName } from "./mcp-factory.js";
import { STATIC_GAME_TOOLS } from "./server.js";
import { getToolsForRolePreset } from "../config.js";
import { SessionStore } from "./session-store.js";
import { createDatabase, closeDb } from "../services/database.js";

describe("mcp-factory", () => {
  it("exports createMcpServer as an async function", () => {
    expect(typeof createMcpServer).toBe("function");
    // Should return a Promise (async function)
    expect(createMcpServer.constructor.name).toBe("AsyncFunction");
  });

  it("STATIC_GAME_TOOLS contains core game tools", () => {
    expect(STATIC_GAME_TOOLS).toContain("mine");
    expect(STATIC_GAME_TOOLS).toContain("travel");
    expect(STATIC_GAME_TOOLS).toContain("jump");
    expect(STATIC_GAME_TOOLS).toContain("sell");
    expect(STATIC_GAME_TOOLS).toContain("buy");
    expect(STATIC_GAME_TOOLS).toContain("craft");
    expect(STATIC_GAME_TOOLS).toContain("dock");
    expect(STATIC_GAME_TOOLS).toContain("undock");
    expect(STATIC_GAME_TOOLS).toContain("scan");
    expect(STATIC_GAME_TOOLS).toContain("get_missions");
  });

  it("STATIC_GAME_TOOLS has expected minimum length", () => {
    expect(STATIC_GAME_TOOLS.length).toBeGreaterThan(50);
  });

  it("OUR_SCHEMA_PARAMS has expected tool entries", () => {
    expect(OUR_SCHEMA_PARAMS.jump).toEqual(["system_id"]);
    expect(OUR_SCHEMA_PARAMS.travel).toEqual(["destination_id"]);
    expect(OUR_SCHEMA_PARAMS.craft).toEqual(["recipe_id", "count", "deliver_to"]);
    expect(OUR_SCHEMA_PARAMS.attack).toEqual(["target_id"]);
  });

  it("OUR_SCHEMA_PARAMS sell has required params", () => {
    expect(OUR_SCHEMA_PARAMS.sell).toContain("item_id");
    expect(OUR_SCHEMA_PARAMS.sell).toContain("quantity");
  });

  it("OUR_SCHEMA_PARAMS buy has all expected params", () => {
    expect(OUR_SCHEMA_PARAMS.buy).toContain("item_id");
    expect(OUR_SCHEMA_PARAMS.buy).toContain("quantity");
    expect(OUR_SCHEMA_PARAMS.buy).toContain("auto_list");
    expect(OUR_SCHEMA_PARAMS.buy).toContain("deliver_to");
  });

  it("OUR_SCHEMA_PARAMS has expected minimum number of tools", () => {
    expect(Object.keys(OUR_SCHEMA_PARAMS).length).toBeGreaterThan(25);
  });

  it("OUR_SCHEMA_PARAMS includes mission tools", () => {
    expect(OUR_SCHEMA_PARAMS.accept_mission).toEqual(["mission_id"]);
    expect(OUR_SCHEMA_PARAMS.complete_mission).toEqual(["mission_id"]);
    expect(OUR_SCHEMA_PARAMS.abandon_mission).toEqual(["mission_id"]);
  });

  it("OUR_SCHEMA_PARAMS includes forum tools", () => {
    expect(OUR_SCHEMA_PARAMS.forum_get_thread).toEqual(["thread_id"]);
    expect(OUR_SCHEMA_PARAMS.forum_reply).toEqual(["thread_id", "content"]);
    expect(OUR_SCHEMA_PARAMS.forum_create_thread).toEqual(["title", "content", "category"]);
  });

  it("OUR_SCHEMA_PARAMS includes trade tools", () => {
    expect(OUR_SCHEMA_PARAMS.trade_accept).toEqual(["trade_id"]);
    expect(OUR_SCHEMA_PARAMS.trade_decline).toEqual(["trade_id"]);
    expect(OUR_SCHEMA_PARAMS.trade_cancel).toEqual(["trade_id"]);
  });

  it("OUR_SCHEMA_PARAMS all values are non-empty arrays", () => {
    for (const [_tool, params] of Object.entries(OUR_SCHEMA_PARAMS)) {
      expect(Array.isArray(params)).toBe(true);
      expect(params.length).toBeGreaterThan(0);
      // All param names should be non-empty strings
      for (const param of params) {
        expect(typeof param).toBe("string");
        expect(param.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tool name sanitization
// ---------------------------------------------------------------------------

import { sanitizeToolName } from "./mcp-factory.js";

describe("sanitizeToolName — XML/HTML artifact stripping", () => {
  it('strips trailing " />', () => {
    const { name, sanitized } = sanitizeToolName('mcp__gantry__logout" />');
    expect(name).toBe("mcp__gantry__logout");
    expect(sanitized).toBe(true);
  });

  it("strips trailing />", () => {
    const { name, sanitized } = sanitizeToolName("mcp__gantry__login />");
    expect(name).toBe("mcp__gantry__login");
    expect(sanitized).toBe(true);
  });

  it('strips trailing ">', () => {
    const { name, sanitized } = sanitizeToolName('mcp__gantry__mine">');
    expect(name).toBe("mcp__gantry__mine");
    expect(sanitized).toBe(true);
  });

  it('strips trailing "', () => {
    const { name, sanitized } = sanitizeToolName('mcp__gantry__sell"');
    expect(name).toBe("mcp__gantry__sell");
    expect(sanitized).toBe(true);
  });

  it("strips trailing '", () => {
    const { name, sanitized } = sanitizeToolName("mcp__gantry__buy'");
    expect(name).toBe("mcp__gantry__buy");
    expect(sanitized).toBe(true);
  });

  it("leaves clean names unchanged", () => {
    const cases = [
      "mcp__gantry__logout",
      "spacemolt",
      "spacemolt_auth",
      "login",
    ];
    for (const toolName of cases) {
      const { name, sanitized } = sanitizeToolName(toolName);
      expect(name).toBe(toolName);
      expect(sanitized).toBe(false);
    }
  });

  it("strips whitespace around artifacts", () => {
    const { name, sanitized } = sanitizeToolName('mcp__gantry__jump  " />  ');
    expect(name).toBe("mcp__gantry__jump");
    expect(sanitized).toBe(true);
  });

  it("handles empty string input gracefully", () => {
    const { name, sanitized } = sanitizeToolName("");
    expect(name).toBe("");
    expect(sanitized).toBe(false);
  });

  it("strips only trailing artifacts, not mid-string content", () => {
    const { name, sanitized } = sanitizeToolName("mcp__gantry__multi_sell");
    expect(name).toBe("mcp__gantry__multi_sell");
    expect(sanitized).toBe(false);
  });

  it("strips combined artifact: trailing double-quote then space then />", () => {
    const { name, sanitized } = sanitizeToolName('spacemolt" />');
    expect(name).toBe("spacemolt");
    expect(sanitized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OUR_SCHEMA_PARAMS — consistency and completeness
// ---------------------------------------------------------------------------

describe("OUR_SCHEMA_PARAMS — consistency checks", () => {
  it("every non-proxy tool in OUR_SCHEMA_PARAMS exists in STATIC_GAME_TOOLS", () => {
    // Proxy-only tools that exist only in our overlay, not in the game API
    const PROXY_ONLY_TOOLS = new Set(["captains_log_add", "captains_log_list"]);
    for (const toolName of Object.keys(OUR_SCHEMA_PARAMS)) {
      if (PROXY_ONLY_TOOLS.has(toolName)) continue;
      expect(STATIC_GAME_TOOLS).toContain(toolName);
    }
  });

  it("no tool in OUR_SCHEMA_PARAMS has duplicate param names", () => {
    for (const [_tool, params] of Object.entries(OUR_SCHEMA_PARAMS)) {
      const unique = new Set(params);
      expect(unique.size).toBe(params.length);
    }
  });

  it("storage tools have correct param sets", () => {
    expect(OUR_SCHEMA_PARAMS.deposit_items).toEqual(["item_id", "quantity"]);
    expect(OUR_SCHEMA_PARAMS.withdraw_items).toEqual(["item_id", "quantity"]);
  });

  it("order management tools include order_id param", () => {
    expect(OUR_SCHEMA_PARAMS.cancel_order).toContain("order_id");
    expect(OUR_SCHEMA_PARAMS.modify_order).toContain("order_id");
  });

  it("ship commission tools have ship_class param", () => {
    expect(OUR_SCHEMA_PARAMS.commission_ship).toContain("ship_class");
    expect(OUR_SCHEMA_PARAMS.commission_quote).toContain("ship_class");
  });
});

// ---------------------------------------------------------------------------
// getToolsForRolePreset — factory preset selection behavior
// ---------------------------------------------------------------------------

describe("getToolsForRolePreset — factory preset selection", () => {
  const FACTORY_PRESETS: Record<string, string[]> = {
    combat:   ["spacemolt", "spacemolt_ship", "spacemolt_social", "spacemolt_catalog"],
    trader:   ["spacemolt", "spacemolt_market", "spacemolt_storage", "spacemolt_social"],
    standard: ["spacemolt", "spacemolt_social", "spacemolt_ship", "spacemolt_market", "spacemolt_storage", "spacemolt_catalog"],
  };

  it("returns null when mcpPresets is undefined — no filtering applied", () => {
    expect(getToolsForRolePreset(undefined, "combat")).toBeNull();
  });

  it("returns null when mcpPresets is empty and roleType is undefined", () => {
    expect(getToolsForRolePreset({}, undefined)).toBeNull();
  });

  it("falls back to standard preset for unknown roleType", () => {
    const result = getToolsForRolePreset(FACTORY_PRESETS, "unknown-role");
    const standard = getToolsForRolePreset(FACTORY_PRESETS, "standard");
    expect(result).not.toBeNull();
    expect(new Set(result!)).toEqual(new Set(standard!));
  });

  it("login and logout are always injected regardless of preset", () => {
    for (const roleType of Object.keys(FACTORY_PRESETS)) {
      const tools = getToolsForRolePreset(FACTORY_PRESETS, roleType);
      expect(tools).not.toBeNull();
      expect(tools!).toContain("login");
      expect(tools!).toContain("logout");
    }
  });

  it("combat preset excludes market and storage tools", () => {
    const tools = getToolsForRolePreset(FACTORY_PRESETS, "combat")!;
    expect(tools).not.toContain("spacemolt_market");
    expect(tools).not.toContain("spacemolt_storage");
    expect(tools).toContain("spacemolt_ship");
  });

  it("trader preset includes market and storage but not ship", () => {
    const tools = getToolsForRolePreset(FACTORY_PRESETS, "trader")!;
    expect(tools).toContain("spacemolt_market");
    expect(tools).toContain("spacemolt_storage");
    expect(tools).not.toContain("spacemolt_ship");
  });

  it("returned array has no duplicates even when preset has repeated entries", () => {
    const dedupPresets = { test: ["spacemolt", "spacemolt", "spacemolt_social"] };
    const tools = getToolsForRolePreset(dedupPresets, "test")!;
    const uniqueCount = new Set(tools).size;
    expect(uniqueCount).toBe(tools.length);
  });
});

// ---------------------------------------------------------------------------
// SessionStore — startup clearAll and session lifecycle
// (mcp-factory calls clearAll() on startup to remove stale sessions)
// ---------------------------------------------------------------------------

describe("SessionStore — startup clearAll and session lifecycle", () => {
  let store: SessionStore;

  beforeEach(() => {
    createDatabase(":memory:");
    store = new SessionStore();
  });

  afterEach(() => {
    closeDb();
  });

  it("clearAll removes all sessions and returns count", () => {
    store.createSession("agent-a");
    store.createSession("agent-b");
    store.createSession("agent-c");

    const deleted = store.clearAll();
    expect(deleted).toBe(3);

    const active = store.getActiveSessions();
    expect(active.length).toBe(0);
  });

  it("clearAll on empty store returns 0", () => {
    const deleted = store.clearAll();
    expect(deleted).toBe(0);
  });

  it("isValidSession returns false for non-existent session", () => {
    expect(store.isValidSession("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("createSession with explicit id uses that id", () => {
    const id = "test-session-id-1234";
    const returned = store.createSession("agent-a", id);
    expect(returned).toBe(id);
    expect(store.isValidSession(id)).toBe(true);
  });

  it("setSessionAgent updates the agent name on an existing session", () => {
    const sid = store.createSession(undefined); // no agent
    store.setSessionAgent(sid, "drifter-gale");

    const active = store.getActiveSessions();
    const session = active.find(s => s.id === sid);
    expect(session?.agent).toBe("drifter-gale");
  });

  it("setSessionAgent expires other live sessions for the same agent (session leak fix)", () => {
    // Three prior sessions accumulate for one agent across process churn
    const stale1 = store.createSession("drifter-gale");
    const stale2 = store.createSession("drifter-gale");
    const stale3 = store.createSession("drifter-gale");

    // A fresh MCP session initialized by the new runner process claims the agent
    const fresh = store.createSession(undefined);
    store.setSessionAgent(fresh, "drifter-gale");

    // Only the fresh session remains valid for this agent
    expect(store.isValidSession(stale1)).toBe(false);
    expect(store.isValidSession(stale2)).toBe(false);
    expect(store.isValidSession(stale3)).toBe(false);
    expect(store.isValidSession(fresh)).toBe(true);
    const active = store.getActiveSessions();
    expect(active.filter(s => s.agent === "drifter-gale")).toHaveLength(1);
  });

  it("setSessionAgent does not touch sessions owned by other agents", () => {
    const other = store.createSession("rust-vane");
    const fresh = store.createSession(undefined);
    store.setSessionAgent(fresh, "drifter-gale");

    expect(store.isValidSession(other)).toBe(true);
  });

  it("cleanup returns 0 when no sessions are expired", () => {
    store.createSession("agent-a");
    const deleted = store.cleanup();
    expect(deleted).toBe(0); // freshly created, not yet expired
  });

  it("isValidSession returns false after clearAll", () => {
    const sid = store.createSession("agent-a");
    expect(store.isValidSession(sid)).toBe(true);

    store.clearAll();
    expect(store.isValidSession(sid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sanitizeToolName — additional edge cases
// ---------------------------------------------------------------------------

describe("sanitizeToolName — additional edge cases", () => {
  it("handles tool name with numbers and underscores unchanged", () => {
    const { name, sanitized } = sanitizeToolName("mcp__gantry__batch_mine_v2");
    expect(name).toBe("mcp__gantry__batch_mine_v2");
    expect(sanitized).toBe(false);
  });

  it("does not alter names that contain mid-string quote", () => {
    // A single-quote mid-name is unusual but should not be stripped
    const input = "spacemolt_auth";
    const { name, sanitized } = sanitizeToolName(input);
    expect(name).toBe(input);
    expect(sanitized).toBe(false);
  });

  it("strips only trailing artifact, not all quotes", () => {
    // Tool name ending with double-quote — strip it
    const input = 'mcp__gantry__logout"';
    const { name, sanitized } = sanitizeToolName(input);
    expect(name).toBe("mcp__gantry__logout");
    expect(sanitized).toBe(true);
  });

  it("is idempotent — sanitizing a clean name twice yields same result", () => {
    const clean = "mcp__gantry__jump";
    const first = sanitizeToolName(clean);
    const second = sanitizeToolName(first.name);
    expect(second.name).toBe(clean);
    expect(second.sanitized).toBe(false);
  });

  it("strips whitespace-only artifact suffix", () => {
    // Trailing whitespace with /> artifact
    const { name, sanitized } = sanitizeToolName("spacemolt   />");
    expect(name).toBe("spacemolt");
    expect(sanitized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OUR_SCHEMA_PARAMS — navigation, social, and market tool coverage
// ---------------------------------------------------------------------------

describe("OUR_SCHEMA_PARAMS — navigation and social tools", () => {
  it("find_route has destination_system_id param", () => {
    expect(OUR_SCHEMA_PARAMS.find_route).toEqual(["destination_system_id"]);
  });

  it("search_systems has name param", () => {
    expect(OUR_SCHEMA_PARAMS.search_systems).toEqual(["name"]);
  });

  it("get_system has system_id param", () => {
    expect(OUR_SCHEMA_PARAMS.get_system).toEqual(["system_id"]);
  });

  it("get_poi has poi_id param", () => {
    expect(OUR_SCHEMA_PARAMS.get_poi).toEqual(["poi_id"]);
  });

  it("chat has required channel and content params", () => {
    expect(OUR_SCHEMA_PARAMS.chat).toContain("channel");
    expect(OUR_SCHEMA_PARAMS.chat).toContain("content");
  });

  it("view_market has item_id and category params", () => {
    expect(OUR_SCHEMA_PARAMS.view_market).toContain("item_id");
    expect(OUR_SCHEMA_PARAMS.view_market).toContain("category");
  });

  it("estimate_purchase has item_id and quantity params", () => {
    expect(OUR_SCHEMA_PARAMS.estimate_purchase).toContain("item_id");
    expect(OUR_SCHEMA_PARAMS.estimate_purchase).toContain("quantity");
  });

  it("loot_wreck has wreck_id, item_id, quantity params", () => {
    expect(OUR_SCHEMA_PARAMS.loot_wreck).toContain("wreck_id");
    expect(OUR_SCHEMA_PARAMS.loot_wreck).toContain("item_id");
    expect(OUR_SCHEMA_PARAMS.loot_wreck).toContain("quantity");
  });

  it("salvage_wreck has wreck_id param", () => {
    expect(OUR_SCHEMA_PARAMS.salvage_wreck).toEqual(["wreck_id"]);
  });

  it("get_chat_history has channel, target_id, before, limit params", () => {
    expect(OUR_SCHEMA_PARAMS.get_chat_history).toContain("channel");
    expect(OUR_SCHEMA_PARAMS.get_chat_history).toContain("limit");
  });

  it("buy_ship has ship_class param", () => {
    expect(OUR_SCHEMA_PARAMS.buy_ship).toContain("ship_class");
  });

  it("switch_ship has ship_id param", () => {
    expect(OUR_SCHEMA_PARAMS.switch_ship).toEqual(["ship_id"]);
  });

  it("decline_mission has template_id param", () => {
    expect(OUR_SCHEMA_PARAMS.decline_mission).toEqual(["template_id"]);
  });

  it("create_sell_order has price_each param", () => {
    expect(OUR_SCHEMA_PARAMS.create_sell_order).toContain("price_each");
    expect(OUR_SCHEMA_PARAMS.create_sell_order).toContain("item_id");
    expect(OUR_SCHEMA_PARAMS.create_sell_order).toContain("quantity");
  });

  it("create_buy_order has deliver_to param", () => {
    expect(OUR_SCHEMA_PARAMS.create_buy_order).toContain("deliver_to");
    expect(OUR_SCHEMA_PARAMS.create_buy_order).toContain("price_each");
  });

  it("modify_order has new_price param", () => {
    expect(OUR_SCHEMA_PARAMS.modify_order).toContain("new_price");
    expect(OUR_SCHEMA_PARAMS.modify_order).toContain("order_id");
  });
});

// ---------------------------------------------------------------------------
// getToolsForRolePreset — additional edge cases
// ---------------------------------------------------------------------------

describe("getToolsForRolePreset — additional edge cases", () => {
  const FACTORY_PRESETS: Record<string, string[]> = {
    combat:   ["spacemolt", "spacemolt_ship", "spacemolt_social", "spacemolt_catalog"],
    trader:   ["spacemolt", "spacemolt_market", "spacemolt_storage", "spacemolt_social"],
    standard: ["spacemolt", "spacemolt_social", "spacemolt_ship", "spacemolt_market", "spacemolt_storage", "spacemolt_catalog"],
  };

  it("returns null when mcpPresets is null", () => {
    expect(getToolsForRolePreset(null as any, "combat")).toBeNull();
  });

  it("standard preset includes all tool namespaces", () => {
    const tools = getToolsForRolePreset(FACTORY_PRESETS, "standard")!;
    expect(tools).toContain("spacemolt");
    expect(tools).toContain("spacemolt_social");
    expect(tools).toContain("spacemolt_ship");
    expect(tools).toContain("spacemolt_market");
    expect(tools).toContain("spacemolt_storage");
    expect(tools).toContain("spacemolt_catalog");
  });

  it("result always includes login and logout even when not in preset", () => {
    const presets = { minimal: ["spacemolt"] };
    const tools = getToolsForRolePreset(presets, "minimal")!;
    expect(tools).toContain("login");
    expect(tools).toContain("logout");
  });

  it("result for unknown role is same as standard", () => {
    const tools = getToolsForRolePreset(FACTORY_PRESETS, "unknown-xyz")!;
    const standard = getToolsForRolePreset(FACTORY_PRESETS, "standard")!;
    expect(tools).toBeDefined();
    expect(new Set(tools)).toEqual(new Set(standard));
  });

  it("explorer preset (unknown) falls back to standard, not combat", () => {
    const tools = getToolsForRolePreset(FACTORY_PRESETS, "explorer")!;
    const standard = getToolsForRolePreset(FACTORY_PRESETS, "standard")!;
    expect(new Set(tools)).toEqual(new Set(standard));
  });
});

describe("validateToolCallName", () => {
  it("returns null for valid tools/call", () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mine", arguments: {} } };
    expect(validateToolCallName(body)).toBeNull();
  });

  it("returns null for non-tools/call requests", () => {
    expect(validateToolCallName({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeNull();
    expect(validateToolCallName({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toBeNull();
  });

  it("rejects empty name", () => {
    const body = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "", arguments: {} } };
    const err = validateToolCallName(body);
    expect(err).not.toBeNull();
    expect(err!.error.code).toBe(-32602);
    expect(err!.error.message).toContain("missing or empty");
    expect(err!.id).toBe(7);
  });

  it("rejects whitespace-only name", () => {
    const body = { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "   ", arguments: {} } };
    const err = validateToolCallName(body);
    expect(err).not.toBeNull();
    expect(err!.error.message).toContain("missing or empty");
  });

  it("rejects missing name", () => {
    const body = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { arguments: {} } };
    const err = validateToolCallName(body);
    expect(err).not.toBeNull();
    expect(err!.error.code).toBe(-32602);
  });

  it("rejects null name", () => {
    const body = { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: null, arguments: {} } };
    const err = validateToolCallName(body);
    expect(err).not.toBeNull();
    expect(err!.error.message).toContain("missing or empty");
  });

  it("rejects non-string name (number)", () => {
    const body = { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: 42, arguments: {} } };
    const err = validateToolCallName(body);
    expect(err).not.toBeNull();
    expect(err!.error.message).toContain("missing or empty");
  });

  it("rejects missing params", () => {
    const body = { jsonrpc: "2.0", id: 12, method: "tools/call" };
    const err = validateToolCallName(body);
    expect(err).not.toBeNull();
    expect(err!.error.message).toContain("params missing");
  });

  it("preserves request id in the error envelope (or null when absent)", () => {
    const withId = validateToolCallName({ jsonrpc: "2.0", id: "req-abc", method: "tools/call", params: { name: "" } });
    expect(withId!.id).toBe("req-abc");
    const withoutId = validateToolCallName({ jsonrpc: "2.0", method: "tools/call", params: { name: "" } });
    expect(withoutId!.id).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// pruneStaleAndOrphanTransports — pre-login orphan + same-agent churn
// ---------------------------------------------------------------------------

describe("pruneStaleAndOrphanTransports", () => {
  type FakeTransport = { close: () => Promise<void>; closed: boolean };
  function fakeTransport(): FakeTransport {
    const t: FakeTransport = {
      closed: false,
      close: async () => { t.closed = true; },
    };
    return t;
  }

  function fakeStore(records: Record<string, { agent?: string; createdAt: string }>): {
    getSession(id: string): { agent?: string; createdAt: string } | null;
  } {
    return {
      getSession(id: string) {
        return records[id] ?? null;
      },
    };
  }

  function silentLogger() {
    const calls: { level: string; msg: string; data?: unknown }[] = [];
    return {
      calls,
      info: (msg: string, data?: unknown) => calls.push({ level: "info", msg, data }),
      warn: (msg: string, data?: unknown) => calls.push({ level: "warn", msg, data }),
    };
  }

  it("closes pre-login orphan transports older than 120s", () => {
    const NOW = 1_700_000_000_000;
    const orphanSid = "orphan-sid-old";
    const orphan = fakeTransport();
    const transports = new Map<string, FakeTransport>();
    transports.set(orphanSid, orphan);
    const sessionAgentMap = new Map<string, string | undefined>();

    const sessionStore = fakeStore({
      [orphanSid]: { agent: undefined, createdAt: new Date(NOW - 121_000).toISOString() },
    });
    const logger = silentLogger();

    const result = pruneStaleAndOrphanTransports({
      agentName: "anyone",
      currentSessionId: undefined,
      transports: transports as Map<string, { close?: () => Promise<void> | void }>,
      sessionAgentMap,
      sessionStore,
      logger,
      now: NOW,
    });

    expect(result.closedOrphans).toBe(1);
    expect(orphan.closed).toBe(true);
    expect(transports.has(orphanSid)).toBe(false);
    expect(logger.calls.find(c => c.msg.includes("pre-login orphan"))).toBeTruthy();
  });

  it("does NOT close pre-login orphans younger than 120s", () => {
    const NOW = 1_700_000_000_000;
    const youngSid = "orphan-sid-young";
    const young = fakeTransport();
    const transports = new Map<string, FakeTransport>();
    transports.set(youngSid, young);
    const sessionAgentMap = new Map<string, string | undefined>();

    const sessionStore = fakeStore({
      [youngSid]: { agent: undefined, createdAt: new Date(NOW - 30_000).toISOString() },
    });

    const result = pruneStaleAndOrphanTransports({
      agentName: "anyone",
      currentSessionId: undefined,
      transports: transports as Map<string, { close?: () => Promise<void> | void }>,
      sessionAgentMap,
      sessionStore,
      logger: silentLogger(),
      now: NOW,
    });

    expect(result.closedOrphans).toBe(0);
    expect(young.closed).toBe(false);
    expect(transports.has(youngSid)).toBe(true);
  });

  it("does NOT close transports already bound to a different agent at DB level", () => {
    const NOW = 1_700_000_000_000;
    const sid = "bound-sid";
    const t = fakeTransport();
    const transports = new Map<string, FakeTransport>();
    transports.set(sid, t);
    const sessionAgentMap = new Map<string, string | undefined>();
    // Not in agent map but bound at DB level — not an orphan
    const sessionStore = fakeStore({
      [sid]: { agent: "rust-vane", createdAt: new Date(NOW - 600_000).toISOString() },
    });

    const result = pruneStaleAndOrphanTransports({
      agentName: "drifter-gale",
      currentSessionId: undefined,
      transports: transports as Map<string, { close?: () => Promise<void> | void }>,
      sessionAgentMap,
      sessionStore,
      logger: silentLogger(),
      now: NOW,
    });

    expect(result.closedOrphans).toBe(0);
    expect(t.closed).toBe(false);
  });

  it("first pass closes same-agent stale transports on different sids", () => {
    const NOW = 1_700_000_000_000;
    const fresh = "current-sid";
    const stale1 = "stale-sid-1";
    const stale2 = "stale-sid-2";
    const tFresh = fakeTransport();
    const tStale1 = fakeTransport();
    const tStale2 = fakeTransport();
    const transports = new Map<string, FakeTransport>();
    transports.set(fresh, tFresh);
    transports.set(stale1, tStale1);
    transports.set(stale2, tStale2);

    const sessionAgentMap = new Map<string, string | undefined>();
    sessionAgentMap.set(fresh, "drifter-gale");
    sessionAgentMap.set(stale1, "drifter-gale");
    sessionAgentMap.set(stale2, "drifter-gale");

    const sessionStore = fakeStore({
      [fresh]: { agent: "drifter-gale", createdAt: new Date(NOW - 5_000).toISOString() },
      [stale1]: { agent: "drifter-gale", createdAt: new Date(NOW - 600_000).toISOString() },
      [stale2]: { agent: "drifter-gale", createdAt: new Date(NOW - 600_000).toISOString() },
    });

    const result = pruneStaleAndOrphanTransports({
      agentName: "drifter-gale",
      currentSessionId: fresh,
      transports: transports as Map<string, { close?: () => Promise<void> | void }>,
      sessionAgentMap,
      sessionStore,
      logger: silentLogger(),
      now: NOW,
    });

    expect(result.closedForAgent).toBe(2);
    expect(tFresh.closed).toBe(false);
    expect(tStale1.closed).toBe(true);
    expect(tStale2.closed).toBe(true);
    expect(transports.has(fresh)).toBe(true);
    expect(transports.has(stale1)).toBe(false);
    expect(transports.has(stale2)).toBe(false);
  });

  it("does not close the current session even if it appears as an orphan candidate", () => {
    const NOW = 1_700_000_000_000;
    const current = "current-pre-login";
    const transports = new Map<string, FakeTransport>();
    const tCurrent = fakeTransport();
    transports.set(current, tCurrent);
    const sessionAgentMap = new Map<string, string | undefined>();
    const sessionStore = fakeStore({
      [current]: { agent: undefined, createdAt: new Date(NOW - 600_000).toISOString() },
    });

    const result = pruneStaleAndOrphanTransports({
      agentName: "drifter-gale",
      currentSessionId: current,
      transports: transports as Map<string, { close?: () => Promise<void> | void }>,
      sessionAgentMap,
      sessionStore,
      logger: silentLogger(),
      now: NOW,
    });

    expect(result.closedOrphans).toBe(0);
    expect(tCurrent.closed).toBe(false);
  });
});
