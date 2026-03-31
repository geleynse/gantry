/**
 * craft-path.test.ts
 *
 * Tests for the craft_path_to compound tool.
 * Uses an in-memory SQLite database seeded with test recipes.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import { registerRecipe } from "../../services/recipe-registry.js";
import { craftPathTo } from "./craft-path.js";
import type { CompoundToolDeps, GameClientLike, BattleStateForCache } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResponses = Record<string, { result?: unknown; error?: unknown }>;

function makeClient(responses: ToolResponses = {}): GameClientLike {
  return {
    execute: async (tool: string) => responses[tool] ?? { result: {} },
    waitForTick: async () => {},
    lastArrivalTick: null,
  };
}

function makeDeps(client: GameClientLike, agentName = "test-agent"): CompoundToolDeps {
  return {
    client,
    agentName,
    statusCache: new Map(),
    battleCache: new Map<string, BattleStateForCache | null>(),
    sellLog: new SellLog(),
    galaxyGraph: new GalaxyGraph(),
    persistBattleState: () => {},
    upsertNote: () => {},
  };
}

// ---------------------------------------------------------------------------
// Market fixture
// ---------------------------------------------------------------------------

const MARKET_RESULT = {
  items: [
    { item_id: "iron_ore",   buy_price: 10,  sell_price: 15 },
    { item_id: "carbon",     buy_price: 5,   sell_price: 8  },
    { item_id: "steel_plate",buy_price: 80,  sell_price: 90 },
    { item_id: "ship_engine",buy_price: 500, sell_price: 600 },
    { item_id: "copper_wire",buy_price: 12,  sell_price: 18 },
  ],
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  createDatabase(":memory:");
});

afterEach(() => {
  closeDb();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("craftPathTo", () => {
  it("returns not-craftable when no recipe exists", async () => {
    const client = makeClient({ analyze_market: { result: MARKET_RESULT } });
    const result = await craftPathTo(makeDeps(client), { item_id: "mystery_item" });

    expect(result.error).toBeUndefined();
    expect(result.craftable).toBe(false);
    expect(typeof result.note).toBe("string");
    expect((result.note as string).length).toBeGreaterThan(0);
  });

  it("returns error when item_id is missing", async () => {
    const client = makeClient();
    const result = await craftPathTo(makeDeps(client), { item_id: "" });

    expect(result.error).toBeDefined();
  });

  it("returns single-step path for a simple recipe", async () => {
    registerRecipe({
      id: "refine_steel",
      output_item_id: "steel_plate",
      output_quantity: 1,
      inputs: [
        { item_id: "iron_ore", quantity: 3 },
        { item_id: "carbon",   quantity: 1 },
      ],
    });

    const client = makeClient({ analyze_market: { result: MARKET_RESULT } });
    const result = await craftPathTo(makeDeps(client), { item_id: "steel_plate" });

    expect(result.error).toBeUndefined();
    expect(result.target_item).toBe("steel_plate");

    const path = result.path as Array<Record<string, unknown>>;
    expect(path).toHaveLength(1);
    expect(path[0].recipe_id).toBe("refine_steel");
    expect((path[0].output as Record<string, unknown>).item).toBe("steel_plate");
  });

  it("resolves a multi-step crafting chain", async () => {
    // steel_plate requires iron_ore + carbon
    registerRecipe({
      id: "refine_steel",
      output_item_id: "steel_plate",
      output_quantity: 1,
      inputs: [
        { item_id: "iron_ore", quantity: 3 },
        { item_id: "carbon",   quantity: 1 },
      ],
    });
    // ship_engine requires steel_plate (craftable) + copper_wire
    registerRecipe({
      id: "craft_engine",
      output_item_id: "ship_engine",
      output_quantity: 1,
      inputs: [
        { item_id: "steel_plate", quantity: 2 },
        { item_id: "copper_wire", quantity: 5 },
      ],
    });

    const client = makeClient({ analyze_market: { result: MARKET_RESULT } });
    const result = await craftPathTo(makeDeps(client), { item_id: "ship_engine" });

    expect(result.error).toBeUndefined();
    expect(result.target_item).toBe("ship_engine");

    const path = result.path as Array<Record<string, unknown>>;
    // Two steps: refine_steel first (dependency), then craft_engine
    expect(path.length).toBeGreaterThanOrEqual(2);

    // Final step should produce ship_engine
    const finalStep = path[path.length - 1];
    expect((finalStep.output as Record<string, unknown>).item).toBe("ship_engine");
  });

  it("includes correct total_raw_materials", async () => {
    registerRecipe({
      id: "refine_steel",
      output_item_id: "steel_plate",
      output_quantity: 1,
      inputs: [
        { item_id: "iron_ore", quantity: 3 },
        { item_id: "carbon",   quantity: 1 },
      ],
    });

    const client = makeClient({ analyze_market: { result: MARKET_RESULT } });
    const result = await craftPathTo(makeDeps(client), { item_id: "steel_plate" });

    const mats = result.total_raw_materials as Array<Record<string, unknown>>;
    expect(Array.isArray(mats)).toBe(true);

    const ironEntry = mats.find((m) => m.item === "iron_ore");
    const carbonEntry = mats.find((m) => m.item === "carbon");

    expect(ironEntry).toBeDefined();
    expect(ironEntry!.quantity).toBe(3);
    expect(carbonEntry).toBeDefined();
    expect(carbonEntry!.quantity).toBe(1);
  });

  it("classifies raw material sources correctly", async () => {
    registerRecipe({
      id: "refine_steel",
      output_item_id: "steel_plate",
      output_quantity: 1,
      inputs: [
        { item_id: "iron_ore", quantity: 3 }, // → mine
        { item_id: "carbon",   quantity: 1 }, // → market
      ],
    });

    const client = makeClient({ analyze_market: { result: MARKET_RESULT } });
    const result = await craftPathTo(makeDeps(client), { item_id: "steel_plate" });

    const mats = result.total_raw_materials as Array<Record<string, unknown>>;
    const ironEntry = mats.find((m) => m.item === "iron_ore");
    const carbonEntry = mats.find((m) => m.item === "carbon");

    expect(ironEntry!.source).toBe("mine");
    expect(carbonEntry!.source).toBe("market");
  });

  it("returns estimated_cost, estimated_revenue, estimated_profit", async () => {
    registerRecipe({
      id: "refine_steel",
      output_item_id: "steel_plate",
      output_quantity: 1,
      inputs: [
        { item_id: "iron_ore", quantity: 3 },
        { item_id: "carbon",   quantity: 1 },
      ],
    });

    const client = makeClient({ analyze_market: { result: MARKET_RESULT } });
    const result = await craftPathTo(makeDeps(client), { item_id: "steel_plate" });

    expect(typeof result.estimated_cost).toBe("number");
    expect(typeof result.estimated_revenue).toBe("number");
    expect(typeof result.estimated_profit).toBe("number");

    // iron_ore cost = 0 (mine, self-sourceable); carbon = 1*8 = 8 (market)
    // revenue = steel_plate buy_price * output_qty = 80 * 1 = 80
    // profit = 80 - 8 = 72
    expect(result.estimated_revenue).toBe(80);
  });

  it("returns error when analyze_market fails", async () => {
    registerRecipe({
      id: "refine_steel",
      output_item_id: "steel_plate",
      output_quantity: 1,
      inputs: [{ item_id: "iron_ore", quantity: 3 }],
    });

    const client = makeClient({
      analyze_market: { error: { message: "not docked" } },
    });
    const result = await craftPathTo(makeDeps(client), { item_id: "steel_plate" });

    expect(result.error).toBeDefined();
  });

  it("handles circular recipe references without infinite loop", async () => {
    // A → B, B → A: circular
    registerRecipe({
      id: "a_from_b",
      output_item_id: "item_a",
      output_quantity: 1,
      inputs: [{ item_id: "item_b", quantity: 1 }],
    });
    registerRecipe({
      id: "b_from_a",
      output_item_id: "item_b",
      output_quantity: 1,
      inputs: [{ item_id: "item_a", quantity: 1 }],
    });

    const client = makeClient({ analyze_market: { result: { items: [] } } });
    // Should not hang — circular ref is broken by the visited guard
    const result = await craftPathTo(makeDeps(client), { item_id: "item_a" });
    expect(result).toBeDefined();
  });
});
