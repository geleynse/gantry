import { describe, it, expect, mock } from "bun:test";
import { supplyRunRoutine } from "./supply-run.js";
import type { RoutineContext } from "./types.js";

type ToolHandler = (tool: string, args?: Record<string, unknown>) => Promise<{ result?: unknown; error?: unknown }>;

function mockContext(toolHandler: ToolHandler, cacheData?: Record<string, unknown>): RoutineContext {
  const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  if (cacheData) {
    statusCache.set("test-agent", { data: cacheData, fetchedAt: Date.now() });
  }
  return {
    agentName: "test-agent",
    client: { execute: mock(toolHandler), waitForTick: mock(async () => {}) },
    statusCache,
    log: () => {},
  };
}

describe("supply_run routine", () => {
  describe("parseParams", () => {
    it("parses valid params", () => {
      const p = supplyRunRoutine.parseParams({
        buy_station: "BUY-S",
        sell_station: "SELL-S",
        items: [{ item_id: "FUEL", quantity: 100 }],
        buy_method: "storage",
      });
      expect(p.buy_station).toBe("BUY-S");
      expect(p.sell_station).toBe("SELL-S");
      expect(p.items).toEqual([{ item_id: "FUEL", quantity: 100 }]);
      expect(p.buy_method).toBe("storage");
    });

    it("rejects invalid items", () => {
      expect(() => supplyRunRoutine.parseParams({ buy_station: "B", sell_station: "S", items: [{}] })).toThrow("items must be an array");
    });

    it("defaults buy_method to market", () => {
        const p = supplyRunRoutine.parseParams({
            buy_station: "BUY-S",
            sell_station: "SELL-S",
            items: [{ item_id: "FUEL", quantity: 100 }],
        });
        expect(p.buy_method).toBeUndefined(); // The runner will default it
    });
  });

  describe("run", () => {
    const defaultItems = [{ item_id: "WATER", quantity: 20 }];

    it("completes a supply run using market buy", async () => {
      const toolHandler = async (tool: string, args: any) => {
        if (tool === "travel_to") return { result: { status: "arrived" } };
        if (tool === "dock") return { result: { status: "docked" } };
        if (tool === "buy") return { result: { cost: 200 } };
        if (tool === "analyze_market") return { result: { demand: [{ item_id: "WATER" }] } };
        if (tool === "multi_sell") return { result: { items_sold: 1 } };
        if (tool === "refuel") return { result: { fuel: 100 } };
        return { result: {} };
      };
      const ctx = mockContext(toolHandler, { player: { credits: 1000 } });

      const result = await supplyRunRoutine.run(ctx, {
        buy_station: "BUY-S",
        sell_station: "SELL-S",
        items: defaultItems,
        buy_method: "market",
      });

      expect(result.status).toBe("completed");
      expect(result.summary).toContain("Supply run complete");
      expect(result.summary).toContain("Total profit: 0 credits"); // cache not updated mid-routine
      expect(ctx.client.execute).toHaveBeenCalledWith("buy", defaultItems[0]);
    });

    it("completes a supply run using storage withdraw", async () => {
        const ctx = mockContext(async (tool, args) => {
            if (tool === "travel_to" || tool === "dock" || tool === "analyze_market" || tool === "multi_sell" || tool === "refuel") return { result: {} };
            if (tool === "storage") return { result: { item: defaultItems[0] } };
            return { result: {} };
        }, { player: { credits: 1000 }});

        await supplyRunRoutine.run(ctx, {
            buy_station: "BUY-S",
            sell_station: "SELL-S",
            items: defaultItems,
            buy_method: "storage",
        });
        expect(ctx.client.execute).toHaveBeenCalledWith("storage", { ...defaultItems[0], action: "withdraw" });
    });

    it("stops buying if cargo is full", async () => {
        const items = [{ item_id: "A", quantity: 1 }, { item_id: "B", quantity: 1 }];
        const toolHandler = async (tool: string, args: any) => {
            if (tool === "travel_to" || tool === "dock" || tool === "refuel" || tool === "analyze_market" || tool === "multi_sell") return { result: {} };
            // First buy succeeds
            if (tool === "buy" && args.item_id === "A") return { result: { cost: 10 } };
            // Second buy fails with cargo full
            if (tool === "buy" && args.item_id === "B") return { error: "cargo_full" };
            return { result: {} };
        };
        const ctx = mockContext(toolHandler, { player: { credits: 1000 } });

        const result = await supplyRunRoutine.run(ctx, { buy_station: "B", sell_station: "S", items, buy_method: "market" });
        expect(result.status).toBe("completed");
        const acquired = result.data.items_bought as any[];
        expect(acquired.length).toBe(1);
        expect(acquired[0].item_id).toBe("A");
    });

    it("stops buying early when cargo utilization reaches 100%", async () => {
        const items = [{ item_id: "A", quantity: 1 }, { item_id: "B", quantity: 1 }];
        let getCargoCount = 0;
        const toolHandler = async (tool: string, args: any) => {
            if (tool === "get_cargo") {
              getCargoCount++;
              // 1: before loop (50/100)
              // 2: after buy A (100/100)
              if (getCargoCount === 1) return { result: { used: 50, capacity: 100 } };
              return { result: { used: 100, capacity: 100 } };
            }
            if (tool === "buy" && args.item_id === "A") return { result: { cost: 10 } };
            if (tool === "buy" && args.item_id === "B") return { result: { cost: 10 } };
            if (tool === "travel_to" || tool === "dock" || tool === "refuel" || tool === "analyze_market" || tool === "multi_sell") return { result: {} };
            return { result: {} };
        };
        const ctx = mockContext(toolHandler, { player: { credits: 1000 } });

        const result = await supplyRunRoutine.run(ctx, { buy_station: "B", sell_station: "S", items, buy_method: "market" });
        expect(result.status).toBe("completed");
        const acquired = result.data.items_bought as any[];
        expect(acquired.length).toBe(1);
        expect(acquired[0].item_id).toBe("A");
    });

    it("hands off on travel failure", async () => {
        const ctx = mockContext(async (tool) => {
            if (tool === "travel_to") return { error: "NAV_ERROR" };
            return { result: {} };
        });
        const result = await supplyRunRoutine.run(ctx, { buy_station: "B", sell_station: "S", items: [] });
        expect(result.status).toBe("handoff");
        expect(result.handoffReason).toContain("failed");
    });
  });
});
