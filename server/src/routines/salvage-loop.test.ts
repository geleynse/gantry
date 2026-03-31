import { describe, it, expect } from "bun:test";
import { salvageLoopRoutine } from "./salvage-loop.js";
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

describe("salvage_loop routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = salvageLoopRoutine.parseParams({ station: "sol_station", max_wrecks: 3 });
      expect(p.station).toBe("sol_station");
      expect(p.max_wrecks).toBe(3);
    });

    it("rejects missing station", () => {
      expect(() => salvageLoopRoutine.parseParams({})).toThrow("station is required");
    });
  });

  describe("run", () => {
    it("completes salvage loop: loot + travel + sell", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_wrecks") return { result: [{ id: "w1" }, { id: "w2" }] };
          if (tool === "loot_wreck") return { result: { items: [{ id: "scrap" }] } };
          if (tool === "get_cargo") return { result: { used: 10, max: 100, items: [{ item_id: "scrap", quantity: 10 }] } };
          if (tool === "travel_to") return { result: { status: "arrived" } };
          if (tool === "dock") return { result: { status: "docked" } };
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "scrap" }] } };
          if (tool === "multi_sell") return { result: { items_sold: 1, credits_after: 1500 } };
          if (tool === "refuel") return { result: { fuel: 100 } };
          return { result: {} };
        },
        { player: { credits: 1000 } },
      );

      const result = await salvageLoopRoutine.run(ctx, { station: "sol_station", max_wrecks: 2 });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("Looted 2 wrecks");
      expect(result.summary).toContain("sold 1 items for +500 credits");
      expect(toolsCalled).toContain("get_wrecks");
      expect(toolsCalled).toContain("loot_wreck");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("multi_sell");
      expect(toolsCalled).toContain("refuel");
    });

    it("stops looting when cargo is full", async () => {
      let lootCount = 0;
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_wrecks") return { result: [{ id: "w1" }, { id: "w2" }, { id: "w3" }] };
          if (tool === "loot_wreck") {
            lootCount++;
            return { result: {} };
          }
          if (tool === "get_cargo") {
            // Full after 1st loot
            if (lootCount === 1) return { result: { used: 95, max: 100 } };
            return { result: { used: 10, max: 100 } };
          }
          if (tool === "analyze_market") return { result: { demand: [] } };
          return { result: {} };
        },
        { player: { credits: 1000 } },
      );

      const result = await salvageLoopRoutine.run(ctx, { station: "sol_station", max_wrecks: 3 });
      expect(result.status).toBe("completed");
      expect(result.data.looted_count).toBe(1);
    });

    it("aborts on combat during loot", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "get_wrecks") return { result: [{ id: "w1" }] };
          if (tool === "loot_wreck") return { result: { battle_started: true } };
          return { result: {} };
        },
        { player: { credits: 1000 } },
      );

      const result = await salvageLoopRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Combat detected");
    });

    it("returns early when no wrecks and empty cargo", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_wrecks") return { result: [] };
          if (tool === "get_cargo") return { result: { used: 0, capacity: 100 } };
          return { result: {} };
        },
        { player: { credits: 1000 } },
      );

      const result = await salvageLoopRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.summary).toContain("No wrecks found");
      expect(result.data.looted_count).toBe(0);
      expect(toolsCalled).not.toContain("travel_to");
      expect(toolsCalled).not.toContain("multi_sell");
    });

    it("proceeds to sell when no wrecks but has cargo", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_wrecks") return { result: [] };
          if (tool === "get_cargo") return { result: { used: 10, capacity: 100, items: [{ item_id: "scrap", quantity: 5 }] } };
          if (tool === "travel_to") return { result: { status: "arrived" } };
          if (tool === "dock") return { result: { docked: true } };
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "scrap" }] } };
          if (tool === "multi_sell") return { result: { items_sold: 1, credits_after: 1200 } };
          if (tool === "refuel") return { result: { fuel: 100 } };
          return { result: {} };
        },
        { player: { credits: 1000 } },
      );

      const result = await salvageLoopRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.looted_count).toBe(0);
      expect(result.data.items_sold).toBe(1);
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("multi_sell");
    });

    it("skips sell if no demand", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "get_wrecks") return { result: [{ id: "w1" }] };
          if (tool === "loot_wreck") return { result: {} };
          if (tool === "get_cargo") return { result: { used: 10, max: 100, items: [{ id: "scrap", qty: 1 }] } };
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "other" }] } };
          return { result: {} };
        },
        { player: { credits: 1000 } },
      );

      const result = await salvageLoopRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(result.data.items_sold).toBe(0);
      expect(toolsCalled).not.toContain("multi_sell");
    });
  });
});
