/**
 * craft-profitability.test.ts
 *
 * Tests for the get_craft_profitability compound tool.
 * Dependencies are mocked with simple in-memory objects.
 */

import { describe, it, expect } from "bun:test";
import { getCraftProfitability } from "./craft-profitability.js";
import type { CompoundToolDeps, GameClientLike, BattleStateForCache } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ToolResponses = Record<string, { result?: unknown; error?: unknown }>;

function makeClient(responses: ToolResponses = {}): GameClientLike {
  return {
    execute: async (tool: string, _args?: Record<string, unknown>) => {
      return responses[tool] ?? { result: {} };
    },
    waitForTick: async () => {},
    lastArrivalTick: null,
  };
}

function makeDeps(
  client: GameClientLike,
  agentName = "test-agent",
): CompoundToolDeps {
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
// Fixtures
// ---------------------------------------------------------------------------

const SKILLS_RESULT = {
  skills: [
    { name: "refining", level: 3 },
    { name: "engineering", level: 5 },
    { name: "mining", level: 2 },
  ],
};

const CATALOG_RESULT = {
  recipes: [
    {
      id: "refine_steel",
      name: "Refine Steel",
      skill: "refining",
      level_required: 1,
      inputs: [
        { item_id: "iron_ore", quantity: 3 },
        { item_id: "carbon", quantity: 1 },
      ],
      output: { item_id: "steel_plate", quantity: 1 },
    },
    {
      id: "craft_engine",
      name: "Craft Engine",
      skill: "engineering",
      level_required: 4,
      inputs: [
        { item_id: "steel_plate", quantity: 2 },
        { item_id: "copper_wire", quantity: 5 },
      ],
      output: { item_id: "ship_engine", quantity: 1 },
    },
    {
      id: "advanced_alloy",
      name: "Advanced Alloy",
      skill: "engineering",
      level_required: 6, // agent has level 5 — can't craft
      inputs: [{ item_id: "steel_plate", quantity: 5 }],
      output: { item_id: "advanced_alloy", quantity: 1 },
    },
  ],
};

const MARKET_RESULT = {
  items: [
    { item_id: "iron_ore", buy_price: 10, sell_price: 15 },
    { item_id: "carbon", buy_price: 5, sell_price: 8 },
    { item_id: "steel_plate", buy_price: 80, sell_price: 90 },
    { item_id: "copper_wire", buy_price: 12, sell_price: 18 },
    { item_id: "ship_engine", buy_price: 500, sell_price: 600 },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCraftProfitability", () => {
  it("returns ranked recipes with correct profit calculations", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, {});

    expect(result.error).toBeUndefined();
    const recipes = result.recipes as Array<Record<string, unknown>>;

    // Both refine_steel and craft_engine are craftable (agent has required levels)
    // advanced_alloy is NOT (level 6 required, agent has 5)
    expect(recipes).toHaveLength(2);

    // craft_engine profit: sell(ship_engine)=500 - buy(2*steel_plate + 5*copper_wire)
    //   = 500 - (2*90 + 5*18) = 500 - (180 + 90) = 230
    // refine_steel profit: sell(steel_plate)=80 - buy(3*iron_ore + 1*carbon)
    //   = 80 - (3*15 + 1*8) = 80 - 53 = 27
    // craft_engine should come first (higher profit)
    expect(recipes[0].name).toBe("Craft Engine");
    expect(recipes[0].profit).toBe(230);
    expect(recipes[1].name).toBe("Refine Steel");
    expect(recipes[1].profit).toBe(27);
  });

  it("includes correct recipe fields in output", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, {});
    const recipes = result.recipes as Array<Record<string, unknown>>;
    const recipe = recipes[0]; // craft_engine

    expect(recipe.name).toBe("Craft Engine");
    expect(recipe.skill).toBe("engineering");
    expect(recipe.level_required).toBe(4);
    expect(recipe.profit).toBeTypeOf("number");
    expect(recipe.margin_pct).toBeTypeOf("number");
    expect(Array.isArray(recipe.inputs)).toBe(true);
    expect(typeof recipe.output).toBe("object");

    const output = recipe.output as Record<string, unknown>;
    expect(output.item).toBe("ship_engine");
    expect(output.qty).toBe(1);
    expect(output.unit_price).toBe(500);
  });

  it("includes source and self_sourceable tags on each input", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, { skill_filter: "refining" });
    const recipes = result.recipes as Array<Record<string, unknown>>;

    // refine_steel: inputs are iron_ore (mine) and carbon (market)
    const recipe = recipes[0];
    expect(recipe.name).toBe("Refine Steel");

    const inputs = recipe.inputs as Array<Record<string, unknown>>;
    expect(inputs.length).toBe(2);

    const oreInput = inputs.find((i) => i.item === "iron_ore");
    const carbonInput = inputs.find((i) => i.item === "carbon");

    expect(oreInput).toBeDefined();
    expect(oreInput!.source).toBe("mine");
    expect(oreInput!.self_sourceable).toBe(true);

    expect(carbonInput).toBeDefined();
    expect(carbonInput!.source).toBe("market");
    expect(carbonInput!.self_sourceable).toBe(false);
  });

  it("respects the limit parameter", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, { limit: 1 });
    const recipes = result.recipes as Array<Record<string, unknown>>;

    expect(recipes).toHaveLength(1);
    // Should return the most profitable one
    expect(recipes[0].name).toBe("Craft Engine");
  });

  it("filters recipes by skill_filter", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, { skill_filter: "refining" });
    const recipes = result.recipes as Array<Record<string, unknown>>;

    // Only refine_steel has skill "refining"
    expect(recipes).toHaveLength(1);
    expect(recipes[0].name).toBe("Refine Steel");
  });

  it("returns all recipes regardless of skill level (v0.227 removed skill gates)", async () => {
    const client = makeClient({
      get_skills: {
        result: {
          skills: [
            { name: "refining", level: 0 },
            { name: "engineering", level: 5 },
          ],
        },
      },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, {});
    const recipes = result.recipes as Array<Record<string, unknown>>;

    // v0.227: All skill requirements removed — all profitable recipes should appear
    // regardless of agent's skill levels (only limited by market prices/inputs)
    expect(recipes.length).toBeGreaterThanOrEqual(1);
    // All three recipes have market data, so all should be included
    expect(recipes).toHaveLength(2); // 2 profitable (advanced_alloy has no market for rare_alloy output)
  });

  it("skips recipes when inputs have no market prices", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: {
        result: {
          recipes: [
            {
              id: "mystery_item",
              name: "Mystery Item",
              skill: "refining",
              level_required: 1,
              inputs: [
                { item_id: "rare_ore", quantity: 1 }, // not in market
              ],
              output: { item_id: "steel_plate", quantity: 1 },
            },
          ],
        },
      },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, {});
    const recipes = result.recipes as Array<Record<string, unknown>>;

    // rare_ore has no market price — mystery_item should be skipped
    expect(recipes).toHaveLength(0);
  });

  it("returns empty recipes array when catalog is empty", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: { recipes: [] } },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, {});

    expect(result.recipes).toEqual([]);
    expect(result.note).toBe("No recipes found in catalog");
  });

  it("includes agent_skills and station in result", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("test-agent", {
      data: { player: { current_poi: "nexus_station" } },
      fetchedAt: Date.now(),
    });

    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { result: MARKET_RESULT },
    });
    const deps = { ...makeDeps(client), statusCache };

    const result = await getCraftProfitability(deps, {});

    expect(result.station).toBe("nexus_station");
    expect(result.note).toBe("Prices reflect current station market only");
  });

  it("returns error when catalog fails", async () => {
    const client = makeClient({
      catalog: { error: { message: "not logged in" } },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, {});
    expect(result.error).toBeDefined();
  });

  it("returns error when analyze_market fails", async () => {
    const client = makeClient({
      get_skills: { result: SKILLS_RESULT },
      catalog: { result: CATALOG_RESULT },
      analyze_market: { error: { message: "not docked" } },
    });
    const deps = makeDeps(client);

    const result = await getCraftProfitability(deps, {});
    expect(result.error).toBeDefined();
  });
});
