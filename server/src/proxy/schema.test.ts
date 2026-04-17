import { describe, it, expect, mock, spyOn, afterEach, beforeEach } from "bun:test";
import { tmpdir } from "node:os";

// Enable logs explicitly for this test suite since it tests logging output
process.env.TEST_LOGS = "1";

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { fetchGameCommands, applyPatches, DENIED_TOOLS, checkSchemaDrift, PARAM_REMAPS, resolveGameTools, invalidateSchemaCache, serverSchemaToZod, V2_TO_V1_PARAM_MAP } from "./schema.js";
import { setConfigForTesting } from "../config.js";

// Set up test FLEET_DIR before importing config-dependent code
const testFleetDir = join(tmpdir(), `schema-test-${Date.now()}`);
mkdirSync(testFleetDir, { recursive: true });

setConfigForTesting({
  agents: [],
} as unknown as import("../config/types.js").GantryConfig);

describe("fetchGameCommands", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
  });

  it("fetches tools via MCP protocol", async () => {
    const mockTools = {
      result: {
        tools: [
          { name: "mine", description: "Mine ore", inputSchema: { type: "object", properties: {} } },
          { name: "travel", description: "Travel to POI", inputSchema: { type: "object", properties: { target_poi: { type: "string" } } } },
        ],
      },
    };

    let callCount = 0;
    global.fetch = mock(async (_url: string, opts: any) => {
      callCount++;
      const body = JSON.parse(opts.body);

      if (body.method === "initialize") {
        return {
          ok: true,
          headers: new Headers({ "mcp-session-id": "test-session-123" }),
          json: () => Promise.resolve({ result: { protocolVersion: "2025-03-26" } }),
          text: () => Promise.resolve(JSON.stringify({ result: { protocolVersion: "2025-03-26" } })),
        };
      }

      if (body.method === "notifications/initialized") {
        return { ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("{}") };
      }

      if (body.method === "tools/list") {
        return { ok: true, json: () => Promise.resolve(mockTools), text: () => Promise.resolve(JSON.stringify(mockTools)) };
      }

      return { ok: false };
    }) as any;

    const { commands, serverTools } = await fetchGameCommands("http://localhost:8080/mcp");
    expect(commands).toHaveLength(2);
    expect(commands[0].name).toBe("mine");
    expect(commands[1].description).toBe("Travel to POI");
    expect(serverTools).toHaveLength(2);
    expect(callCount).toBe(3); // initialize, notifications/initialized, tools/list
  });

  it("returns empty arrays on fetch failure", async () => {
    global.fetch = mock(() => Promise.reject(new Error("connection refused"))) as any;
    const { commands, serverTools } = await fetchGameCommands("http://localhost:8080/mcp");
    expect(commands).toEqual([]);
    expect(serverTools).toEqual([]);
  });

  it("returns empty arrays when initialize returns non-ok", async () => {
    global.fetch = mock(async () => ({
      ok: false,
      status: 404,
    })) as any;
    const { commands } = await fetchGameCommands("http://localhost:8080/mcp");
    expect(commands).toEqual([]);
  });

  it("returns empty arrays when no session ID in response", async () => {
    global.fetch = mock(async () => ({
      ok: true,
      headers: new Headers({}),
      json: () => Promise.resolve({ result: {} }),
      text: () => Promise.resolve(JSON.stringify({ result: {} })),
    })) as any;
    const { commands } = await fetchGameCommands("http://localhost:8080/mcp");
    expect(commands).toEqual([]);
  });
});

describe("applyPatches", () => {
  it("returns commands unchanged when no patches match", () => {
    const commands = [
      { name: "mine", description: "Mine ore", parameters: {} },
      { name: "travel", description: "Travel", parameters: {} },
    ];
    const patched = applyPatches(commands);
    expect(patched).toEqual(commands);
  });

  it("does not crash with empty commands", () => {
    const patched = applyPatches([]);
    expect(patched).toEqual([]);
  });
});

