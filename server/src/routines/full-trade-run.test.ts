import { describe, it, expect, mock } from "bun:test";
import { fullTradeRunRoutine } from "./full-trade-run.js";
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

describe("full_trade_run routine", () => {
  describe("parseParams", () => {
    it("parses valid params with all fields", () => {
      const p = fullTradeRunRoutine.parseParams({
        target_system: "SYS-A",
        belt: "BELT-1",
        station: "STATION-1",
        cycles: 5,
      });
      expect(p.target_system).toBe("SYS-A");
      expect(p.belt).toBe("BELT-1");
      expect(p.station).toBe("STATION-1");
      expect(p.cycles).toBe(5);
    });

    it("parses valid params without optional fields", () => {
      const p = fullTradeRunRoutine.parseParams({ belt: "BELT-1", station: "STATION-1" });
      expect(p.target_system).toBeUndefined();
      expect(p.cycles).toBeUndefined();
    });

    it("rejects missing belt", () => {
      expect(() => fullTradeRunRoutine.parseParams({ station: "STATION-1" })).toThrow("belt is required");
    });

    it("rejects invalid cycles", () => {
      expect(() => fullTradeRunRoutine.parseParams({ belt: "B", station: "S", cycles: 0 })).toThrow("positive number");
    });
  });

  describe("run", () => {
    it("completes a full trade run without a jump", async () => {
      const toolHandler = async (tool: string, args: any) => {
        if (tool === "travel_to" && args.destination === "BELT-1") return { result: { status: "arrived" } };
        if (tool === "batch_mine") return { result: { mines_completed: args?.count ?? 0 } };
        if (tool === "travel_to" && args.destination === "STATION-1") return { result: { status: "arrived" } };
        if (tool === "dock") return { result: { status: "docked" } };
        if (tool === "analyze_market") return { result: { demand: [{ item_id: "STEEL" }] } };
        if (tool === "craft") return { result: { items_crafted: [{ item_id: "STEEL" }] } };
        if (tool === "get_cargo") return { result: { cargo: [{ item_id: "STEEL", quantity: 10 }, { item_id: "JUNK", quantity: 5 }] } };
        if (tool === "multi_sell") return { result: { items_sold: 1, credits_after: 1100 } };
        if (tool === "create_sell_order") return { result: { order_created: true } };
        if (tool === "refuel") return { result: { fuel: 100 } };
        return { result: {} };
      };
      const ctx = mockContext(toolHandler, { player: { credits: 1000, current_system: "SYS-B" } });

      const result = await fullTradeRunRoutine.run(ctx, { belt: "BELT-1", station: "STATION-1" });

      expect(result.status).toBe("completed");
      expect(result.summary).toContain("Full trade run complete");
      expect(result.summary).toContain("Mined 30 ore");
      expect(result.summary).toContain("sold 1 items");
      expect(result.summary).toContain("Earned 0 credits"); // cache not updated mid-routine
      expect(ctx.client.execute).not.toHaveBeenCalledWith("jump_route", expect.anything());
    });

    it("handles combat during mining and hands off", async () => {
      const ctx = mockContext(async (tool) => {
        if (tool === "travel_to") return { result: {} };
        if (tool === "batch_mine") return { result: { battle_started: true } };
        return { result: {} };
      });

      const result = await fullTradeRunRoutine.run(ctx, { belt: "B", station: "S" });
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("Combat detected during mining");
    });

    it("hands off if jump fails", async () => {
        const ctx = mockContext(
            async (tool) => {
                if (tool === "jump_route") return { error: "fuel low" };
                return { result: {} };
            },
            { player: { current_system: "SYS-A" } }
        );

        const result = await fullTradeRunRoutine.run(ctx, { target_system: "SYS-C", belt: "B", station: "S" });
        expect(result.status).toBe("handoff");
        expect(result.handoffReason).toContain("Jump to SYS-C failed");
    });

    it("sells items with demand and creates orders for the rest", async () => {
        const toolHandler = async (tool: string, args: any) => {
            if (tool === "travel_to") return { result: {} };
            if (tool === "batch_mine") return { result: { mines_completed: 1 } };
            if (tool === "dock") return { result: {} };
            if (tool === "analyze_market") return { result: { demand: [{ item_id: "STEEL" }] } };
            if (tool === "craft") return { result: { items_crafted: [{ id: "STEEL" }, {id: "COPPER"}] } };
            if (tool === "get_cargo") return { result: { cargo: [{ item_id: "STEEL", quantity: 10 }, { item_id: "COPPER", quantity: 5 }] } };
            if (tool === "multi_sell") {
                expect(args.items).toEqual([{ item_id: "STEEL", quantity: 10 }]);
                return { result: { items_sold: 1 } };
            }
            if (tool === "create_sell_order") {
                expect(args.item_id).toBe("COPPER");
                return { result: { order_created: true } };
            }
            if (tool === "refuel") return { result: { fuel: 90 } };
            return { result: {} };
        };
        const ctx = mockContext(toolHandler, { player: { credits: 0, current_system: "SYS-A" } });

        const result = await fullTradeRunRoutine.run(ctx, { belt: "B", station: "S" });
        expect(result.status).toBe("completed");
        expect(result.data.items_sold).toBe(1);
        expect(result.data.sell_orders_created).toBe(1);
        expect(ctx.client.execute).toHaveBeenCalledWith("multi_sell", expect.anything());
        expect(ctx.client.execute).toHaveBeenCalledWith("create_sell_order", expect.anything());
    });

    it("stops mining early when cargo exceeds 90% threshold", async () => {
        let getCargoCount = 0;
        const toolHandler = async (tool: string, args: any) => {
            if (tool === "get_cargo") {
              getCargoCount++;
              if (getCargoCount === 2) return { result: { used: 95, capacity: 100 } };
              return { result: { used: 10, capacity: 100 } };
            }
            if (tool === "travel_to" || tool === "dock" || tool === "refuel" || tool === "analyze_market" || tool === "craft" || tool === "multi_sell") return { result: {} };
            if (tool === "batch_mine") return { result: { mines_completed: 10 } };
            return { result: {} };
        };
        const ctx = mockContext(toolHandler, { player: { credits: 0, current_system: "SYS-A" } });

        const result = await fullTradeRunRoutine.run(ctx, { belt: "B", station: "S", cycles: 3 });
        expect(result.status).toBe("completed");
        expect(result.data.ores_mined).toBe(10); // stopped before 2nd batch
        expect(result.summary).toContain("Mined 10 ore");
    });
  });
});
