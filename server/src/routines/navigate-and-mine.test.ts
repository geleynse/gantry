import { describe, it, expect } from "bun:test";
import { navigateAndMineRoutine } from "./navigate-and-mine.js";
import type { RoutineContext } from "./types.js";

type ToolHandler = (tool: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;

function mockContext(toolHandler: ToolHandler, cacheData?: Record<string, unknown>): RoutineContext {
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  if (cacheData) {
    statusCache.set("test-agent", { data: cacheData, fetchedAt: Date.now() });
  }
  return {
    agentName: "test-agent",
    client: { execute: toolHandler, waitForTick: async () => {} },
    statusCache,
    log: () => {},
  };
}

describe("navigate_and_mine routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = navigateAndMineRoutine.parseParams({ system: "sol", belt: "sol_belt", returnStation: "sol_station", cycles: 2 });
      expect(p.system).toBe("sol");
      expect(p.belt).toBe("sol_belt");
      expect(p.returnStation).toBe("sol_station");
      expect(p.cycles).toBe(2);
    });

    it("defaults cycles to undefined", () => {
      const p = navigateAndMineRoutine.parseParams({ system: "sol", belt: "sol_belt", returnStation: "sol_station" });
      expect(p.cycles).toBeUndefined();
    });

    it("rejects missing system", () => {
      expect(() => navigateAndMineRoutine.parseParams({ belt: "sol_belt", returnStation: "sol_station" })).toThrow("system is required");
    });

    it("rejects missing belt", () => {
      expect(() => navigateAndMineRoutine.parseParams({ system: "sol", returnStation: "sol_station" })).toThrow("belt is required");
    });

    it("rejects missing returnStation", () => {
      expect(() => navigateAndMineRoutine.parseParams({ system: "sol", belt: "sol_belt" })).toThrow("returnStation is required");
    });

    it("rejects non-object", () => {
      expect(() => navigateAndMineRoutine.parseParams("bad")).toThrow();
    });

    it("rejects invalid cycles", () => {
      expect(() => navigateAndMineRoutine.parseParams({ system: "sol", belt: "x", returnStation: "y", cycles: 0 })).toThrow("positive");
    });
  });

  describe("run", () => {
    it("completes full trip: jump + mine + return + refuel", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "jump_route") return { result: { status: "jumped" } };
          if (tool === "travel_to") return { result: { status: "arrived" } };
          if (tool === "batch_mine") return { result: { mines_completed: 20, cargo_after: { used: 40, max: 70 } } };
          if (tool === "refuel") return { result: { fuel: 100 } };
          return { result: {} };
        },
        { player: { current_system: "other_system", current_poi: "other_station" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station", cycles: 2 });
      expect(result.status).toBe("completed");
      expect(result.data.cycles_done).toBe(2);
      expect(result.data.cargo_full).toBe(false);
      expect(result.summary).toContain("Mined 2 cycles at sol_belt in sol");
      expect(result.summary).toContain("cargo 40/70");
      expect(result.summary).toContain("sol_station");
      expect(toolsCalled).toContain("jump_route");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("batch_mine");
      expect(toolsCalled).toContain("refuel");
    });

    it("skips jump when already in target system", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "travel_to") return { result: { status: "arrived" } };
          if (tool === "batch_mine") return { result: { mines_completed: 15, cargo_after: { used: 20, max: 70 } } };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { current_system: "sol", current_poi: "sol_station" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("jump_route");
    });

    it("stops on cargo_full stopped_reason", async () => {
      let mineCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: {} };
          if (tool === "batch_mine") {
            mineCount++;
            if (mineCount === 2) {
              return { result: { mines_completed: 10, stopped_reason: "cargo_full", cargo_after: { used: 70, max: 70 } } };
            }
            return { result: { mines_completed: 20, cargo_after: { used: 40, max: 70 } } };
          }
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { current_system: "sol", current_poi: "other" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station", cycles: 5 });
      expect(result.status).toBe("completed");
      expect(result.data.cargo_full).toBe(true);
      expect(result.data.cycles_done).toBe(2);
      expect(result.summary).toContain("cargo full");
    });

    it("stops on cargo_full error response", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: {} };
          if (tool === "batch_mine") return { error: { code: "cargo_full", message: "Cargo is full" } };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { current_system: "sol", current_poi: "other" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station", cycles: 3 });
      expect(result.status).toBe("completed");
      expect(result.data.cargo_full).toBe(true);
      expect(result.data.cycles_done).toBe(1);
    });

    it("hands off when jump_route fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "jump_route") return { error: "navigation_blocked" };
          return { result: {} };
        },
        { player: { current_system: "other_system" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("jump_route to sol failed");
    });

    it("hands off when travel to belt fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { error: "nav_error" };
          return { result: {} };
        },
        { player: { current_system: "sol", current_poi: "sol_station" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Travel to sol_belt failed");
    });

    it("hands off when all mine cycles yield zero ore", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: {} };
          if (tool === "batch_mine") return { result: { mines_completed: 0, cargo_after: { used: 0, max: 70 } } };
          return { result: {} };
        },
        { player: { current_system: "sol", current_poi: "other" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station", cycles: 2 });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("depleted");
    });

    it("defaults to 3 cycles", async () => {
      let mineCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: {} };
          if (tool === "batch_mine") {
            mineCount++;
            return { result: { mines_completed: 10, cargo_after: { used: mineCount * 10, max: 70 } } };
          }
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { current_system: "sol", current_poi: "other" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station" });
      expect(result.data.cycles_done).toBe(3);
      expect(mineCount).toBe(3);
    });

    it("continues past non-fatal mine errors", async () => {
      let mineCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { result: {} };
          if (tool === "batch_mine") {
            mineCount++;
            if (mineCount === 1) return { error: { code: "cooldown", message: "Mining cooldown" } };
            return { result: { mines_completed: 20, cargo_after: { used: 40, max: 70 } } };
          }
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { current_system: "sol", current_poi: "other" } },
      );

      const result = await navigateAndMineRoutine.run(ctx, { system: "sol", belt: "sol_belt", returnStation: "sol_station", cycles: 2 });
      expect(result.status).toBe("completed");
      // cycle 1 errored (skipped), cycle 2 succeeded
      expect(result.data.cycles_done).toBe(1);
    });
  });
});