describe("DENIED_TOOLS", () => {
  it("contains expected denied tools", () => {
    expect(DENIED_TOOLS.has("register")).toBe(true);
    expect(DENIED_TOOLS.has("deposit_credits")).toBe(true);
    expect(DENIED_TOOLS.has("faction_declare_war")).toBe(true);
    // self_destruct and jettison moved to agentDeniedTools (unblocked for sable-thorn)
    expect(DENIED_TOOLS.has("self_destruct")).toBe(false);
    expect(DENIED_TOOLS.has("jettison")).toBe(false);
  });

  it("does not deny common game tools", () => {
    expect(DENIED_TOOLS.has("mine")).toBe(false);
    expect(DENIED_TOOLS.has("sell")).toBe(false);
    expect(DENIED_TOOLS.has("travel")).toBe(false);
  });
});

describe("PARAM_REMAPS", () => {
  it("contains known remaps", () => {
    expect(PARAM_REMAPS.jump).toEqual({ system_id: "target_system" });
    expect(PARAM_REMAPS.travel).toEqual({ destination_id: "target_poi", poi_id: "target_poi" });
    expect(PARAM_REMAPS.find_route).toEqual({ destination_system_id: "target_system" });
    expect(PARAM_REMAPS.search_systems).toEqual({ name: "query" });
  });
});



describe("V2_TO_V1_PARAM_MAP", () => {
  it("contains known v2-to-v1 remaps", () => {
    expect(V2_TO_V1_PARAM_MAP.jump).toEqual({ id: "target_system" });
    expect(V2_TO_V1_PARAM_MAP.travel).toEqual({ id: "target_poi" });
    expect(V2_TO_V1_PARAM_MAP.send_gift).toEqual({ id: "target_id", text: "item_id" });
    expect(V2_TO_V1_PARAM_MAP.faction_upgrade).toEqual({ id: "facility_id", text: "facility_type" });
  });

  it("install_mod and uninstall_mod map id to module_id", () => {
    // The game API uses module_id (confirmed via /api/v1/help topic=install_mod).
    // Agents send generic 'id' which remaps to module_id; module_id passes through unchanged.
    expect(V2_TO_V1_PARAM_MAP.install_mod).toEqual({ id: "module_id" });
    expect(V2_TO_V1_PARAM_MAP.uninstall_mod).toEqual({ id: "module_id" });
  });

  it("bug #4 fix: estimate_purchase maps id to item_id", () => {
    // estimate_purchase needs id → item_id remap so agents can call it with generic id param
    expect(V2_TO_V1_PARAM_MAP.estimate_purchase).toEqual({ id: "item_id" });
  });
});

