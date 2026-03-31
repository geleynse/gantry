import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createMcpServer, OUR_SCHEMA_PARAMS } from "./mcp-factory.js";
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
