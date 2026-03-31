import { describe, it, expect } from "bun:test";
import { miningLoopRoutine } from "./mining-loop.js";
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

describe("mining_loop routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = miningLoopRoutine.parseParams({ belt: "sol_belt", cycles: 3 });
      expect(p.belt).toBe("sol_belt");
      expect(p.cycles).toBe(3);
    });

    it("defaults cycles to undefined", () => {
      const p = miningLoopRoutine.parseParams({ belt: "sol_belt" });
      expect(p.cycles).toBeUndefined();
    });

    it("rejects missing belt", () => {
      expect(() => miningLoopRoutine.parseParams({})).toThrow("belt is required");
    });

    it("rejects non-object", () => {
      expect(() => miningLoopRoutine.parseParams("bad")).toThrow();
    });

    it("rejects invalid cycles", () => {
      expect(() => miningLoopRoutine.parseParams({ belt: "x", cycles: -1 })).toThrow("positive");
    });
  });

  describe("run", () => {
    it("completes full mining loop with travel", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "travel_to") return { result: { status: "completed" } };
          if (tool === "batch_mine") return { result: { mines_completed: 20, cargo_after: { used: 45, max: 70 } } };
          return { result: {} };
        },
        { player: { current_poi: "sol_station" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt", cycles: 2 });
      expect(result.status).toBe("completed");
      expect(result.data.cycles_done).toBe(2);
      expect(result.data.cargo_full).toBe(false);
      expect(result.summary).toContain("Mined 2 cycles at sol_belt");
      expect(result.summary).toContain("cargo 45/70");
      expect(toolsCalled).toContain("travel_to");
    });

    it("skips travel when already at belt", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "batch_mine") return { result: { mines_completed: 20, cargo_after: { used: 30, max: 70 } } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt", cycles: 1 });
      expect(result.status).toBe("completed");
      expect(toolsCalled).not.toContain("travel_to");
    });

    it("stops on cargo_full from stopped_reason", async () => {
      let mineCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "batch_mine") {
            mineCount++;
            if (mineCount === 2) {
              return { result: { mines_completed: 10, stopped_reason: "cargo_full", cargo_after: { used: 70, max: 70 } } };
            }
            return { result: { mines_completed: 20, cargo_after: { used: 50, max: 70 } } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt", cycles: 5 });
      expect(result.status).toBe("completed");
      expect(result.data.cycles_done).toBe(2);
      expect(result.data.cargo_full).toBe(true);
      expect(result.summary).toContain("cargo full");
    });

    it("stops on cargo_full error response", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "batch_mine") return { error: { code: "cargo_full", message: "Cargo is full" } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt", cycles: 3 });
      expect(result.status).toBe("completed");
      expect(result.data.cargo_full).toBe(true);
      expect(result.data.cycles_done).toBe(1);
    });

    it("hands off when travel fails", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "travel_to") return { error: "navigation_blocked" };
          return { result: {} };
        },
        { player: { current_poi: "sol_station" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Travel to sol_belt failed");
    });

    it("defaults to 3 cycles", async () => {
      let mineCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "batch_mine") {
            mineCount++;
            return { result: { mines_completed: 20, cargo_after: { used: 20 * mineCount, max: 70 } } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt" });
      expect(result.data.cycles_done).toBe(3);
      expect(mineCount).toBe(3);
    });

    it("continues past non-fatal mine errors", async () => {
      let mineCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "batch_mine") {
            mineCount++;
            if (mineCount === 1) return { error: { code: "cooldown", message: "Mining cooldown" } };
            return { result: { mines_completed: 20, cargo_after: { used: 40, max: 70 } } };
          }
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt", cycles: 2 });
      expect(result.status).toBe("completed");
      // cycle 1 errored (not counted as done), cycle 2 succeeded
      expect(result.data.cycles_done).toBe(1);
    });

    it("stops early when cargo exceeds 90% threshold", async () => {
      let callCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_cargo") {
            callCount++;
            if (callCount === 2) {
              return { result: { used: 91, capacity: 100 } };
            }
            return { result: { used: 10, capacity: 100 } };
          }
          if (tool === "batch_mine") return { result: { mines_completed: 20, cargo_after: { used: 30, max: 100 } } };
          return { result: {} };
        },
        { player: { current_poi: "sol_belt" } },
      );

      const result = await miningLoopRoutine.run(ctx, { belt: "sol_belt", cycles: 5 });
      expect(result.status).toBe("completed");
      expect(result.data.cycles_done).toBe(1); // 1st cycle OK, 2nd cycle stopped BEFORE starting
      expect(result.data.cargo_full).toBe(true);
      expect(result.summary).toContain("cargo 91/100");
    });
  });
});
