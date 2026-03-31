import { describe, it, expect } from "bun:test";
import { exploreAndMineRoutine } from "./explore-and-mine.js";
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

describe("explore_and_mine routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = exploreAndMineRoutine.parseParams({ system: "alpha", returnStation: "nexus_core" });
      expect(p.system).toBe("alpha");
      expect(p.returnStation).toBe("nexus_core");
    });

    it("rejects missing system", () => {
      expect(() => exploreAndMineRoutine.parseParams({ returnStation: "x" })).toThrow("system is required");
    });

    it("rejects missing returnStation", () => {
      expect(() => exploreAndMineRoutine.parseParams({ system: "x" })).toThrow("returnStation is required");
    });
  });

  describe("run", () => {
    it("jumps, finds belts, mines, returns, sells", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool, args) => {
        toolsCalled.push(tool);
        if (tool === "get_status") return {
          result: { player: { current_system: "sol", current_poi: "sol_station" } },
        };
        if (tool === "jump_route") return { result: { status: "arrived" } };
        if (tool === "get_system") return {
          result: {
            pois: [
              { id: "alpha_belt_1", name: "Alpha Belt 1", type: "asteroid_belt" },
              { id: "alpha_station", name: "Alpha Station", type: "station" },
            ],
          },
        };
        if (tool === "travel_to") return { result: { status: "completed" } };
        if (tool === "batch_mine") return { result: { mines_completed: 5, total_ore: 25 } };
        if (tool === "get_cargo") return { result: { used: 20, capacity: 50 } };
        if (tool === "dock") return { result: { docked: true } };
        if (tool === "analyze_market") return { result: { demand: ["ore"] } };
        if (tool === "multi_sell") return { result: { items_sold: 3, credits_earned: 150 } };
        return { result: {} };
      });

      const result = await exploreAndMineRoutine.run(ctx, {
        system: "alpha",
        returnStation: "nexus_core",
      });
      expect(result.status).toBe("completed");
      expect(result.data.belts_mined).toEqual(["alpha_belt_1"]);
      expect(result.data.total_ore).toBe(5);
      expect(result.data.items_sold).toBe(3);
      expect(toolsCalled).toContain("jump_route");
      expect(toolsCalled).toContain("get_system");
      expect(toolsCalled).toContain("batch_mine");
      expect(toolsCalled).toContain("multi_sell");
    });

    it("hands off when no belts found", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: { player: { current_system: "alpha" } },
        };
        if (tool === "get_system") return {
          result: {
            pois: [
              { id: "alpha_station", name: "Alpha Station", type: "station" },
              { id: "alpha_planet", name: "Alpha Prime", type: "planet" },
            ],
          },
        };
        return { result: {} };
      });

      const result = await exploreAndMineRoutine.run(ctx, {
        system: "alpha",
        returnStation: "nexus_core",
      });
      expect(result.status).toBe("handoff");
      expect(result.summary).toContain("No asteroid belts");
    });

    it("skips jump when already in target system", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(async (tool) => {
        toolsCalled.push(tool);
        if (tool === "get_status") return {
          result: { player: { current_system: "alpha" } },
        };
        if (tool === "get_system") return {
          result: { pois: [{ id: "belt_1", name: "Belt 1", type: "asteroid_belt" }] },
        };
        if (tool === "travel_to") return { result: { status: "completed" } };
        if (tool === "batch_mine") return { result: { mines_completed: 3 } };
        if (tool === "get_cargo") return { result: { used: 5, capacity: 50 } };
        if (tool === "dock") return { result: { docked: true } };
        if (tool === "analyze_market") return { result: {} };
        if (tool === "multi_sell") return { result: { items_sold: 2 } };
        return { result: {} };
      });

      const result = await exploreAndMineRoutine.run(ctx, {
        system: "alpha",
        returnStation: "nexus_core",
      });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("jump_route");
    });

    it("stops mining when cargo near full", async () => {
      let mineCount = 0;
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: { player: { current_system: "sol" } },
        };
        if (tool === "jump_route") return { result: { status: "arrived" } };
        if (tool === "get_system") return {
          result: {
            pois: [
              { id: "belt_1", type: "asteroid_belt" },
              { id: "belt_2", type: "asteroid_belt" },
            ],
          },
        };
        if (tool === "travel_to") return { result: { status: "completed" } };
        if (tool === "batch_mine") {
          mineCount++;
          return { result: { mines_completed: 5 } };
        }
        if (tool === "get_cargo") return { result: { used: 48, capacity: 50 } }; // 96% full
        if (tool === "dock") return { result: { docked: true } };
        if (tool === "analyze_market") return { result: {} };
        if (tool === "multi_sell") return { result: { items_sold: 5 } };
        return { result: {} };
      });

      const result = await exploreAndMineRoutine.run(ctx, {
        system: "alpha",
        returnStation: "nexus_core",
      });
      expect(result.status).toBe("completed");
      expect(mineCount).toBe(1); // Should stop after first belt due to cargo
    });

    it("hands off on jump failure", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "get_status") return {
          result: { player: { current_system: "sol" } },
        };
        if (tool === "jump_route") return { error: "insufficient_fuel" };
        return { result: {} };
      });

      const result = await exploreAndMineRoutine.run(ctx, {
        system: "alpha",
        returnStation: "nexus_core",
      });
      expect(result.status).toBe("handoff");
      expect(result.summary).toContain("Jump");
    });
  });
});
