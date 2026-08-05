import { describe, it, expect, mock } from "bun:test";
import { craftAndSellRoutine, DEFAULT_RECIPES } from "./craft-and-sell.js";
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

describe("craft_and_sell routine", () => {
  describe("parseParams", () => {
    it("parses valid full params", () => {
      const p = craftAndSellRoutine.parseParams({ station: "sol_station", recipes: ["refine_steel"], refuel: false });
      expect(p.station).toBe("sol_station");
      expect(p.recipes).toEqual(["refine_steel"]);
      expect(p.refuel).toBe(false);
    });

    it("parses empty object with all defaults", () => {
      const p = craftAndSellRoutine.parseParams({});
      expect(p.station).toBeUndefined();
      expect(p.recipes).toBeUndefined();
      expect(p.refuel).toBeUndefined();
    });

    it("rejects non-object", () => {
      expect(() => craftAndSellRoutine.parseParams("bad")).toThrow();
    });

    it("rejects empty station string", () => {
      expect(() => craftAndSellRoutine.parseParams({ station: "" })).toThrow("non-empty string");
    });

    it("rejects non-array recipes", () => {
      expect(() => craftAndSellRoutine.parseParams({ recipes: "refine_steel" })).toThrow("array of strings");
    });

    it("rejects non-boolean refuel", () => {
      expect(() => craftAndSellRoutine.parseParams({ refuel: 1 })).toThrow("boolean");
    });
  });

  describe("run", () => {
    it("completes full cycle when already docked: craft + analyze + sell + refuel", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "craft") return { result: { crafted: 5 } };
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "steel_plate" }] } };
          if (tool === "get_cargo") return { result: [{ item_id: "steel_plate", quantity: 10 }] };
          if (tool === "multi_sell") return { result: { items_sold: 10, credits_after: 15000 } };
          if (tool === "refuel") return { result: { fuel: 100 } };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station", current_poi: "sol_station", credits: 10000 } },
      );

      const result = await craftAndSellRoutine.run(ctx, { recipes: ["refine_steel"] });
      expect(result.status).toBe("completed");
      expect(result.data.items_crafted).toEqual(["refine_steel"]);
      expect(result.data.items_sold).toBe(10);
      expect(result.data.credits_earned).toBe(5000);
      expect(toolsCalled).toContain("craft");
      expect(toolsCalled).toContain("analyze_market");
      expect(toolsCalled).toContain("multi_sell");
      expect(toolsCalled).toContain("refuel");
      expect(toolsCalled).not.toContain("dock");
    });

    it("craft errors are ignored (no materials)", async () => {
      const craftAttempts: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "craft") {
            craftAttempts.push(args?.recipe_id as string);
            return { error: { code: "no_materials" } };
          }
          if (tool === "analyze_market") return { result: { demand: [] } };
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station", current_poi: "sol_station" } },
      );

      const result = await craftAndSellRoutine.run(ctx, { recipes: ["refine_steel", "basic_copper_processing"] });
      expect(result.status).toBe("completed");
      expect(result.data.items_crafted).toEqual([]);
      expect(craftAttempts).toEqual(["refine_steel", "basic_copper_processing"]);
    });

    it("hands off when not docked and no station provided", async () => {
      const ctx = mockContext(
        async () => ({ result: {} }),
        { player: { current_poi: "open_space" } },
      );

      const result = await craftAndSellRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("no station param");
    });

    it("docks and travels when not docked and station provided", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "travel_to") return { result: {} };
          if (tool === "dock") return { result: { docked: true } };
          if (tool === "craft") return { error: { code: "no_materials" } };
          if (tool === "analyze_market") return { result: {} };
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { current_poi: "other_place" } },
      );

      const result = await craftAndSellRoutine.run(ctx, { station: "sol_station" });
      expect(result.status).toBe("completed");
      expect(toolsCalled).toContain("travel_to");
      expect(toolsCalled).toContain("dock");
    });

    it("creates sell orders for items with no demand", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "craft") return { error: {} };
          if (tool === "analyze_market") return { result: { demand: [] } }; // no demand
          if (tool === "get_cargo") return { result: [{ item_id: "raw_ore", quantity: 20 }] };
          if (tool === "create_sell_order") return { result: { order_id: "123" } };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } },
      );

      const result = await craftAndSellRoutine.run(ctx, {});
      expect(result.status).toBe("completed");
      expect(toolsCalled).toContain("create_sell_order");
      expect(result.summary).toContain("sell orders created");
    });

    it("skips refuel when refuel=false", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "craft") return { error: {} };
          if (tool === "analyze_market") return { result: {} };
          if (tool === "get_cargo") return { result: [] };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } },
      );

      await craftAndSellRoutine.run(ctx, { refuel: false });
      expect(toolsCalled).not.toContain("refuel");
    });

    it("hands off when multi_sell fails and sell orders also fail", async () => {
      const ctx = mockContext(
        async (tool) => {
          if (tool === "craft") return { error: {} };
          if (tool === "analyze_market") return { result: { demand: [{ item_id: "steel_plate" }] } };
          if (tool === "get_cargo") return { result: [{ item_id: "steel_plate", quantity: 5 }, { item_id: "raw_ore", quantity: 10 }] };
          if (tool === "multi_sell") return { result: { items_sold: 0, credits_after: 0 } };
          if (tool === "create_sell_order") return { error: { code: "order_failed" } };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } },
      );

      // items_sold=0, sell order for raw_ore fails → handoff
      const result = await craftAndSellRoutine.run(ctx, {});
      expect(result.status).toBe("handoff");
      expect(result.handoffReason).toContain("0 items sold");
    });

    it("uses default recipes when none specified", async () => {
      const crafted: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "craft") {
            crafted.push(args?.recipe_id as string);
            return { result: { crafted: 1 } };
          }
          if (tool === "analyze_market") return { result: {} };
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } },
      );

      await craftAndSellRoutine.run(ctx, {});
      expect(crafted).toEqual(DEFAULT_RECIPES);
      expect(DEFAULT_RECIPES).toEqual(["refine_steel", "basic_copper_processing"]);
    });

    it("sends recipe_id (not recipe) and an integer count (not quantity) to craft — regression for the silent no-op bug", async () => {
      // Live POST /craft accepts recipe_id (string) + count (integer); there is
      // no `recipe` param and "ALL" cannot coerce to an integer. gantry's OWN
      // declared schema (mcp-factory.ts craft: ["recipe_id", "count",
      // "deliver_to"]) names the param `count`, not `quantity` — this test
      // fails against both the old `{ recipe, count: "ALL" }` shape AND a
      // `{ recipe_id, quantity: 1 }` shape that drift detection can't see.
      const craftPayloads: Record<string, unknown>[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "craft") {
            craftPayloads.push(args ?? {});
            return { result: { crafted: 1 } };
          }
          if (tool === "analyze_market") return { result: {} };
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } },
      );

      await craftAndSellRoutine.run(ctx, { recipes: ["refine_steel"] });

      expect(craftPayloads).toHaveLength(1);
      const payload = craftPayloads[0];
      expect(payload).toEqual({ recipe_id: "refine_steel", count: 1 });
    });

    it("craft_count param: defaults to 1, and a custom value is sent as `count` for every recipe", async () => {
      const craftPayloads: Record<string, unknown>[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "craft") {
            craftPayloads.push(args ?? {});
            return { result: { crafted: 1 } };
          }
          if (tool === "analyze_market") return { result: {} };
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } },
      );

      await craftAndSellRoutine.run(ctx, { recipes: ["refine_steel", "basic_copper_processing"], craft_count: 7 });

      expect(craftPayloads).toEqual([
        { recipe_id: "refine_steel", count: 7 },
        { recipe_id: "basic_copper_processing", count: 7 },
      ]);
    });

    it("rejects a non-positive-integer craft_count", () => {
      expect(() => craftAndSellRoutine.parseParams({ craft_count: 0 })).toThrow("positive integer");
      expect(() => craftAndSellRoutine.parseParams({ craft_count: 1.5 })).toThrow("positive integer");
      expect(() => craftAndSellRoutine.parseParams({ craft_count: "3" })).toThrow("positive integer");
    });

    it("parses a valid craft_count", () => {
      const p = craftAndSellRoutine.parseParams({ craft_count: 5 });
      expect(p.craft_count).toBe(5);
    });

    it("waits a tick between craft calls but not after the last one", async () => {
      const callLog: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "craft") {
            callLog.push(`craft:${args?.recipe_id}`);
            return { result: { crafted: 1 } };
          }
          if (tool === "analyze_market") { callLog.push("analyze_market"); return { result: {} }; }
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } }, // already docked: no dock-phase waitForTick to confound the count
      );
      (ctx.client.waitForTick as any).mockImplementation(async () => { callLog.push("wait"); });

      await craftAndSellRoutine.run(ctx, { recipes: ["refine_steel", "basic_copper_processing"] });

      // Exactly one wait, sandwiched between the two craft calls — not before, not after.
      expect(callLog).toEqual(["craft:refine_steel", "wait", "craft:basic_copper_processing", "analyze_market"]);
      expect((ctx.client.waitForTick as any).mock.calls.length).toBe(1);
    });

    it("does not wait after craft when there is only one recipe", async () => {
      const callLog: string[] = [];
      const ctx = mockContext(
        async (tool, args) => {
          if (tool === "craft") { callLog.push(`craft:${args?.recipe_id}`); return { result: {} }; }
          if (tool === "analyze_market") { callLog.push("analyze_market"); return { result: {} }; }
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        { player: { docked_at_base: "sol_station" } },
      );
      (ctx.client.waitForTick as any).mockImplementation(async () => { callLog.push("wait"); });

      await craftAndSellRoutine.run(ctx, { recipes: ["refine_steel"] });

      expect(callLog).toEqual(["craft:refine_steel", "analyze_market"]);
    });

    it("sends deliver_to: storage only when deliver_to param is storage (mutation-verified branch)", async () => {
      const craftPayloads: Record<string, unknown>[] = [];
      const runWith = async (deliver_to?: "cargo" | "storage") => {
        craftPayloads.length = 0;
        const ctx = mockContext(
          async (tool, args) => {
            if (tool === "craft") { craftPayloads.push(args ?? {}); return { result: {} }; }
            if (tool === "analyze_market") return { result: {} };
            if (tool === "get_cargo") return { result: [] };
            if (tool === "refuel") return { result: {} };
            return { result: {} };
          },
          { player: { docked_at_base: "sol_station" } },
        );
        await craftAndSellRoutine.run(ctx, { recipes: ["refine_steel"], deliver_to });
      };

      await runWith("storage");
      expect(craftPayloads[0]).toEqual({ recipe_id: "refine_steel", count: 1, deliver_to: "storage" });

      await runWith("cargo");
      expect(craftPayloads[0]).toEqual({ recipe_id: "refine_steel", count: 1 });
      expect(craftPayloads[0]).not.toHaveProperty("deliver_to");

      await runWith(undefined);
      expect(craftPayloads[0]).not.toHaveProperty("deliver_to");
    });

    it("skips dock when already docked via already_docked error", async () => {
      const toolsCalled: string[] = [];
      const ctx = mockContext(
        async (tool) => {
          toolsCalled.push(tool);
          if (tool === "dock") return { error: { message: "already docked" } };
          if (tool === "craft") return { error: {} };
          if (tool === "analyze_market") return { result: {} };
          if (tool === "get_cargo") return { result: [] };
          if (tool === "refuel") return { result: {} };
          return { result: {} };
        },
        // not marked as docked in cache, but dock returns already_docked error
        { player: { current_poi: "sol_station" } },
      );

      const result = await craftAndSellRoutine.run(ctx, { station: "sol_station" });
      // should not handoff on already_docked
      expect(result.status).toBe("completed");
    });
  });
});