describe("checkSchemaDrift - schema fix verification", () => {
  it("forum_upvote uses reply_id and thread_id (not post_id)", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { forum_upvote: ["reply_id", "thread_id"] },
      [{ name: "forum_upvote", inputSchema: { type: "object", properties: { reply_id: {}, thread_id: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });

  it("modify_order uses new_price and orders (not quantity/price_each)", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { modify_order: ["order_id", "new_price", "orders"] },
      [{ name: "modify_order", inputSchema: { type: "object", properties: { order_id: {}, new_price: {}, orders: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });

  it("get_chat_history uses target_id (not player_id) plus before and limit", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { get_chat_history: ["channel", "target_id", "before", "limit"] },
      [{ name: "get_chat_history", inputSchema: { type: "object", properties: { channel: {}, target_id: {}, before: {}, limit: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });

  it("attack has target_id only (weapon_idx removed)", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { attack: ["target_id"] },
      [{ name: "attack", inputSchema: { type: "object", properties: { target_id: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });

  it("cancel_order includes order_ids for batch cancellation", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { cancel_order: ["order_id", "order_ids"] },
      [{ name: "cancel_order", inputSchema: { type: "object", properties: { order_id: {}, order_ids: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });

  it("commission_ship includes provide_materials", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { commission_ship: ["ship_class", "provide_materials"] },
      [{ name: "commission_ship", inputSchema: { type: "object", properties: { ship_class: {}, provide_materials: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });
});

describe("resolveGameTools", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    invalidateSchemaCache(); // Ensure tests don't use stale cache
  });

  afterEach(() => {
    global.fetch = originalFetch;
    mock.restore();
    invalidateSchemaCache(); // Clean up cache written during test
  });

  function mockMcpFetch(tools: { name: string; description?: string; inputSchema?: any }[]) {
    global.fetch = mock(async (_url: string, opts: any) => {
      const body = JSON.parse(opts.body);
      if (body.method === "initialize") {
        return {
          ok: true,
          headers: new Headers({ "mcp-session-id": "test-session" }),
          json: () => Promise.resolve({ result: { protocolVersion: "2025-03-26" } }),
          text: () => Promise.resolve(JSON.stringify({ result: { protocolVersion: "2025-03-26" } })),
        };
      }
      if (body.method === "notifications/initialized") {
        return { ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve("{}") };
      }
      if (body.method === "tools/list") {
        return { ok: true, json: () => Promise.resolve({ result: { tools } }), text: () => Promise.resolve(JSON.stringify({ result: { tools } })) };
      }
      return { ok: false };
    }) as any;
  }

  it("returns dynamic tools when server is reachable", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    mockMcpFetch([
      { name: "mine", description: "Mine ore from asteroids" },
      { name: "sell", description: "Sell items at station" },
      { name: "travel", description: "Travel to a POI" },
    ]);

    const fallback = ["mine", "sell", "old_tool"];
    const result = await resolveGameTools("http://localhost:8080/mcp", fallback);

    expect(result.tools).toEqual(["mine", "sell", "travel"]);
    expect(result.descriptions.get("mine")).toBe("Mine ore from asteroids");
    expect(result.descriptions.get("sell")).toBe("Sell items at station");
    expect(result.descriptions.get("travel")).toBe("Travel to a POI");
    logSpy.mockRestore();
  });

  it("falls back to STATIC_GAME_TOOLS on fetch failure", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    global.fetch = mock(() => Promise.reject(new Error("connection refused"))) as any;

    const fallback = ["mine", "sell", "travel"];
    const result = await resolveGameTools("http://localhost:8080/mcp", fallback);

    expect(result.tools).toEqual(fallback);
    expect(result.descriptions.size).toBe(0);
    logSpy.mockRestore();
  });

  it("filters DENIED_TOOLS from dynamic list", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    mockMcpFetch([
      { name: "mine", description: "Mine ore" },
      { name: "register", description: "Register account" },
      { name: "self_destruct", description: "Blow up your ship" },
      { name: "sell", description: "Sell items" },
      { name: "jettison", description: "Dump cargo" },
    ]);

    const fallback = ["mine", "sell"];
    const result = await resolveGameTools("http://localhost:8080/mcp", fallback);

    expect(result.tools).toContain("mine");
    expect(result.tools).toContain("sell");
    expect(result.tools).not.toContain("register");
    // self_destruct and jettison are no longer in DENIED_TOOLS (moved to agentDeniedTools)
    expect(result.tools).toContain("self_destruct");
    expect(result.tools).toContain("jettison");
    expect(result.tools).toHaveLength(4);
    logSpy.mockRestore();
  });

  it("runs schema drift detection when ourSchemaParams provided", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    mockMcpFetch([
      { name: "mine", description: "Mine ore", inputSchema: { type: "object", properties: {} } },
    ]);

    const fallback = ["mine"];
    await resolveGameTools("http://localhost:8080/mcp", fallback, { mine: [] });

    // Should log drift detection result
    const driftLog = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("[schema]") && call[0].includes("drift"),
    );
    expect(driftLog).toBeDefined();
    logSpy.mockRestore();
  });

  it("logs new and removed tools vs static fallback", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    mockMcpFetch([
      { name: "mine", description: "Mine ore" },
      { name: "new_tool", description: "Brand new tool" },
    ]);

    const fallback = ["mine", "old_tool"];
    await resolveGameTools("http://localhost:8080/mcp", fallback);

    const newLog = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("New tools from server"),
    );
    const removedLog = logSpy.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("Tools in static list but not on server"),
    );
    expect(newLog).toBeDefined();
    expect(removedLog).toBeDefined();
    logSpy.mockRestore();
  });
});

describe("checkSchemaDrift", () => {
  it("reports no drift when schemas match", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { mine: [] },
      [{ name: "mine", inputSchema: { type: "object", properties: {} } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });

  it("reports drift when server has extra params", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { attack: ["target_id"] },
      [{ name: "attack", inputSchema: { type: "object", properties: { target_id: {}, weapon_idx: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Drift: attack"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("server extra: [weapon_idx]"));
    logSpy.mockRestore();
  });

  it("accounts for known remaps (no false drift)", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { jump: ["system_id"] },
      [{ name: "jump", inputSchema: { type: "object", properties: { target_system: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No schema drift"));
    logSpy.mockRestore();
  });

  it("reports our extra params not on server", () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    checkSchemaDrift(
      { sell: ["item_id", "quantity", "auto_list"] },
      [{ name: "sell", inputSchema: { type: "object", properties: { item_id: {}, quantity: {} } } }],
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("our extra: [auto_list]"));
    logSpy.mockRestore();
  });
});

describe("serverSchemaToZod", () => {
  it("converts string params to z.string()", () => {
    const tool = {
      name: "test",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    };
    const schema = serverSchemaToZod(tool);
    expect(schema.safeParse({ name: "hello" }).success).toBe(true);
    expect(schema.safeParse({ name: 123 }).success).toBe(false);
  });

  it("converts number and integer params to z.number()", () => {
    const tool = {
      name: "test",
      inputSchema: {
        type: "object",
        properties: { qty: { type: "integer" }, price: { type: "number" } },
        required: ["qty", "price"],
      },
    };
    const schema = serverSchemaToZod(tool);
    expect(schema.safeParse({ qty: 5, price: 9.99 }).success).toBe(true);
    expect(schema.safeParse({ qty: "five", price: 9.99 }).success).toBe(false);
  });

  it("converts boolean params to z.boolean()", () => {
    const tool = {
      name: "test",
      inputSchema: { type: "object", properties: { active: { type: "boolean" } }, required: ["active"] },
    };
    const schema = serverSchemaToZod(tool);
    expect(schema.safeParse({ active: true }).success).toBe(true);
    expect(schema.safeParse({ active: "true" }).success).toBe(false);
  });

  it("converts enum params to z.enum()", () => {
    const tool = {
      name: "test",
      inputSchema: {
        type: "object",
        properties: { stance: { type: "string", enum: ["aggressive", "defensive", "flee"] } },
        required: ["stance"],
      },
    };
    const schema = serverSchemaToZod(tool);
    expect(schema.safeParse({ stance: "aggressive" }).success).toBe(true);
    expect(schema.safeParse({ stance: "invalid" }).success).toBe(false);
  });

  it("makes non-required params optional", () => {
    const tool = {
      name: "test",
      inputSchema: {
        type: "object",
        properties: { required_param: { type: "string" }, optional_param: { type: "string" } },
        required: ["required_param"],
      },
    };
    const schema = serverSchemaToZod(tool);
    // Missing required_param should fail
    expect(schema.safeParse({ optional_param: "hi" }).success).toBe(false);
    // Missing optional_param should succeed
    expect(schema.safeParse({ required_param: "hi" }).success).toBe(true);
  });

  it("returns passthrough optional for empty or missing properties", () => {
    const toolNoProps = { name: "test", inputSchema: { type: "object", properties: {} } };
    const toolNoSchema = { name: "test" };
    const schema1 = serverSchemaToZod(toolNoProps);
    const schema2 = serverSchemaToZod(toolNoSchema);
    // Both should accept anything (passthrough)
    expect(schema1.safeParse(undefined).success).toBe(true);
    expect(schema2.safeParse(undefined).success).toBe(true);
  });

  it("skips session_id param", () => {
    const tool = {
      name: "test",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          item_id: { type: "string" },
        },
        required: ["session_id", "item_id"],
      },
    };
    const schema = serverSchemaToZod(tool);
    // session_id should not be in the schema — passing without it should succeed
    expect(schema.safeParse({ item_id: "abc" }).success).toBe(true);
  });
});
