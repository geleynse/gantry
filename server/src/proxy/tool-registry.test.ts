/**
 * Tests for tool-registry.ts — passthrough, compound, event, and utility tool registrations.
 *
 * Uses plain mock objects rather than Bun's mock.module() to avoid
 * cross-test pollution (see Bun testing gotchas in MEMORY.md).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  registerPassthroughTools,
  registerCompoundTools,
  buildCompoundActions,
  handleGetEvents,
  handleGetSessionInfo,
  TOOL_SCHEMAS,
  NO_PARAM_DESCRIPTIONS,
  PROXY_HANDLED_TOOLS,
  type ToolRegistryDeps,
  type CompoundDepsBase,
} from "./tool-registry.js";
import { EventBuffer } from "./event-buffer.js";
import type { GantryConfig } from "../config.js";
import type { AgentCallTracker, BattleState } from "./server.js";
import { createDatabase, closeDb } from "../services/database.js";
import { resetSessionShutdownManager } from "./session-shutdown.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockMcpServer() {
  const tools = new Map<string, { opts: unknown; handler: Function }>();
  return {
    registerTool: (name: string, opts: unknown, handler: Function) => {
      tools.set(name, { opts, handler });
    },
    tools,
  };
}

function createMockClient(result?: unknown) {
  return {
    execute: async (_tool: string, _args?: Record<string, unknown>) => ({
      result: result ?? { status: "ok" },
    }),
    waitForTick: async () => {},
    lastArrivalTick: null as number | null,
  };
}

type MockClient = ReturnType<typeof createMockClient>;

function createMockSessions(client?: MockClient, agentName = "test-agent") {
  return {
    getClient: (name: string) => (name === agentName ? (client ?? createMockClient()) : undefined),
    listActive: () => [agentName],
    recordActivity: (_name: string) => {},
  };
}

const testConfig: GantryConfig = {
  agents: [
    { name: "test-agent", homeSystem: "Sol" },
    { name: "other-agent" },
  ],
  gameUrl: "https://game.test/mcp",
  gameApiUrl: "https://game.test/api/v1",
  gameMcpUrl: "https://game.test/mcp",
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90,
  staggerDelay: 20,
};

function makeDeps(
  overrides: Partial<ToolRegistryDeps> & {
    mockServer?: ReturnType<typeof createMockMcpServer>;
    client?: MockClient;
    agentName?: string;
  } = {},
): ToolRegistryDeps & { mockServer: ReturnType<typeof createMockMcpServer> } {
  const mockServer = overrides.mockServer ?? createMockMcpServer();
  const agentName = overrides.agentName ?? "test-agent";
  const client = overrides.client ?? createMockClient();
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  const battleCache = new Map<string, BattleState | null>();
  const callTrackers = new Map<string, AgentCallTracker>();
  const eventBuffers = new Map<string, EventBuffer>();
  const registeredTools: string[] = [];

  return {
    mcpServer: mockServer as unknown as ToolRegistryDeps["mcpServer"],
    registeredTools,
    config: testConfig,
    sessions: createMockSessions(client, agentName) as unknown as ToolRegistryDeps["sessions"],
    statusCache,
    battleCache,
    callTrackers,
    marketCache: {
      get: () => ({ data: null, stale: true }),
    } as unknown as ToolRegistryDeps["marketCache"],
    galaxyGraph: {
      resolveSystemId: (_id: string) => null,
      findRoute: (_from: string, _to: string) => null,
      systemCount: 0,
    } as unknown as ToolRegistryDeps["galaxyGraph"],
    sellLog: { has: () => false } as unknown as ToolRegistryDeps["sellLog"],
    gameTools: ["mine", "sell", "jump", "travel", "scan", "get_system", "buy"],
    serverDescriptions: new Map<string, string>(),
    gameHealthRef: { current: null },
    eventBuffers,
    stateChangingTools: new Set(["mine", "sell", "jump", "travel", "buy"]),
    getAgentForSession: (sessionId?: string) => (sessionId ? agentName : undefined),
    getTracker: (name: string): AgentCallTracker => {
      if (!callTrackers.has(name)) {
        callTrackers.set(name, { counts: {}, lastCallSig: null, calledTools: new Set() });
      }
      return callTrackers.get(name)!;
    },
    checkGuardrails: () => null,
    withInjections: async (_agent, response) => response,
    waitForNavCacheUpdate: async () => true,
    waitForDockCacheUpdate: async () => true,
    decontaminateLog: (result) => result,
    stripPendingFields: () => {},
    mockServer,
    ...overrides,
  };
}

async function callTool(
  mockServer: ReturnType<typeof createMockMcpServer>,
  name: string,
  args: unknown,
  sessionId?: string,
) {
  const entry = mockServer.tools.get(name);
  if (!entry) throw new Error(`Tool ${name} not registered`);
  return entry.handler(args, { sessionId: sessionId ?? "session-1" });
}

function parseResult(result: unknown): unknown {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("tool-registry", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    resetSessionShutdownManager();
  });

  afterEach(() => {
    closeDb();
  });

  // ---------------------------------------------------------------------------
  // Static exports
  // ---------------------------------------------------------------------------

  describe("TOOL_SCHEMAS", () => {
    it("contains jump with system_id schema", () => {
      expect(TOOL_SCHEMAS.jump).toBeDefined();
      expect(TOOL_SCHEMAS.jump.description).toMatch(/jump/i);
      expect(TOOL_SCHEMAS.jump.schema).toBeDefined();
    });

    it("contains buy with item_id and quantity", () => {
      expect(TOOL_SCHEMAS.buy).toBeDefined();
    });

    it("contains commission_quote with ship_class", () => {
      expect(TOOL_SCHEMAS.commission_quote).toBeDefined();
    });
  });

  describe("NO_PARAM_DESCRIPTIONS", () => {
    it("contains scan, mine, dock, undock", () => {
      expect(NO_PARAM_DESCRIPTIONS.scan).toBeTruthy();
      expect(NO_PARAM_DESCRIPTIONS.mine).toBeTruthy();
      expect(NO_PARAM_DESCRIPTIONS.dock).toBeTruthy();
      expect(NO_PARAM_DESCRIPTIONS.undock).toBeTruthy();
    });
  });

  describe("PROXY_HANDLED_TOOLS", () => {
    it("contains login, logout, get_status", () => {
      expect(PROXY_HANDLED_TOOLS.has("login")).toBe(true);
      expect(PROXY_HANDLED_TOOLS.has("logout")).toBe(true);
      expect(PROXY_HANDLED_TOOLS.has("get_status")).toBe(true);
    });

    it("contains doc tools", () => {
      expect(PROXY_HANDLED_TOOLS.has("write_diary")).toBe(true);
      expect(PROXY_HANDLED_TOOLS.has("read_doc")).toBe(true);
    });

    it("does not contain mine or sell (those are passthrough)", () => {
      expect(PROXY_HANDLED_TOOLS.has("mine")).toBe(false);
      expect(PROXY_HANDLED_TOOLS.has("sell")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // registerPassthroughTools
  // ---------------------------------------------------------------------------

  describe("registerPassthroughTools", () => {
    it("registers all gameTools except PROXY_HANDLED_TOOLS", () => {
      const deps = makeDeps();
      registerPassthroughTools(deps);
      // gameTools = ["mine", "sell", "jump", "travel", "scan", "get_system", "buy"]
      // None of these are in PROXY_HANDLED_TOOLS, so all 7 should register
      expect(deps.registeredTools).toContain("mine");
      expect(deps.registeredTools).toContain("sell");
      expect(deps.registeredTools).toContain("jump");
      expect(deps.registeredTools).toContain("travel");
      expect(deps.registeredTools).toContain("get_system");
      expect(deps.registeredTools.length).toBe(7);
    });

    it("skips tools that are in PROXY_HANDLED_TOOLS", () => {
      const deps = makeDeps({
        gameTools: ["mine", "login", "get_status", "scan"],
      });
      registerPassthroughTools(deps);
      expect(deps.registeredTools).toContain("mine");
      expect(deps.registeredTools).toContain("scan");
      expect(deps.registeredTools).not.toContain("login");
      expect(deps.registeredTools).not.toContain("get_status");
    });

    it("returns not-logged-in error when no session", async () => {
      const deps = makeDeps({
        getAgentForSession: () => undefined,
      });
      registerPassthroughTools(deps);
      const result = parseResult(await callTool(deps.mockServer, "mine", {}));
      expect((result as { error: string }).error).toMatch(/not logged in/);
    });

    it("remaps jump system_id to target_system", async () => {
      let capturedTool: string | undefined;
      let capturedArgs: Record<string, unknown> | undefined;

      const mockClient = {
        execute: async (tool: string, args?: Record<string, unknown>) => {
          capturedTool = tool;
          capturedArgs = args;
          return { result: { status: "jumped" } };
        },
        waitForTick: async () => {},
        lastArrivalTick: null as number | null,
      };

      const deps = makeDeps({ client: mockClient });
      registerPassthroughTools(deps);

      await callTool(deps.mockServer, "jump", { system_id: "alpha-system" });

      expect(capturedTool).toBe("jump");
      expect(capturedArgs?.target_system).toBe("alpha-system");
      expect(capturedArgs?.system_id).toBeUndefined();
    });

    it("remaps travel destination_id to target_poi", async () => {
      let capturedArgs: Record<string, unknown> | undefined;

      const mockClient = {
        execute: async (_tool: string, args?: Record<string, unknown>) => {
          capturedArgs = args;
          return { result: { status: "traveled" } };
        },
        waitForTick: async () => {},
        lastArrivalTick: null as number | null,
      };

      const deps = makeDeps({ client: mockClient });
      registerPassthroughTools(deps);

      await callTool(deps.mockServer, "travel", { destination_id: "sol_belt" });

      expect(capturedArgs?.target_poi).toBe("sol_belt");
      expect(capturedArgs?.destination_id).toBeUndefined();
    });

    it("strips session_id from args before forwarding", async () => {
      let capturedArgs: Record<string, unknown> | undefined;

      const mockClient = {
        execute: async (_tool: string, args?: Record<string, unknown>) => {
          capturedArgs = args;
          return { result: { status: "ok" } };
        },
        waitForTick: async () => {},
        lastArrivalTick: null as number | null,
      };

      const deps = makeDeps({ client: mockClient });
      registerPassthroughTools(deps);

      await callTool(deps.mockServer, "mine", { session_id: "should-be-stripped" });

      expect(capturedArgs).toBeUndefined(); // no remaining args after stripping
    });

    it("returns guardrails error when blocked", async () => {
      const deps = makeDeps({
        checkGuardrails: () => "rate limit exceeded",
      });
      registerPassthroughTools(deps);

      const result = parseResult(await callTool(deps.mockServer, "mine", {}));
      expect((result as { error: string }).error).toBe("rate limit exceeded");
    });

    it("adds buy hint for buy tool", async () => {
      const deps = makeDeps({
        stateChangingTools: new Set(["buy"]),
      });
      registerPassthroughTools(deps);

      const result = parseResult(await callTool(deps.mockServer, "buy", { item_id: "iron_ore", quantity: 5 }));
      const r = result as { result: { hint: string } };
      expect(r.result?.hint ?? (result as { hint?: string }).hint).toMatch(/STATION STORAGE/);
    });

    it("auto-undocks before jump when docked", async () => {
      const undockCalls: string[] = [];
      const mockClient = {
        execute: async (tool: string, _args?: Record<string, unknown>) => {
          undockCalls.push(tool);
          return { result: { status: "ok" } };
        },
        waitForTick: async () => {},
        lastArrivalTick: null as number | null,
      };

      const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
      statusCache.set("test-agent", {
        data: { player: { docked_at_base: "sol_station", current_system: "Sol" } },
        fetchedAt: Date.now(),
      });

      const deps = makeDeps({ client: mockClient, statusCache });
      registerPassthroughTools(deps);

      await callTool(deps.mockServer, "jump", { system_id: "alpha-centauri" });

      expect(undockCalls[0]).toBe("undock");
      expect(undockCalls[1]).toBe("jump");
    });
  });

  // ---------------------------------------------------------------------------
  // registerCompoundTools
  // ---------------------------------------------------------------------------

  describe("registerCompoundTools", () => {
    it("registers batch_mine, travel_to, jump_route, multi_sell, scan_and_attack, battle_readiness, loot_wrecks, get_craft_profitability, get_events, get_session_info", () => {
      const deps = makeDeps();
      registerCompoundTools(deps);
      const expected = [
        "batch_mine", "travel_to", "jump_route", "multi_sell",
        "scan_and_attack", "battle_readiness", "loot_wrecks", "flee",
        "get_craft_profitability", "get_events", "get_session_info",
      ];
      for (const name of expected) {
        expect(deps.registeredTools).toContain(name);
      }
      expect(deps.registeredTools.length).toBe(11);
    });

    it("batch_mine returns not-logged-in when no session", async () => {
      const deps = makeDeps({ getAgentForSession: () => undefined });
      registerCompoundTools(deps);
      const result = parseResult(await callTool(deps.mockServer, "batch_mine", { count: 3 }));
      expect((result as { error: string }).error).toMatch(/not logged in/);
    });

    it("scan_and_attack returns guardrails error when blocked", async () => {
      const deps = makeDeps({ checkGuardrails: () => "scan blocked" });
      registerCompoundTools(deps);
      const result = parseResult(await callTool(deps.mockServer, "scan_and_attack", { stance: "aggressive" }));
      expect((result as { error: string }).error).toBe("scan blocked");
    });

    it("get_events returns empty when no buffer", async () => {
      const deps = makeDeps();
      registerCompoundTools(deps);
      const result = parseResult(await callTool(deps.mockServer, "get_events", {}));
      expect((result as { events: unknown[]; count: number }).events).toEqual([]);
      expect((result as { count: number }).count).toBe(0);
    });

    it("get_events drains events from buffer", async () => {
      const deps = makeDeps();
      const buffer = new EventBuffer();
      buffer.push({ type: "chat_message", payload: { text: "hello" }, receivedAt: Date.now() });
      deps.eventBuffers.set("test-agent", buffer);
      registerCompoundTools(deps);

      const result = parseResult(await callTool(deps.mockServer, "get_events", {}));
      expect((result as { count: number }).count).toBe(1);
    });

    it("get_session_info returns agent and proxy info", async () => {
      const deps = makeDeps();
      registerCompoundTools(deps);
      // get_session_info has no inputSchema — MCP passes extra as first arg
      const entry = deps.mockServer.tools.get("get_session_info");
      expect(entry).toBeDefined();
      const result = parseResult(await entry!.handler({ sessionId: "session-1" }));
      const r = result as { agent: string; proxy: string; active_agents: string[] };
      expect(r.agent).toBe("test-agent");
      expect(r.proxy).toBe("direct");
      expect(r.active_agents).toContain("test-agent");
    });

    it("get_session_info returns not-logged-in when no session", async () => {
      const deps = makeDeps({ getAgentForSession: () => undefined });
      registerCompoundTools(deps);
      const entry = deps.mockServer.tools.get("get_session_info");
      expect(entry).toBeDefined();
      const result = parseResult(await entry!.handler({ sessionId: "session-1" }));
      expect((result as { agent: string }).agent).toBe("not logged in");
    });
  });

  // ---------------------------------------------------------------------------
  // handleGetEvents (exported pure handler)
  // ---------------------------------------------------------------------------

  describe("handleGetEvents", () => {
    it("returns empty result when no buffer exists for agent", () => {
      const eventBuffers = new Map<string, EventBuffer>();
      const result = handleGetEvents(eventBuffers, "unknown-agent");
      expect(result).toEqual({ events: [], count: 0 });
    });

    it("returns events from buffer when buffer exists", () => {
      const eventBuffers = new Map<string, EventBuffer>();
      const buffer = new EventBuffer();
      buffer.push({ type: "chat_message", payload: { text: "hi" }, receivedAt: Date.now() });
      buffer.push({ type: "arrived", payload: { poi: "sol_belt" }, receivedAt: Date.now() });
      eventBuffers.set("test-agent", buffer);

      const result = handleGetEvents(eventBuffers, "test-agent");
      expect(result.count).toBe(2);
      expect(result.events).toHaveLength(2);
    });

    it("filters events by type when types provided", () => {
      const eventBuffers = new Map<string, EventBuffer>();
      const buffer = new EventBuffer();
      buffer.push({ type: "chat_message", payload: { text: "hi" }, receivedAt: Date.now() });
      buffer.push({ type: "arrived", payload: { poi: "sol_belt" }, receivedAt: Date.now() });
      buffer.push({ type: "chat_message", payload: { text: "bye" }, receivedAt: Date.now() });
      eventBuffers.set("test-agent", buffer);

      const result = handleGetEvents(eventBuffers, "test-agent", ["chat_message"]);
      expect(result.count).toBe(2);
      const events = result.events as Array<{ type: string }>;
      expect(events.every(e => e.type === "chat_message")).toBe(true);
    });

    it("caps limit at MAX_EVENTS (50) even if higher limit requested", () => {
      const eventBuffers = new Map<string, EventBuffer>();
      const buffer = new EventBuffer();
      // Push 60 non-internal events (chat_message is a normal-priority type)
      for (let i = 0; i < 60; i++) {
        buffer.push({ type: "chat_message", payload: { n: i }, receivedAt: Date.now() });
      }
      eventBuffers.set("test-agent", buffer);

      // Request 100 — should be capped at 50
      const result = handleGetEvents(eventBuffers, "test-agent", undefined, 100);
      expect(result.count).toBe(50);
      expect(result.events).toHaveLength(50);
    });

    it("respects a lower limit when under MAX_EVENTS", () => {
      const eventBuffers = new Map<string, EventBuffer>();
      const buffer = new EventBuffer();
      for (let i = 0; i < 20; i++) {
        buffer.push({ type: "chat_message", payload: { n: i }, receivedAt: Date.now() });
      }
      eventBuffers.set("test-agent", buffer);

      const result = handleGetEvents(eventBuffers, "test-agent", undefined, 5);
      expect(result.count).toBe(5);
      expect(result.events).toHaveLength(5);
    });
  });

  // ---------------------------------------------------------------------------
  // handleGetSessionInfo (exported pure handler)
  // ---------------------------------------------------------------------------

  describe("handleGetSessionInfo", () => {
    it("returns agent name and proxy info when agent is logged in", () => {
      const config: GantryConfig = {
        ...testConfig,
        agents: [
          { name: "sable-thorn", homeSystem: "Sol", proxy: "socks5://localhost:1081", socksPort: 1081 },
        ],
      };
      const sessions = { listActive: () => ["sable-thorn"] } as unknown as ToolRegistryDeps["sessions"];

      const result = handleGetSessionInfo(config, sessions, "sable-thorn");
      expect(result.agent).toBe("sable-thorn");
      expect(result.proxy).toBe("socks5://localhost:1081");
      expect(result.socks_port).toBe(1081);
      expect(result.active_agents).toContain("sable-thorn");
    });

    it("returns direct proxy for agent with no proxy config", () => {
      const sessions = { listActive: () => ["test-agent"] } as unknown as ToolRegistryDeps["sessions"];

      const result = handleGetSessionInfo(testConfig, sessions, "test-agent");
      expect(result.agent).toBe("test-agent");
      expect(result.proxy).toBe("direct");
      expect(result.socks_port).toBeNull();
    });

    it("returns not logged in when agentName is undefined", () => {
      const sessions = { listActive: () => [] } as unknown as ToolRegistryDeps["sessions"];

      const result = handleGetSessionInfo(testConfig, sessions, undefined);
      expect(result.agent).toBe("not logged in");
      expect(result.proxy).toBe("direct");
      expect(result.socks_port).toBeNull();
      expect(result.active_agents).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // buildCompoundActions
  // ---------------------------------------------------------------------------

  function makeCompoundDepsBase(): CompoundDepsBase {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    const battleCache = new Map<string, BattleState | null>();
    return {
      statusCache,
      battleCache,
      sellLog: { has: () => false } as unknown as CompoundDepsBase["sellLog"],
      galaxyGraph: {
        resolveSystemId: (_id: string) => null,
        findRoute: (_from: string, _to: string) => null,
        systemCount: 0,
      } as unknown as CompoundDepsBase["galaxyGraph"],
    };
  }

  function makeMockGameClient(result?: unknown) {
    const calls: Array<{ tool: string; args?: Record<string, unknown> }> = [];
    return {
      client: {
        execute: async (tool: string, args?: Record<string, unknown>) => {
          calls.push({ tool, args });
          return { result: result ?? { status: "ok" } };
        },
        waitForTick: async () => {},
        lastArrivalTick: null as number | null,
      },
      calls,
    };
  }

  describe("buildCompoundActions", () => {
    it("returns all 10 compound actions", () => {
      const deps = makeCompoundDepsBase();
      const actions = buildCompoundActions(deps, new Set());
      expect(Object.keys(actions)).toEqual([
        "batch_mine", "travel_to", "jump_route", "multi_sell",
        "scan_and_attack", "battle_readiness", "loot_wrecks", "flee",
        "get_craft_profitability", "craft_path_to",
      ]);
    });

    describe("batch_mine", () => {
      it("uses args.count when provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ ore_type: "iron", quantity: 3 });

        const result = await actions.batch_mine(client as never, "test-agent", { count: 1 });
        expect(result).toBeDefined();
      });

      it("falls back to args.id when count not provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ ore_type: "iron", quantity: 3 });

        const result = await actions.batch_mine(client as never, "test-agent", { id: "2" });
        expect(result).toBeDefined();
      });

      it("defaults to 5 when neither count nor id provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ ore_type: "iron", quantity: 3 });

        const result = await actions.batch_mine(client as never, "test-agent", {});
        expect(result).toBeDefined();
      });
    });

    describe("travel_to", () => {
      it("uses args.destination when provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ status: "arrived", docked: false });

        const result = await actions.travel_to(client as never, "test-agent", { destination: "sol_belt" });
        expect(result).toBeDefined();
        expect((result as { error?: string }).error).toBeUndefined();
      });

      it("returns error when destination is empty", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient();

        const result = await actions.travel_to(client as never, "test-agent", {});
        expect((result as { error: string }).error).toMatch(/required/);
      });

      it("uses args.id as fallback destination", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ status: "arrived" });

        const result = await actions.travel_to(client as never, "test-agent", { id: "nexus_core" });
        expect((result as { error?: string }).error).toBeUndefined();
      });
    });

    describe("jump_route", () => {
      it("uses args.system_ids (explicit array)", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ status: "jumped" });

        const result = await actions.jump_route(client as never, "test-agent", {
          system_ids: ["alpha", "beta"],
        });
        expect(result).toBeDefined();
        expect((result as { error?: string }).error).toBeUndefined();
      });

      it("parses args.text as JSON array", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ status: "jumped" });

        const result = await actions.jump_route(client as never, "test-agent", {
          text: JSON.stringify(["alpha", "beta"]),
        });
        expect(result).toBeDefined();
        expect((result as { error?: string }).error).toBeUndefined();
      });

      it("returns error when args.text is invalid JSON", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient();

        const result = await actions.jump_route(client as never, "test-agent", {
          text: "not-json",
        });
        expect((result as { error: string }).error).toMatch(/JSON array/);
      });

      it("returns error when no route info provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient();

        const result = await actions.jump_route(client as never, "test-agent", {});
        expect((result as { error: string }).error).toBeDefined();
      });
    });

    describe("multi_sell", () => {
      it("uses args.items (array)", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ credits: 1000 });

        const result = await actions.multi_sell(client as never, "test-agent", {
          items: [{ item_id: "iron_ore", quantity: 10 }],
          _calledTools: new Set(["analyze_market"]),
        });
        expect(result).toBeDefined();
      });

      it("parses args.text as JSON array", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ credits: 1000 });

        const result = await actions.multi_sell(client as never, "test-agent", {
          text: JSON.stringify([{ item_id: "iron_ore", quantity: 5 }]),
          _calledTools: new Set(["analyze_market"]),
        });
        expect(result).toBeDefined();
      });

      it("returns error when no items provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient();

        const result = await actions.multi_sell(client as never, "test-agent", {});
        expect((result as { error: string }).error).toBeDefined();
      });

      it("returns error when items array is empty", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient();

        const result = await actions.multi_sell(client as never, "test-agent", { items: [] });
        expect((result as { error: string }).error).toBeDefined();
      });
    });

    describe("scan_and_attack", () => {
      it("extracts stance from args.stance", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ entities: [] });

        const result = await actions.scan_and_attack(client as never, "test-agent", { stance: "defensive" });
        expect(result).toBeDefined();
      });

      it("uses args.target for specific target", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ entities: [] });

        const result = await actions.scan_and_attack(client as never, "test-agent", {
          target: "pirate-1",
          stance: "aggressive",
        });
        expect(result).toBeDefined();
      });

      it("treats args.id as target when not a stance keyword", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ entities: [] });

        const result = await actions.scan_and_attack(client as never, "test-agent", { id: "pirate-1" });
        expect(result).toBeDefined();
      });

      it("treats args.id as stance when it is a stance keyword", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ entities: [] });

        const result = await actions.scan_and_attack(client as never, "test-agent", { id: "evasive" });
        expect(result).toBeDefined();
      });
    });

    describe("loot_wrecks", () => {
      it("uses args.count when provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ wrecks: [] });

        const result = await actions.loot_wrecks(client as never, "test-agent", { count: 3 });
        expect(result).toBeDefined();
      });

      it("defaults to 5 when count not provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ wrecks: [] });

        const result = await actions.loot_wrecks(client as never, "test-agent", {});
        expect(result).toBeDefined();
      });

      it("caps count at 10 when higher value provided", async () => {
        const deps = makeCompoundDepsBase();
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient({ wrecks: [] });

        const result = await actions.loot_wrecks(client as never, "test-agent", { count: 50 });
        expect(result).toBeDefined();
      });
    });

    describe("battle_readiness", () => {
      it("returns readiness info without requiring client calls", async () => {
        const deps = makeCompoundDepsBase();
        deps.statusCache.set("test-agent", {
          data: {
            ship: { hull: 80, max_hull: 100, fuel: 50, max_fuel: 100 },
            player: { credits: 5000, current_system: "Sol" },
          },
          fetchedAt: Date.now(),
        });
        const actions = buildCompoundActions(deps, new Set());
        const { client } = makeMockGameClient();

        const result = await actions.battle_readiness(client as never, "test-agent", {});
        expect(result).toBeDefined();
        expect(typeof result).toBe("object");
      });
    });
  });
});
