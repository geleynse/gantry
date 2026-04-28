import { describe, it, expect } from "bun:test";
import { sellCycleRoutine } from "./sell-cycle.js";
import type { RoutineContext } from "./types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type ToolHandler = (tool: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;

function mockContext(toolHandler: ToolHandler, cacheData?: Record<string, unknown>): RoutineContext {
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  if (cacheData) {
    statusCache.set("test-agent", { data: cacheData, fetchedAt: Date.now() });
  }

  return {
    agentName: "test-agent",
    client: {
      execute: toolHandler,
      waitForTick: async () => {},
    },
    statusCache,
    log: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sell_cycle routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const params = sellCycleRoutine.parseParams({ station: "sol_station" });
      expect(params.station).toBe("sol_station");
    });

    it("rejects missing station", () => {
      expect(() => sellCycleRoutine.parseParams({})).toThrow("station is required");
    });

    it("rejects non-object", () => {
      expect(() => sellCycleRoutine.parseParams("bad")).toThrow();
    });

    it("parses items array", () => {
      const params = sellCycleRoutine.parseParams({
        station: "sol_station",
        items: [{ item_id: "iron_ore", quantity: 50 }],
      });
      expect(params.items).toHaveLength(1);
      expect(params.items![0].item_id).toBe("iron_ore");
    });
  });

  describe("run", () => {
    it("completes a full sell cycle with travel and dock", async () => {
      const toolsCalled: string[] = [];
      const toolResponses: Record<string, unknown> = {
        travel_to: { status: "completed", location_after: { poi: "sol_station" } },
        dock: { status: "docked" },
        analyze_market: { demand: [{ item_id: "iron_ore", quantity: 100 }] },
        get_cargo: { cargo: [{ item_id: "iron_ore", quantity: 50 }] },
        multi_sell: { status: "completed", items_sold: 1, credits_after: 15000 },
      };

      const ctx = mockContext(
        async (tool) => { toolsCalled.push(tool); return { result: toolResponses[tool] ?? { ok: true } }; },
        { player: { current_poi: "sol_belt", credits: 10000 } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("Sold");
      expect(result.data.credits_earned).toBe(5000);
      // Dock must be called after travel
      expect(toolsCalled).toContain("dock");
      const travelIdx = toolsCalled.indexOf("travel_to");
      const dockIdx = toolsCalled.indexOf("dock");
      expect(dockIdx).toBeGreaterThan(travelIdx);
    });

    it("skips travel when already at station", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "iron_ore" }] } };
          if (tool === "get_cargo") return { result: { cargo: [{ item_id: "iron_ore", quantity: 20 }] } };
          if (tool === "multi_sell") return { result: { items_sold: 1, credits_after: 12000 } };
          return { result: { ok: true } };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 10000 } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("travel_to");
    });

    it("docks when at station but not docked", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "dock") return { result: { status: "docked" } };
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "iron_ore" }] } };
          if (tool === "get_cargo") return { result: { cargo: [{ item_id: "iron_ore", quantity: 20 }] } };
          if (tool === "multi_sell") return { result: { items_sold: 1, credits_after: 12000 } };
          return { result: { ok: true } };
        },
        { player: { current_poi: "sol_station", credits: 10000 } }, // not docked
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).toContain("dock");
      expect(toolsCalled).not.toContain("travel_to");
    });

    it("skips dock when already docked", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "iron_ore" }] } };
          if (tool === "get_cargo") return { result: { cargo: [{ item_id: "iron_ore", quantity: 20 }] } };
          if (tool === "multi_sell") return { result: { items_sold: 1, credits_after: 12000 } };
          return { result: { ok: true } };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 10000 } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("dock");
    });

    it("hands off when dock fails (Issue 3)", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "dock") return { error: { code: "dock_blocked", message: "Docking bay full" } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Could not dock at");
      expect(result.data.station).toBe("sol_station");
    });

    it("treats already_docked error as success (not a failure)", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "dock") return { error: { code: "already_docked" } };
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "iron_ore" }] } };
          if (tool === "get_cargo") return { result: { cargo: [{ item_id: "iron_ore", quantity: 20 }] } };
          if (tool === "multi_sell") return { result: { items_sold: 1, credits_after: 12000 } };
          return { result: {} };
        },
        { player: { current_poi: "sol_station" } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
    });

    it("hands off when travel fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { error: "navigation_blocked" };
          return { result: {} };
        },
        { player: { current_poi: "some_belt" } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Travel to sol_station failed");
    });

    it("hands off on 0 credits earned", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "iron_ore" }] } };
          if (tool === "get_cargo") return { result: { cargo: [{ item_id: "iron_ore", quantity: 50 }] } };
          if (tool === "multi_sell") return {
            result: {
              items_sold: 1,
              credits_after: 10000,
              warning: "0 credits earned — this station has no demand",
            },
          };
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 10000 } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("0 credits earned");
    });

    it("handles empty cargo gracefully", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "analyze_market") return { result: { demand: [] } };
          if (tool === "get_cargo") return { result: { cargo: [] } };
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base" } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("No items to sell");
    });

    it("early-aborts with handoff when no demand for any cargo item (no multi_sell call)", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          // Market returns no demand for anything
          if (tool === "analyze_market") return { result: { demand: [] } };
          // Cargo holds items the agent wants to sell
          if (tool === "get_cargo") return {
            result: {
              cargo: [
                { item_id: "iron_ore", quantity: 50 },
                { item_id: "copper_ore", quantity: 30 },
              ],
            },
          };
          // multi_sell should never be called — fail loudly if it is
          if (tool === "multi_sell") {
            throw new Error("multi_sell must NOT be called when demand is zero");
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 10000 } },
      );

      const result = await sellCycleRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("No demand at sol_station");
      expect(result.handoffReason).toContain("travel to a different station");
      expect(result.data.station).toBe("sol_station");
      expect(result.data.reason).toBe("no_demand");
      expect(result.data.items_sold).toBe(0);
      // Cargo items list should be present so the agent can route
      expect(Array.isArray(result.data.cargo_items)).toBe(true);
      expect(result.data.cargo_items).toEqual(["iron_ore", "copper_ore"]);
      // multi_sell must not have been invoked
      expect(toolsCalled).not.toContain("multi_sell");
    });

    it("sells specific items when provided", async () => {
      let sellItems: unknown;
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "analyze_market") return { result: { demand: [] } };
          if (tool === "multi_sell") {
            sellItems = args?.items;
            return { result: { items_sold: 2, credits_after: 20000 } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_station", docked_at_base: "sol_station_base", credits: 15000 } },
      );

      const items = [
        { item_id: "iron_ore", quantity: 30 },
        { item_id: "copper_ore", quantity: 20 },
      ];
      const result = await sellCycleRoutine.run(ctx, { station: "sol_station", items });
      expect(result.status).toBe("completed");
      expect(sellItems).toEqual(items);
    });
  });
});
