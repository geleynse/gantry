/**
 * Tests for passthrough-handler.ts
 *
 * Covers the shared game tool execution logic: nav logging, auto-undock,
 * tick waits, error hints, summarization, market enrichment, and logging.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { handlePassthrough, waitForActionResult, waitForCraftActionResult, textResult, type PassthroughDeps, type McpTextResult } from "./passthrough-handler.js";
import { EventBuffer } from "./event-buffer.js";
import { STATE_CHANGING_TOOLS } from "./proxy-constants.js";
import { GalaxyGraph } from "./pathfinder.js";
import { createDatabase, closeDb } from "../services/database.js";
import { registerPoi, markDockable, isDockable } from "../services/galaxy-poi-registry.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockClient(responses: Record<string, { result?: unknown; error?: Record<string, unknown> | null }> = {}) {
  return {
    execute: mock(async (cmd: string, _args?: Record<string, unknown>) => {
      return responses[cmd] ?? { result: { command: cmd } };
    }),
    waitForTick: mock(async () => {}),
    lastArrivalTick: null as number | null,
  };
}

function createMockDeps(overrides?: Partial<PassthroughDeps>): PassthroughDeps {
  return {
    statusCache: new Map(),
    marketCache: {
      get: () => ({ data: null, stale: true, age_seconds: 0 }),
    } as PassthroughDeps["marketCache"],
    gameHealthRef: { current: { tick: 100, version: "0.144.0", fetchedAt: Date.now(), estimatedNextTick: null } },
    stateChangingTools: STATE_CHANGING_TOOLS,
    waitForNavCacheUpdate: mock(async () => true),
    waitForDockCacheUpdate: mock(async () => true),
    decontaminateLog: (r: unknown) => r,
    stripPendingFields: mock((_r: unknown) => {}),
    withInjections: async (_agent: string, r: McpTextResult) => r,
    ...overrides,
  };
}

function parseResult(result: McpTextResult): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handlePassthrough", () => {
  it("read-only tool: calls execute, returns summarized result, no tick wait", async () => {
    const client = createMockClient({ scan: { result: { ships: [] } } });
    const deps = createMockDeps();

    const result = await handlePassthrough(deps, client, "test-agent", "scan", "scan");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(client.execute).toHaveBeenCalledWith("scan", undefined);
    expect(client.waitForTick).not.toHaveBeenCalled();
    // scan is not state-changing, so no status wrapper
    expect(parsed).not.toHaveProperty("status");
  });

  it("state-changing non-nav tool: calls execute + waitForTick, wraps result with status:completed", async () => {
    const client = createMockClient({ mine: { result: { ore: "iron", quantity: 5 } } });
    const deps = createMockDeps();

    const result = await handlePassthrough(deps, client, "test-agent", "mine", "mine");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(client.execute).toHaveBeenCalledWith("mine", undefined);
    expect(client.waitForTick).toHaveBeenCalledTimes(1);
    expect(parsed.status).toBe("completed");
    expect(parsed).toHaveProperty("result");
  });

  it("pending non-nav tool with eventBuffer: uses waitForActionResult instead of waitForTick", async () => {
    // mine returns pending:true — should poll the event buffer, not waitForTick
    const client = createMockClient({ mine: { result: { ore: "iron", quantity: 5, pending: true } } });
    const buf = new EventBuffer();
    // Deliver the action_result event shortly after execute
    setTimeout(() => {
      buf.push({
        type: "action_result",
        payload: { command: "mine", tick: 5, result: { ore: "iron", quantity: 5 } },
        receivedAt: Date.now(),
      });
    }, 30);

    const eventBuffers = new Map<string, EventBuffer>([["pending-agent", buf]]);
    const deps = createMockDeps({ eventBuffers, actionResultTimeoutMs: 2000 });

    const result = await handlePassthrough(deps, client, "pending-agent", "mine", "mine");
    const parsed = parseResult(result) as Record<string, unknown>;

    // waitForTick should NOT have been called — we used the event buffer path
    expect(client.waitForTick).not.toHaveBeenCalled();
    // Result should be wrapped with status:completed (state-changing tool)
    expect(parsed.status).toBe("completed");
  });

  it("pending non-nav tool without eventBuffer: falls back to waitForTick", async () => {
    // mine returns pending:true but no eventBuffer wired — should fall back to waitForTick
    const client = createMockClient({ mine: { result: { ore: "iron", quantity: 5, pending: true } } });
    const deps = createMockDeps(); // no eventBuffers

    const result = await handlePassthrough(deps, client, "test-agent", "mine", "mine");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(client.waitForTick).toHaveBeenCalledTimes(1);
    expect(parsed.status).toBe("completed");
  });

  it("jump: auto-undocks if docked, calls execute, calls waitForNavCacheUpdate", async () => {
    const client = createMockClient({ jump: { result: { system: "alpha" } }, undock: { result: { ok: true } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("jump-agent", {
      data: {
        player: { current_system: "sol", current_poi: "sol_station", docked_at_base: "sol_station" },
        tick: 100,
      },
      fetchedAt: Date.now(),
    });

    const waitForNavCacheUpdate = mock(async () => true);
    const deps = createMockDeps({ statusCache, waitForNavCacheUpdate });

    await handlePassthrough(deps, client, "jump-agent", "jump", "jump", { target_system: "alpha" }, "alpha");

    // Should have called undock, then waitForTick (for undock), then jump
    expect(client.execute.mock.calls[0][0]).toBe("undock");
    expect(client.waitForTick).toHaveBeenCalledTimes(1); // once for undock wait
    expect(client.execute.mock.calls[1][0]).toBe("jump");
    expect(waitForNavCacheUpdate).toHaveBeenCalledTimes(1);
  });

  it("jump (not docked): skips undock, goes straight to execute", async () => {
    const client = createMockClient({ jump: { result: { system: "beta" } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("jump-agent2", {
      data: {
        player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
        tick: 100,
      },
      fetchedAt: Date.now(),
    });

    const deps = createMockDeps({ statusCache });

    await handlePassthrough(deps, client, "jump-agent2", "jump", "jump", { target_system: "beta" }, "beta");

    // First call should be jump directly (no undock)
    expect(client.execute.mock.calls[0][0]).toBe("jump");
    expect(client.execute).toHaveBeenCalledTimes(1);
  });

  it("jump cache lag: does NOT patch statusCache when waitForNavCacheUpdate returns false", async () => {
    const client = createMockClient({ jump: { result: { system: "gamma" } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("lag-agent", {
      data: {
        player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
        tick: 100,
        ship: { fuel: 50 },
      },
      fetchedAt: Date.now(),
    });

    const waitForNavCacheUpdate = mock(async () => false); // cache did NOT update
    const deps = createMockDeps({ statusCache, waitForNavCacheUpdate });

    await handlePassthrough(deps, client, "lag-agent", "jump", "jump", { target_system: "gamma" }, "gamma");

    // passthrough-handler itself doesn't patch; compound-tools handles cache patch for jump_route
    // For a plain jump in passthrough, cache lag is logged but not patched (agent should call get_location)
    const cached = statusCache.get("lag-agent");
    expect((cached?.data?.player as Record<string, unknown>)?.current_system).toBe("sol");
  });

  it("jump: response with command field is accepted without error (no unexpected_nav_field rejection)", async () => {
    // Regression: game responses now include command field e.g. {command:"jump", message:"...", pending:true}
    // The proxy should NOT reject or error on this — command is a known/expected field now.
    const client = createMockClient({
      jump: { result: { command: "jump", message: "jump completed", pending: false, system: "beta" } },
    });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: { current_system: "alpha", current_poi: "alpha_station", docked_at_base: null }, tick: 99 },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    const result = await handlePassthrough(deps, client, "test-agent", "jump", "jump", { target_system: "beta" }, "beta");
    const parsed = parseResult(result) as Record<string, unknown>;

    // Should have executed successfully (no error injected due to unexpected field)
    expect(client.execute).toHaveBeenCalledWith("jump", { target_system: "beta" });
    expect(parsed.error).toBeUndefined();
  });

  it("travel: response with command field is accepted without error", async () => {
    const client = createMockClient({
      travel: { result: { command: "travel", message: "travel completed", pending: false, poi: "beta_station" } },
    });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: { current_system: "beta", current_poi: "beta_belt" }, tick: 99 },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    const result = await handlePassthrough(deps, client, "test-agent", "travel", "travel", { target_poi: "beta_station" }, undefined);
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(client.execute).toHaveBeenCalledWith("travel", { target_poi: "beta_station" });
    expect(parsed.error).toBeUndefined();
  });

  it("travel: single tick wait (not waitForNavCacheUpdate)", async () => {
    const client = createMockClient({ travel: { result: { poi: "sol_belt" } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("travel-agent", {
      data: { player: { current_system: "sol" }, tick: 100 },
      fetchedAt: Date.now(),
    });

    const waitForNavCacheUpdate = mock(async () => true);
    const deps = createMockDeps({ statusCache, waitForNavCacheUpdate });

    await handlePassthrough(deps, client, "travel-agent", "travel", "travel", { target_poi: "sol_belt" }, "sol_belt");

    expect(client.waitForTick).toHaveBeenCalledTimes(1);
    // travel should NOT use waitForNavCacheUpdate — just single tick wait
    expect(waitForNavCacheUpdate).not.toHaveBeenCalled();
  });

  it("error response: adds error hint, returns {error}, logs with success:false", async () => {
    const client = createMockClient({
      mine: { error: { code: "not_docked", message: "You are not docked" } },
    });
    const deps = createMockDeps();

    const result = await handlePassthrough(deps, client, "err-agent", "mine", "mine");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed).toHaveProperty("error");
    expect(String(parsed.error)).toContain("not_docked");
    // The error hint for "not docked" should be appended
    expect(String(parsed.error)).toContain("dock");
  });

  it("captains_log_list: calls decontaminateLog with result", async () => {
    const client = createMockClient({
      captains_log_list: { result: { entries: ["entry 1", "entry 2"] } },
    });
    const decontaminateLog = mock((r: unknown) => r);
    const deps = createMockDeps({ decontaminateLog });

    await handlePassthrough(deps, client, "test-agent", "captains_log_list", "captains_log_list");

    expect(decontaminateLog).toHaveBeenCalledTimes(1);
  });

  it("analyze_market: enriches with global market context when cargo + fresh market data available", async () => {
    const client = createMockClient({
      analyze_market: { result: { insights: "market is good" } },
    });

    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("market-agent", {
      data: {
        player: { current_poi: "sol_station" },
        ship: { cargo: [{ item_id: "iron_ore", quantity: 100 }] },
        tick: 100,
      },
      fetchedAt: Date.now(),
    });

    // Fresh market data with a better price elsewhere
    const mockMarketData = {
      items: [
        { item_id: "iron_ore", empire: "sol", station_id: "alpha_station", best_bid: 50, best_ask: 60 },
      ],
    };
    const marketCache = {
      get: () => ({ data: mockMarketData, stale: false, age_seconds: 0 }),
    } as unknown as PassthroughDeps["marketCache"];

    const deps = createMockDeps({ statusCache, marketCache });

    const result = await handlePassthrough(deps, client, "market-agent", "analyze_market", "analyze_market");
    const parsed = parseResult(result) as Record<string, unknown>;

    // Should have global_market_context enrichment
    expect(parsed).toHaveProperty("global_market_context");
  });

  it("buy: adds storage hint to result", async () => {
    const client = createMockClient({
      buy: { result: { item_id: "weapon_laser", quantity: 1 } },
    });
    const deps = createMockDeps();

    const result = await handlePassthrough(deps, client, "test-agent", "buy", "buy", { item_id: "weapon_laser", quantity: 1 });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe("completed");
    const inner = parsed.result as Record<string, unknown>;
    expect(String(inner.hint)).toContain("STATION STORAGE");
    expect(String(inner.hint)).toContain("withdraw_items");
    expect(String(inner.hint)).toContain("install_mod(item_id)");
  });

  it("buy: adds _stale_market_warning when no recent market analysis", async () => {
    const client = createMockClient({
      buy: { result: { item_id: "shield_booster", quantity: 1 } },
    });
    // statusCache has no _last_market_analysis_at → stale market
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", { data: { player: {}, ship: {} }, fetchedAt: Date.now() });
    const deps = createMockDeps({ statusCache });

    const result = await handlePassthrough(deps, client, "test-agent", "buy", "buy", { item_id: "shield_booster", quantity: 1 });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe("completed");
    const inner = parsed.result as Record<string, unknown>;
    expect(inner._stale_market_warning).toBeTruthy();
    expect(String(inner._stale_market_warning)).toContain("stale");
  });

  it("buy: no _stale_market_warning when recent market analysis exists", async () => {
    const client = createMockClient({
      buy: { result: { item_id: "shield_booster", quantity: 1 } },
    });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    // Fresh market data (1 minute old)
    statusCache.set("test-agent", {
      data: { player: {}, ship: {}, _last_market_analysis_at: Date.now() - 60_000 },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    const result = await handlePassthrough(deps, client, "test-agent", "buy", "buy", { item_id: "shield_booster", quantity: 1 });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe("completed");
    const inner = parsed.result as Record<string, unknown>;
    expect(inner._stale_market_warning).toBeUndefined();
  });

  it("craft: adds hint when outputs are empty and no eventBuffers", async () => {
    const client = createMockClient({
      craft: { result: { command: "craft", message: "craft completed" } },
    });
    const deps = createMockDeps();

    const result = await handlePassthrough(deps, client, "test-agent", "craft", "craft", { recipe_id: "steel_plate", count: 5 });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe("completed");
    const inner = parsed.result as Record<string, unknown>;
    expect(String(inner.hint)).toContain("asynchronously");
    expect(String(inner.hint)).toContain("get_status");
  });

  it("craft: no hint when outputs are present in direct response", async () => {
    const client = createMockClient({
      craft: { result: { command: "craft", recipe_id: "steel_plate", outputs: [{ item_id: "steel_plate", name: "Steel Plate", quantity: 5 }] } },
    });
    const deps = createMockDeps();

    const result = await handlePassthrough(deps, client, "test-agent", "craft", "craft", { recipe_id: "steel_plate", count: 5 });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe("completed");
    const inner = parsed.result as Record<string, unknown>;
    expect(inner.hint).toBeUndefined();
  });

  it("craft: blocks and returns outputs from action_result event", async () => {
    const client = createMockClient({
      craft: { result: { command: "craft", message: "craft completed" } },
    });
    const eventBuffer = new EventBuffer();
    const eventBuffers = new Map([["craft-agent", eventBuffer]]);
    const deps = createMockDeps({ eventBuffers });

    // Push action_result into the buffer shortly after the craft executes
    const craftOutputs = [{ item_id: "iron_sword", name: "Iron Sword", quantity: 1 }];
    setTimeout(() => {
      eventBuffer.push({
        type: "action_result",
        payload: { command: "craft", tick: 12345, result: { action: "craft_complete", outputs: craftOutputs } },
        receivedAt: Date.now(),
      });
    }, 100);

    const result = await handlePassthrough(deps, client, "craft-agent", "craft", "craft", { recipe_id: "iron_sword", count: 1 });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe("completed");
    const inner = parsed.result as Record<string, unknown>;
    expect(inner.outputs).toEqual(craftOutputs);
    expect(inner.outputs_confirmed).toBe(true);
    expect(String(inner.hint)).toContain("STATION STORAGE");
  });

  it("craft: falls back to hint when action_result times out", async () => {
    const client = createMockClient({
      craft: { result: { command: "craft", message: "craft completed" } },
    });
    const eventBuffer = new EventBuffer();
    const eventBuffers = new Map([["craft-agent", eventBuffer]]);
    // Use a short timeout so the test doesn't block 45s
    const deps = createMockDeps({ eventBuffers, craftResultTimeoutMs: 200 });

    // No action_result event pushed — should timeout and fall back to hint
    const result = await handlePassthrough(deps, client, "craft-agent", "craft", "craft", { recipe_id: "iron_sword", count: 1 });
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.status).toBe("completed");
    const inner = parsed.result as Record<string, unknown>;
    expect(String(inner.hint)).toContain("asynchronously");
    expect(String(inner.hint)).toContain("get_status");
    expect(inner.outputs_confirmed).toBeUndefined();
  });

  it("get_system: calls cacheSystemPois (no error on valid poi data)", async () => {
    const client = createMockClient({
      get_system: {
        result: {
          system_id: "sol",
          name: "Sol",
          pois: [{ id: "sol_belt", name: "Sol Belt" }],
        },
      },
    });
    const deps = createMockDeps();

    // cacheSystemPois is a side-effectful module import, so we just verify no crash
    const result = await handlePassthrough(deps, client, "test-agent", "get_system", "get_system");
    const parsed = parseResult(result) as Record<string, unknown>;

    // get_system is not state-changing, no status wrapper
    expect(parsed).not.toHaveProperty("status");
  });

  it("pending fields: strips pending from state-changing non-nav results after tick wait", async () => {
    const client = createMockClient({
      sell: { result: { pending: true, order_id: "abc123" } },
    });
    const stripPendingFields = mock((_r: unknown) => {});
    const deps = createMockDeps({ stripPendingFields });

    await handlePassthrough(deps, client, "test-agent", "sell", "sell", { item_id: "iron_ore", quantity: 10 });

    expect(stripPendingFields).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Dock command (dock hangs pending indefinitely)
  // -------------------------------------------------------------------------

  describe("dock", () => {
    it("calls waitForDockCacheUpdate after execute + generic tick wait, returns completed", async () => {
      const client = createMockClient({ dock: { result: { status: "ok" } } });
      const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
      statusCache.set("dock-agent", {
        data: { player: { current_poi: "sol_station", docked_at_base: "sol_station" }, tick: 100 },
        fetchedAt: Date.now(),
      });
      const waitForDockCacheUpdate = mock(async () => true);
      const deps = createMockDeps({ statusCache, waitForDockCacheUpdate });

      const result = await handlePassthrough(deps, client, "dock-agent", "dock", "dock");
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(client.execute).toHaveBeenCalledWith("dock", undefined);
      expect(client.waitForTick).toHaveBeenCalledTimes(1); // generic tick wait
      expect(waitForDockCacheUpdate).toHaveBeenCalledTimes(1);
      expect(waitForDockCacheUpdate).toHaveBeenCalledWith(client, "dock-agent");
      expect(parsed.status).toBe("completed");
    });

    it("returns dock_verification_failed when cache not updated after retry", async () => {
      const client = createMockClient({ dock: { result: { status: "ok" } } });
      const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
      statusCache.set("dock-agent2", {
        data: { player: { current_poi: "sol_belt", docked_at_base: null }, tick: 100 },
        fetchedAt: Date.now(),
      });
      // Both initial check and retry check return false (never docked)
      const waitForDockCacheUpdate = mock(async () => false);
      const deps = createMockDeps({ statusCache, waitForDockCacheUpdate });

      const result = await handlePassthrough(deps, client, "dock-agent2", "dock", "dock");
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(parsed.status).toBe("error");
      expect(parsed.error).toBe("dock_verification_failed");
      // Initial execute + 1 retry
      expect(client.execute).toHaveBeenCalledTimes(2);
      // Initial waitForDockCacheUpdate + retry waitForDockCacheUpdate
      expect(waitForDockCacheUpdate).toHaveBeenCalledTimes(2);
    });

    it("dock hint includes system name and stop-retry language for non-dockable POIs", async () => {
      const client = createMockClient({ dock: { result: { status: "ok" } } });
      const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
      statusCache.set("dock-agent3", {
        data: { player: { current_poi: "sol_belt", current_system: "sol", docked_at_base: null }, tick: 100 },
        fetchedAt: Date.now(),
      });
      const waitForDockCacheUpdate = mock(async () => false);
      const deps = createMockDeps({ statusCache, waitForDockCacheUpdate });

      const result = await handlePassthrough(deps, client, "dock-agent3", "dock", "dock");
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(parsed.message).toContain("sol_belt");
      expect(parsed.message).toContain("CANNOT dock here");
      expect(parsed.message).toContain('get_system for "sol"');
      expect(parsed.message).toContain("travel_to");
    });

    it("dock hint includes stop-retry language for POIs without dockable base", async () => {
      const client = createMockClient({ dock: { result: { status: "ok" } } });
      const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
      statusCache.set("dock-agent4", {
        data: { player: { current_poi: "unknown_outpost", current_system: "alpha_centauri", docked_at_base: null }, tick: 100 },
        fetchedAt: Date.now(),
      });
      const waitForDockCacheUpdate = mock(async () => false);
      const deps = createMockDeps({ statusCache, waitForDockCacheUpdate });

      const result = await handlePassthrough(deps, client, "dock-agent4", "dock", "dock");
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(parsed.message).toContain("unknown_outpost");
      expect(parsed.message).toContain("Do NOT retry");
      expect(parsed.message).toContain('get_system for "alpha_centauri"');
    });

    it("dock hint uses generic system clause when system is unknown", async () => {
      const client = createMockClient({ dock: { result: { status: "ok" } } });
      const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
      statusCache.set("dock-agent5", {
        data: { player: { current_poi: "nebula_x", docked_at_base: null }, tick: 100 },
        fetchedAt: Date.now(),
      });
      const waitForDockCacheUpdate = mock(async () => false);
      const deps = createMockDeps({ statusCache, waitForDockCacheUpdate });

      const result = await handlePassthrough(deps, client, "dock-agent5", "dock", "dock");
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(parsed.message).toContain("nebula_x");
      expect(parsed.message).toContain("Use get_system to find stations with bases");
    });

    it("handler exception returns error response (exception safety)", async () => {
      const client = createMockClient({ dock: { result: { status: "ok" } } });
      // waitForDockCacheUpdate throws — simulates a future coding mistake
      const waitForDockCacheUpdate = mock(async () => { throw new Error("simulated handler failure"); });
      const deps = createMockDeps({ waitForDockCacheUpdate });

      // Should NOT throw — try-catch in handlePassthrough converts to error response
      const result = await handlePassthrough(deps, client, "test-agent", "dock", "dock");
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(parsed.error).toBeDefined();
    });
  });

  it("v2 action name: logToolCall uses action parameter, not v1ToolName", async () => {
    // When v2 dispatches to a v1 tool, the action name (v2 key) should be logged
    // We verify this indirectly via withInjections being called with the right result
    const client = createMockClient({ mine: { result: { ore: "iron" } } });
    const withInjectionsCallAgent: string[] = [];
    const deps = createMockDeps({
      withInjections: async (agent, r) => {
        withInjectionsCallAgent.push(agent);
        return r;
      },
    });

    // action="spacemolt_action:mine" (v2 style), v1ToolName="mine"
    await handlePassthrough(deps, client, "v2-agent", "spacemolt_action:mine", "mine");

    expect(withInjectionsCallAgent).toContain("v2-agent");
    // execute should be called with the v1 tool name "mine"
    expect(client.execute).toHaveBeenCalledWith("mine", undefined);
  });
});

describe("jump neighbor validation", () => {
  it("blocks jump to non-neighbor system with helpful error", async () => {
    const graph = new GalaxyGraph();
    graph.addSystem("sol", "Sol");
    graph.addSystem("sirius", "Sirius");
    graph.addSystem("wolf_359", "Wolf 359");
    graph.addEdge("sol", "sirius");
    // wolf_359 is NOT connected to sol

    const statusCache = new Map();
    statusCache.set("test-agent", {
      data: { player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null }, tick: 100 },
      fetchedAt: Date.now(),
    });

    const client = createMockClient({ jump: { result: { system: "wolf_359" } } });
    const deps = createMockDeps({ statusCache, galaxyGraph: graph });

    const result = await handlePassthrough(deps, client, "test-agent", "jump", "jump", { target_system: "wolf_359" }, "wolf_359");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(parsed.error).toBeDefined();
    expect(String(parsed.error)).toContain("not connected");
    // Should NOT have called execute (jump was blocked)
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("allows jump to valid neighbor system", async () => {
    const graph = new GalaxyGraph();
    graph.addSystem("sol", "Sol");
    graph.addSystem("sirius", "Sirius");
    graph.addEdge("sol", "sirius");

    const statusCache = new Map();
    statusCache.set("test-agent", {
      data: { player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null }, tick: 100 },
      fetchedAt: Date.now(),
    });

    const client = createMockClient({ jump: { result: { system: "sirius" } } });
    const deps = createMockDeps({ statusCache, galaxyGraph: graph });

    const result = await handlePassthrough(deps, client, "test-agent", "jump", "jump", { target_system: "sirius" }, "sirius");
    const parsed = parseResult(result) as Record<string, unknown>;

    // Should have executed the jump (no error)
    expect(parsed.error).toBeUndefined();
    expect(client.execute).toHaveBeenCalledWith("jump", { target_system: "sirius" });
  });
});

describe("textResult", () => {
  it("wraps data in MCP text content format", () => {
    const result = textResult({ foo: "bar" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ foo: "bar" });
  });

  it("handles null and undefined", () => {
    expect(() => textResult(null)).not.toThrow();
    expect(() => textResult(undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractLocalBids
// ---------------------------------------------------------------------------

import { extractLocalBids } from "./passthrough-handler.js";

describe("extractLocalBids", () => {
  it("extracts estimated_value from recommendations as local bids", () => {
    const result = {
      recommendations: [
        { item_id: "iron_ore", action: "sell", estimated_value: 12, quantity_demanded: 100 },
        { item_id: "copper_ore", action: "sell", estimated_value: 8, quantity_demanded: 50 },
      ],
      station_id: "sol_station",
    };
    const bids = extractLocalBids(result);
    expect(bids.get("iron_ore")).toBe(12);
    expect(bids.get("copper_ore")).toBe(8);
  });

  it("skips items with zero or missing estimated_value", () => {
    const result = {
      recommendations: [
        { item_id: "iron_ore", action: "sell", estimated_value: 0 },
        { item_id: "copper_ore", action: "sell" },
      ],
    };
    const bids = extractLocalBids(result);
    expect(bids.size).toBe(0);
  });

  it("returns empty map for null/undefined/non-object input", () => {
    expect(extractLocalBids(null).size).toBe(0);
    expect(extractLocalBids(undefined).size).toBe(0);
    expect(extractLocalBids("string").size).toBe(0);
  });

  it("returns empty map when recommendations is missing", () => {
    expect(extractLocalBids({ station_id: "sol_station" }).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// waitForActionResult (generic)
// ---------------------------------------------------------------------------

describe("waitForActionResult", () => {
  it("returns outputs when action_result arrives before timeout", async () => {
    const buf = new EventBuffer();
    const outputs = [{ item_id: "iron_sword", name: "Iron Sword", quantity: 1 }];
    setTimeout(() => {
      buf.push({
        type: "action_result",
        payload: { command: "craft", tick: 1, result: { outputs } },
        receivedAt: Date.now(),
      });
    }, 50);

    const result = await waitForActionResult(buf, "craft", 2000, 20);
    expect(result).toEqual(outputs);
  });

  it("returns empty array when action_result has no outputs", async () => {
    const buf = new EventBuffer();
    setTimeout(() => {
      buf.push({
        type: "action_result",
        payload: { command: "craft", tick: 1, result: {} },
        receivedAt: Date.now(),
      });
    }, 50);

    const result = await waitForActionResult(buf, "craft", 2000, 20);
    expect(result).toEqual([]);
  });

  it("returns null on timeout", async () => {
    const buf = new EventBuffer();
    const result = await waitForActionResult(buf, "craft", 100, 20);
    expect(result).toBeNull();
  });

  it("ignores action_result events for other commands", async () => {
    const buf = new EventBuffer();
    // Push a travel action_result — should not match a "craft" wait
    buf.push({
      type: "action_result",
      payload: { command: "travel", tick: 1, result: { action: "arrived" } },
      receivedAt: Date.now(),
    });
    // Then push craft action_result after a short delay
    const craftOutputs = [{ item_id: "blade", name: "Blade", quantity: 2 }];
    setTimeout(() => {
      buf.push({
        type: "action_result",
        payload: { command: "craft", tick: 2, result: { outputs: craftOutputs } },
        receivedAt: Date.now(),
      });
    }, 50);

    const result = await waitForActionResult(buf, "craft", 2000, 20);
    expect(result).toEqual(craftOutputs);
    // Travel event should remain in buffer
    expect(buf.size).toBe(1);
  });

  it("removes the matching event from the buffer", async () => {
    const buf = new EventBuffer();
    const outputs = [{ item_id: "sword", name: "Sword", quantity: 1 }];
    buf.push({
      type: "action_result",
      payload: { command: "craft", tick: 1, result: { outputs } },
      receivedAt: Date.now(),
    });

    await waitForActionResult(buf, "craft", 2000, 20);
    expect(buf.size).toBe(0); // event was consumed
  });

  it("matches non-craft command names (e.g. mine)", async () => {
    const buf = new EventBuffer();
    const outputs = [{ item_id: "iron_ore", quantity: 5 }];
    setTimeout(() => {
      buf.push({
        type: "action_result",
        payload: { command: "mine", tick: 3, result: { outputs } },
        receivedAt: Date.now(),
      });
    }, 50);

    const result = await waitForActionResult(buf, "mine", 2000, 20);
    expect(result).toEqual(outputs);
  });

  it("does not match wrong command when multiple are in buffer", async () => {
    const buf = new EventBuffer();
    // Push a mine event immediately — we're waiting for refuel
    buf.push({
      type: "action_result",
      payload: { command: "mine", tick: 1, result: { outputs: [] } },
      receivedAt: Date.now(),
    });
    // refuel arrives after delay
    setTimeout(() => {
      buf.push({
        type: "action_result",
        payload: { command: "refuel", tick: 2, result: {} },
        receivedAt: Date.now(),
      });
    }, 50);

    const result = await waitForActionResult(buf, "refuel", 2000, 20);
    expect(result).toEqual([]); // refuel result has no outputs → empty array
    // mine event should still be in buffer
    expect(buf.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// waitForCraftActionResult (backwards-compat shim)
// ---------------------------------------------------------------------------

describe("waitForCraftActionResult", () => {
  it("delegates to waitForActionResult with command=craft", async () => {
    const buf = new EventBuffer();
    const outputs = [{ item_id: "iron_sword", name: "Iron Sword", quantity: 1 }];
    setTimeout(() => {
      buf.push({
        type: "action_result",
        payload: { command: "craft", tick: 1, result: { outputs } },
        receivedAt: Date.now(),
      });
    }, 50);

    const result = await waitForCraftActionResult(buf, 2000, 20);
    expect(result).toEqual(outputs);
  });

  it("returns null on timeout", async () => {
    const buf = new EventBuffer();
    const result = await waitForCraftActionResult(buf, 100, 20);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// captains_log_add → addDiaryEntry mirror
// ---------------------------------------------------------------------------

describe("captains_log_add diary mirror", () => {
  // Use real database + notes-db instead of mock.module("../services/notes-db.js").
  // mock.module() persists across files with maxConcurrency=1, poisoning notes-db.test.ts.
  const { createDatabase, closeDb, getDb } = require("../services/database.js");

  it("calls addDiaryEntry on success with correct agent and entry", async () => {
    createDatabase(":memory:");
    try {
      const validLog = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore from the belt.
NEXT: Jump to Kepler system.`;
      const client = createMockClient({ captains_log_add: { result: { status: "ok" } } });
      const deps = createMockDeps();

      await handlePassthrough(deps, client, "test_agent", "captains_log_add", "captains_log_add", { entry: validLog });

      const db = getDb();
      const rows = db.prepare("SELECT agent, entry FROM agent_diary WHERE agent = ?").all("test_agent") as Array<{ agent: string; entry: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ agent: "test_agent", entry: validLog });
    } finally {
      closeDb();
    }
  });

  it("does NOT call addDiaryEntry on format validation failure", async () => {
    createDatabase(":memory:");
    try {
      // Invalid format (only 2 lines instead of 4)
      const invalidLog = `LOC: Sol sol_belt_1 undocked
DID: Mined ore.`;
      const client = createMockClient({ captains_log_add: { result: { status: "ok" } } });
      const deps = createMockDeps();

      const result = await handlePassthrough(deps, client, "test_agent", "captains_log_add", "captains_log_add", { entry: invalidLog });
      const parsed = parseResult(result) as Record<string, unknown>;

      // Format validation should reject it before it gets to the server
      expect(parsed.error).toBeDefined();
      expect((parsed as { message?: string }).message).toContain("EXACTLY 4 lines");

      const db = getDb();
      const rows = db.prepare("SELECT * FROM agent_diary WHERE agent = ?").all("test_agent");
      expect(rows).toHaveLength(0);
    } finally {
      closeDb();
    }
  });

  it("does NOT call addDiaryEntry on server error", async () => {
    createDatabase(":memory:");
    try {
      const validLog = `LOC: Sol sol_belt_1 undocked
CR: 1500 | FUEL: 45/100 | CARGO: 80/120
DID: Mined ore.
NEXT: Jump next.`;
      const client = createMockClient({ captains_log_add: { error: { code: "server_error", message: "fail" } } });
      const deps = createMockDeps();

      const result = await handlePassthrough(deps, client, "test_agent", "captains_log_add", "captains_log_add", { entry: validLog });
      const parsed = parseResult(result) as Record<string, unknown>;

      expect(parsed.error).toBeDefined();

      const db = getDb();
      const rows = db.prepare("SELECT * FROM agent_diary WHERE agent = ?").all("test_agent");
      expect(rows).toHaveLength(0);
    } finally {
      closeDb();
    }
  });

  // ---------------------------------------------------------------------------
  // get_skills cache merge
  // ---------------------------------------------------------------------------

  it("get_skills: merges skills into statusCache player object", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: { current_system: "sol", credits: 1000 }, ship: {}, tick: 42 },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });
    const skills = {
      mining: { name: "Mining", level: 3, xp: 450, xp_to_next: 1000 },
      combat: { name: "Combat", level: 1, xp: 50, xp_to_next: 500 },
    };
    const client = createMockClient({ get_skills: { result: { skills } } });

    await handlePassthrough(deps, client, "test-agent", "get_skills", "get_skills");

    const cached = statusCache.get("test-agent");
    const player = cached?.data?.player as Record<string, unknown>;
    expect(player?.skills).toEqual(skills);
    // Existing player fields preserved
    expect(player?.current_system).toBe("sol");
    expect(player?.credits).toBe(1000);
  });

  it("get_skills: no-op when result has no skills key", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: { credits: 500 }, ship: {} },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });
    const client = createMockClient({ get_skills: { result: { status: "ok" } } });

    await handlePassthrough(deps, client, "test-agent", "get_skills", "get_skills");

    const cached = statusCache.get("test-agent");
    const player = cached?.data?.player as Record<string, unknown>;
    // skills should not have been set
    expect(player?.skills).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // get_ship module/weapon cache merge (#128)
  // ---------------------------------------------------------------------------

  it("get_ship: merges modules and weapons into statusCache ship object", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: { current_system: "sol" }, ship: { hull: 100, fuel: 80 }, tick: 42 },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });
    const modules = [
      { id: "mod1", slot_type: "weapon", name: "Autocannon Mk1" },
      { id: "mod2", slot_type: "engine", name: "Thruster Mk1" },
      { id: "mod3", slot_type: "weapon", name: "Laser Mk1" },
    ];
    const client = createMockClient({ get_ship: { result: { ship_id: "levy", modules } } });

    await handlePassthrough(deps, client, "test-agent", "get_ship", "get_ship");

    const cached = statusCache.get("test-agent");
    const ship = cached?.data?.ship as Record<string, unknown>;
    // Weapons extracted from modules with slot_type "weapon"
    expect(Array.isArray(ship?.weapons)).toBe(true);
    const weapons = ship?.weapons as Array<Record<string, unknown>>;
    expect(weapons).toHaveLength(2);
    expect(weapons[0].name).toBe("Autocannon Mk1");
    expect(weapons[1].name).toBe("Laser Mk1");
    // Modules also merged
    expect(Array.isArray(ship?.modules)).toBe(true);
    expect((ship?.modules as unknown[]).length).toBe(3);
    // Existing ship fields preserved
    expect(ship?.hull).toBe(100);
    expect(ship?.fuel).toBe(80);
  });

  it("get_ship: no-op when result has no modules", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: {}, ship: { hull: 50 } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });
    const client = createMockClient({ get_ship: { result: { ship_id: "levy" } } });

    await handlePassthrough(deps, client, "test-agent", "get_ship", "get_ship");

    const cached = statusCache.get("test-agent");
    const ship = cached?.data?.ship as Record<string, unknown>;
    // weapons should not have been set
    expect(ship?.weapons).toBeUndefined();
    expect(ship?.hull).toBe(50);
  });

  it("get_ship: graceful when agent has no existing cache entry", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    const deps = createMockDeps({ statusCache });
    const modules = [{ id: "mod1", slot_type: "weapon", name: "Autocannon" }];
    const client = createMockClient({ get_ship: { result: { ship_id: "levy", modules } } });

    await expect(
      handlePassthrough(deps, client, "test-agent", "get_ship", "get_ship")
    ).resolves.toBeDefined();
    // Cache should remain empty since there was nothing to merge into
    expect(statusCache.has("test-agent")).toBe(false);
  });

  it("get_skills: graceful when agent has no existing cache entry", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    const deps = createMockDeps({ statusCache });
    const skills = { mining: { name: "Mining", level: 1, xp: 0, xp_to_next: 100 } };
    const client = createMockClient({ get_skills: { result: { skills } } });

    // Should not throw even with no existing cache entry
    await expect(
      handlePassthrough(deps, client, "test-agent", "get_skills", "get_skills")
    ).resolves.toBeDefined();
    // Cache should remain empty since there was nothing to merge into
    expect(statusCache.has("test-agent")).toBe(false);
  });

  // --- Bug #591: dock with empty/non-object result ---

  it("dock: handles empty string result — still runs tick-wait and dock verification (#591)", async () => {
    const client = createMockClient({ dock: { result: "" as any } });
    const waitForDockCacheUpdate = mock(async () => true);
    const deps = createMockDeps({ waitForDockCacheUpdate });

    const result = await handlePassthrough(deps, client, "test-agent", "dock", "dock");
    const parsed = parseResult(result) as Record<string, unknown>;

    // Must call waitForTick (state-changing tool) even with empty result
    expect(client.waitForTick).toHaveBeenCalled();
    // Must run dock verification
    expect(waitForDockCacheUpdate).toHaveBeenCalled();
    // Response should still wrap as completed
    expect(parsed.status).toBe("completed");
  });

  it("dock: handles null result — still runs tick-wait and dock verification (#591)", async () => {
    const client = createMockClient({ dock: { result: null as any } });
    const waitForDockCacheUpdate = mock(async () => true);
    const deps = createMockDeps({ waitForDockCacheUpdate });

    const result = await handlePassthrough(deps, client, "test-agent", "dock", "dock");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(client.waitForTick).toHaveBeenCalled();
    expect(waitForDockCacheUpdate).toHaveBeenCalled();
    expect(parsed.status).toBe("completed");
  });

  it("dock: normal object result continues to work correctly", async () => {
    const client = createMockClient({ dock: { result: { status: "completed", command: "dock", pending: true } } });
    const waitForDockCacheUpdate = mock(async () => true);
    const deps = createMockDeps({ waitForDockCacheUpdate });

    const result = await handlePassthrough(deps, client, "test-agent", "dock", "dock");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(client.waitForTick).toHaveBeenCalled();
    expect(waitForDockCacheUpdate).toHaveBeenCalled();
    expect(parsed.status).toBe("completed");
    // Result should contain the dock response data
    const inner = parsed.result as Record<string, unknown>;
    expect(inner.command).toBe("dock");
  });

  it("state-changing tool with undefined result — does not crash (#591)", async () => {
    const client = createMockClient({ mine: { result: undefined as any } });
    const deps = createMockDeps();

    // Should not throw — was crashing on JSON.stringify(undefined).slice()
    const result = await handlePassthrough(deps, client, "test-agent", "mine", "mine");
    const parsed = parseResult(result) as Record<string, unknown>;

    expect(client.waitForTick).toHaveBeenCalled();
    expect(parsed.status).toBe("completed");
  });

  it("state-changing tool with empty string result — still waits for tick (#591)", async () => {
    const client = createMockClient({ refuel: { result: "" as any } });
    const deps = createMockDeps();

    const result = await handlePassthrough(deps, client, "test-agent", "refuel", "refuel");
    const parsed = parseResult(result) as Record<string, unknown>;

    // Tick wait must fire even with non-object result
    expect(client.waitForTick).toHaveBeenCalled();
    expect(parsed.status).toBe("completed");
  });

  it("dock verification retry works with non-object initial result (#591)", async () => {
    const client = createMockClient({ dock: { result: "" as any } });
    // First check returns false (not docked), second updates cache and returns true
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: { current_system: "sol", current_poi: "sol_station", docked_at_base: null } },
      fetchedAt: Date.now(),
    });
    let dockCheckCount = 0;
    const waitForDockCacheUpdate = mock(async () => {
      dockCheckCount++;
      if (dockCheckCount > 1) {
        // Simulate cache update after retry dock — player is now docked
        statusCache.set("test-agent", {
          data: { player: { current_system: "sol", current_poi: "sol_station", docked_at_base: "sol_station" } },
          fetchedAt: Date.now(),
        });
        return true;
      }
      return false;
    });
    const deps = createMockDeps({ waitForDockCacheUpdate, statusCache });

    const result = await handlePassthrough(deps, client, "test-agent", "dock", "dock");
    const parsed = parseResult(result) as Record<string, unknown>;

    // Should have done initial dock check (returned false) + retry dock + second check
    expect(waitForDockCacheUpdate).toHaveBeenCalledTimes(2);
    // Retry dock call
    expect(client.execute).toHaveBeenCalledTimes(2); // original dock + retry
    expect(parsed.status).toBe("completed");
  });
});

describe("POI validation", () => {
  const mockPoiValidator = {
    isValidSystem: (name: string) => name === "sol",
    isValidPoi: (system: string, poi: string) => system === "sol" && poi === "sol_station",
    getSuggestions: (name: string) => name.includes("anvil") ? ["the_anvil"] : ["sol_station"],
  };

  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  statusCache.set("poi-agent", {
    data: {
      player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
      tick: 100,
    },
    fetchedAt: Date.now(),
  });

  it("dock with invalid station gets _poi_warning", async () => {
    const client = createMockClient({ dock: { result: { status: "ok" } } });
    const deps = createMockDeps({ statusCache, poiValidator: mockPoiValidator });

    const result = await handlePassthrough(deps, client, "poi-agent", "dock", "dock", { station: "the_anvil_forge" });
    const parsed = parseResult(result);
    const inner = (parsed as any).result;

    expect(inner._poi_warning).toBeDefined();
    expect(inner._poi_warning).toContain("the_anvil_forge");
    expect(inner._poi_warning).toContain("the_anvil");
  });

  it("dock with valid station does not get _poi_warning", async () => {
    const client = createMockClient({ dock: { result: { status: "ok" } } });
    const deps = createMockDeps({ statusCache, poiValidator: mockPoiValidator });

    const result = await handlePassthrough(deps, client, "poi-agent", "dock", "dock", { station: "sol_station" });
    const parsed = parseResult(result);
    const inner = (parsed as any).result;

    expect(inner._poi_warning).toBeUndefined();
  });

  it("travel_to with invalid station gets _poi_warning", async () => {
    const client = createMockClient({ travel_to: { result: { status: "ok" } } });
    const deps = createMockDeps({ statusCache, poiValidator: mockPoiValidator });

    const result = await handlePassthrough(deps, client, "poi-agent", "travel_to", "travel_to", { destination: "invalid_station" });
    const parsed = parseResult(result);
    const inner = (parsed as any).result;

    expect(inner._poi_warning).toBeDefined();
    expect(inner._poi_warning).toContain("invalid_station");
  });

  it("travel_to with valid station does not get _poi_warning", async () => {
    const client = createMockClient({ travel_to: { result: { status: "ok" } } });
    const deps = createMockDeps({ statusCache, poiValidator: mockPoiValidator });

    const result = await handlePassthrough(deps, client, "poi-agent", "travel_to", "travel_to", { destination: "sol_station" });
    const parsed = parseResult(result);
    const inner = (parsed as any).result;

    expect(inner._poi_warning).toBeUndefined();
  });

  it("travel_to with valid system does not get _poi_warning", async () => {
    const client = createMockClient({ travel_to: { result: { status: "ok" } } });
    const deps = createMockDeps({ statusCache, poiValidator: mockPoiValidator });

    const result = await handlePassthrough(deps, client, "poi-agent", "travel_to", "travel_to", { destination: "sol" });
    const parsed = parseResult(result);
    const inner = (parsed as any).result;

    expect(inner._poi_warning).toBeUndefined();
  });
});

describe("dock dockability recording", () => {
  beforeEach(() => { createDatabase(":memory:"); });
  afterEach(() => { closeDb(); });

  it("marks POI as dockable on successful dock", async () => {
    registerPoi({ id: "sol_station", name: "Sol Station", system: "sol", type: "station" });

    const client = createMockClient({ dock: { result: { status: "completed" } } });
    const statusCache = new Map();
    statusCache.set("agent1", {
      data: { player: { current_poi: "sol_station", current_system: "sol", docked_at_base: true } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({
      statusCache,
      waitForDockCacheUpdate: mock(async () => true),
    });

    await handlePassthrough(deps, client, "agent1", "dock", "dock", {}, "dock");
    expect(isDockable("sol_station")).toBe(true);
  });

  it("marks POI as non-dockable on failed dock after retry", async () => {
    registerPoi({ id: "main_belt", name: "Main Belt", system: "sol", type: "belt" });

    const client = createMockClient({ dock: { result: { status: "completed" } } });
    const statusCache = new Map();
    statusCache.set("agent1", {
      data: { player: { current_poi: "main_belt", current_system: "sol", docked_at_base: null } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({
      statusCache,
      waitForDockCacheUpdate: mock(async () => false),
    });

    await handlePassthrough(deps, client, "agent1", "dock", "dock", {}, "dock");
    expect(isDockable("main_belt")).toBe(false);
  });
});

describe("pre-dock dockability check", () => {
  beforeEach(() => { createDatabase(":memory:"); });
  afterEach(() => { closeDb(); });

  it("blocks dock at known non-dockable POI without calling game API", async () => {
    registerPoi({ id: "main_belt", name: "Main Belt", system: "sol", type: "belt" });
    markDockable("main_belt", false);

    const client = createMockClient({ dock: { result: { status: "completed" } } });
    const statusCache = new Map();
    statusCache.set("agent1", {
      data: { player: { current_poi: "main_belt", current_system: "sol" } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    const result = await handlePassthrough(deps, client, "agent1", "dock", "dock", {}, "dock");

    expect(client.execute).not.toHaveBeenCalled();
    const parsed = parseResult(result) as Record<string, unknown>;
    expect(parsed.error).toBe("known_non_dockable");
    expect(String(parsed.message)).toContain("Main Belt");
    expect(String(parsed.message)).toContain("get_system");
  });

  it("allows dock at known dockable POI", async () => {
    registerPoi({ id: "sol_station", name: "Sol Station", system: "sol", type: "station" });
    markDockable("sol_station", true);

    const client = createMockClient({ dock: { result: { status: "completed" } } });
    const statusCache = new Map();
    statusCache.set("agent1", {
      data: { player: { current_poi: "sol_station", current_system: "sol", docked_at_base: true } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({
      statusCache,
      waitForDockCacheUpdate: mock(async () => true),
    });

    await handlePassthrough(deps, client, "agent1", "dock", "dock", {}, "dock");
    expect(client.execute).toHaveBeenCalled();
  });

  it("allows dock at unknown POI (dockable=null)", async () => {
    const client = createMockClient({ dock: { result: { status: "completed" } } });
    const statusCache = new Map();
    statusCache.set("agent1", {
      data: { player: { current_poi: "new_station", current_system: "sol", docked_at_base: true } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({
      statusCache,
      waitForDockCacheUpdate: mock(async () => true),
    });

    await handlePassthrough(deps, client, "agent1", "dock", "dock", {}, "dock");
    expect(client.execute).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Insurance status caching
  // ---------------------------------------------------------------------------

  it("buy_insurance: pre-flight blocks call when insurance.active=true in statusCache", async () => {
    const client = createMockClient({ buy_insurance: { result: { status: "ok" } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("insured-agent", {
      data: { insurance: { active: true, insured_at: Date.now() - 1000 } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    const result = await handlePassthrough(deps, client, "insured-agent", "buy_insurance", "buy_insurance");
    const parsed = parseResult(result) as Record<string, unknown>;

    // Should NOT have called the game API
    expect(client.execute).not.toHaveBeenCalled();
    // Should return already_insured error
    const err = parsed.error as Record<string, unknown>;
    expect(err.code).toBe("already_insured");
  });

  it("buy_insurance: goes through when statusCache has no insurance data", async () => {
    const client = createMockClient({ buy_insurance: { result: { status: "ok" } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("uninsured-agent", {
      data: { player: { credits: 5000 } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    await handlePassthrough(deps, client, "uninsured-agent", "buy_insurance", "buy_insurance");

    // Should have called through to the game API
    expect(client.execute).toHaveBeenCalledWith("buy_insurance", undefined);
  });

  it("buy_insurance: updates statusCache with active=true after success", async () => {
    const client = createMockClient({ buy_insurance: { result: { status: "ok" } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("fresh-agent", {
      data: { player: { credits: 5000 } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    await handlePassthrough(deps, client, "fresh-agent", "buy_insurance", "buy_insurance");

    const cached = statusCache.get("fresh-agent");
    const insurance = cached?.data?.insurance as Record<string, unknown> | undefined;
    expect(insurance?.active).toBe(true);
    expect(typeof insurance?.insured_at).toBe("number");
  });

  it("claim_insurance: clears insurance.active in statusCache after success", async () => {
    const client = createMockClient({ claim_insurance: { result: { status: "ok" } } });
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("claimant-agent", {
      data: { insurance: { active: true, insured_at: Date.now() - 5000 } },
      fetchedAt: Date.now(),
    });
    const deps = createMockDeps({ statusCache });

    await handlePassthrough(deps, client, "claimant-agent", "claim_insurance", "claim_insurance");

    const cached = statusCache.get("claimant-agent");
    const insurance = cached?.data?.insurance as Record<string, unknown> | undefined;
    expect(insurance?.active).toBe(false);
  });
});
