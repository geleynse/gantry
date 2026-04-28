import { describe, it, expect } from "bun:test";
import { navigateHomeRoutine } from "./navigate-home.js";
import type { RoutineContext } from "./types.js";

type ToolHandler = (tool: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;

function mockContext(toolHandler: ToolHandler): RoutineContext {
  return {
    agentName: "test-agent",
    client: { execute: toolHandler, waitForTick: async () => {} },
    statusCache: new Map(),
    log: () => {},
  };
}

describe("navigate_home routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = navigateHomeRoutine.parseParams({ station: "nexus_core" });
      expect(p.station).toBe("nexus_core");
      expect(p.sell).toBe(true);
      expect(p.refuel).toBe(true);
      expect(p.repair).toBe(true);
    });

    it("accepts optional system", () => {
      const p = navigateHomeRoutine.parseParams({ station: "nexus_core", system: "central" });
      expect(p.system).toBe("central");
    });

    it("disables sell/refuel/repair when false", () => {
      const p = navigateHomeRoutine.parseParams({ station: "nexus_core", sell: false, refuel: false, repair: false });
      expect(p.sell).toBe(false);
      expect(p.refuel).toBe(false);
      expect(p.repair).toBe(false);
    });

    it("rejects missing station", () => {
      expect(() => navigateHomeRoutine.parseParams({})).toThrow("station is required");
    });

    it("rejects non-object", () => {
      expect(() => navigateHomeRoutine.parseParams(null)).toThrow();
    });
  });

  describe("run", () => {
    it("travels, docks, refuels, repairs, and sells", async () => {
      const toolsCalled: string[] = [];
      let traveled = false;
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "get_status") return {
          result: {
            player: {
              current_system: "sol",
              current_poi: traveled ? "nexus_core" : "sol_belt",
              docked_at_base: traveled ? "nexus_base" : null,
              credits: 1000,
            },
            ship: { fuel: 50, fuel_max: 100, hull: 70, hull_max: 100 },
          },
        };
        if (tool === "travel_to") { traveled = true; return { result: { status: "completed" } }; }
        if (tool === "dock") return { result: { status: "docked" } };
        if (tool === "refuel") return { result: { fuel_after: 100 } };
        if (tool === "repair") return { result: { hull_after: 100 } };
        if (tool === "get_cargo") return { result: { used: 10, capacity: 50, cargo: [] } };
        if (tool === "analyze_market") return { result: { demand: [] } };
        if (tool === "multi_sell") return { result: { items_sold: 5, credits_earned: 500 } };
        return { result: {} };
      });

      const result = await navigateHomeRoutine.run(ctx, { station: "nexus_core" });
      expect(result.status).toBe("completed");
      expect(result.data.did_refuel).toBe(true);
      expect(result.data.did_repair).toBe(true);
      expect(result.data.items_sold).toBe(5);
      expect(result.summary).toContain("nexus_core");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("dock");
      expect(toolsCalled).toContain("refuel");
      expect(toolsCalled).toContain("repair");
      expect(toolsCalled).toContain("multi_sell");
    });

    it("jumps when cross-system travel needed", async () => {
      const toolsCalled: string[] = [];
      let traveled = false;
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "get_status") return {
          result: {
            player: {
              current_system: "sol",
              current_poi: traveled ? "nexus_core" : "sol_belt",
              docked_at_base: traveled ? "nexus_base" : null,
              credits: 500,
            },
            ship: { fuel: 90, fuel_max: 100, hull: 95, hull_max: 100 },
          },
        };
        if (tool === "jump_route") return { result: { status: "arrived" } };
        if (tool === "travel_to") { traveled = true; return { result: { status: "completed" } }; }
        if (tool === "dock") return { result: { status: "docked" } };
        if (tool === "get_cargo") return { result: { used: 0, capacity: 50 } };
        return { result: {} };
      });

      const result = await navigateHomeRoutine.run(ctx, { station: "nexus_core", system: "central" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).toContain("jump_route");
      expect(result.data.did_refuel).toBe(false);
      expect(result.data.did_repair).toBe(false);
    });

    it("skips sell when cargo empty", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "get_status") return {
          result: {
            player: { current_system: "sol", current_poi: "nexus_core", docked_at_base: "nexus_base", credits: 500 },
            ship: { fuel: 90, fuel_max: 100, hull: 95, hull_max: 100 },
          },
        };
        if (tool === "get_cargo") return { result: { used: 0, capacity: 50 } };
        return { result: {} };
      });

      const result = await navigateHomeRoutine.run(ctx, { station: "nexus_core" });
      expect(result.status).toBe("completed");
      expect(result.data.items_sold).toBe(0);
      expect(toolsCalled).not.toContain("multi_sell");
    });

    it("skips sell when sell=false", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "get_status") return {
          result: {
            player: { current_system: "sol", current_poi: "nexus_core", docked_at_base: "nexus_base", credits: 500 },
            ship: { fuel: 90, fuel_max: 100, hull: 95, hull_max: 100 },
          },
        };
        return { result: {} };
      });

      const result = await navigateHomeRoutine.run(ctx, { station: "nexus_core", sell: false });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("get_cargo");
      expect(toolsCalled).not.toContain("multi_sell");
    });

    it("hands off on travel failure", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: {
            player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
            ship: { fuel: 90, fuel_max: 100, hull: 95, hull_max: 100 },
          },
        };
        if (tool === "travel_to") return { error: "path_blocked" };
        return { result: {} };
      });

      const result = await navigateHomeRoutine.run(ctx, { station: "nexus_core" });
      expect(result.status).toBe("handoff");
      expect(result.summary).toContain("failed");
    });

    it("hands off on jump failure", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: {
            player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null },
            ship: { fuel: 10, fuel_max: 100, hull: 95, hull_max: 100 },
          },
        };
        if (tool === "jump_route") return { error: "insufficient_fuel" };
        return { result: {} };
      });

      const result = await navigateHomeRoutine.run(ctx, { station: "nexus_core", system: "central" });
      expect(result.status).toBe("handoff");
      expect(result.summary).toContain("Jump");
    });

    it("hands off when travel succeeds but ship doesn't actually arrive", async () => {
      // Simulates the bug: travel_to returns 'completed' but the ship is still at the origin
      // (game-side glitch, stale cache, or partial failure). Routine must NOT report 'completed'.
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: {
            // current_poi never updates — ship didn't arrive
            player: { current_system: "sol", current_poi: "sol_belt", docked_at_base: null, credits: 1000 },
            ship: { fuel: 50, fuel_max: 100, hull: 70, hull_max: 100 },
          },
        };
        if (tool === "travel_to") return { result: { status: "completed" } };
        if (tool === "dock") return { result: { status: "docked" } };
        return { result: {} };
      });

      const result = await navigateHomeRoutine.run(ctx, { station: "nexus_core" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("not at nexus_core");
    });
  });
});
