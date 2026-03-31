/**
 * compound-tools/craft-profitability.ts
 *
 * Implementation of the get_craft_profitability compound tool.
 * Ranks craftable recipes by profit using current market prices.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { classifyItemSource, isSelfSourceable } from "./item-source.js";
import type { ItemSource } from "./item-source.js";

const log = createLogger("compound-tools");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RecipeInput {
  item_id: string;
  quantity: number;
}

interface RecipeEntry {
  id: string;
  name?: string;
  skill?: string;
  level_required?: number;
  inputs?: RecipeInput[];
  output?: { item_id: string; quantity: number };
  // Alternate field names from game catalog
  requires?: RecipeInput[];
  produces?: { item_id: string; quantity: number };
  skill_name?: string;
  skill_level?: number;
  recipe_id?: string;
}

interface MarketEntry {
  item_id?: string;
  id?: string;
  buy_price?: number;
  sell_price?: number;
  best_buy?: number;
  best_sell?: number;
  price?: number;
  demand?: number;
}

interface ProfitableRecipe {
  name: string;
  skill: string;
  level_required: number;
  inputs: Array<{
    item: string;
    qty: number;
    unit_cost: number;
    source: ItemSource;
    self_sourceable: boolean;
  }>;
  output: { item: string; qty: number; unit_price: number };
  profit: number;
  margin_pct: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract recipes from catalog result.
 */
function extractRecipes(catalogResult: unknown): RecipeEntry[] {
  if (!catalogResult || typeof catalogResult !== "object") return [];

  const raw = catalogResult as Record<string, unknown>;

  // May be { recipes: [...] } or { items: [...] } or direct array
  const list = Array.isArray(raw.recipes)
    ? raw.recipes
    : Array.isArray(raw.items)
      ? raw.items
      : Array.isArray(catalogResult)
        ? (catalogResult as unknown[])
        : [];

  return list as RecipeEntry[];
}

/**
 * Build a price map from analyze_market result: item_id -> { buy, sell }.
 * buy_price = what station pays us (sell to station)
 * sell_price = what station charges us (buy from station)
 */
function buildPriceMap(
  marketResult: unknown,
): Map<string, { buy: number; sell: number }> {
  const out = new Map<string, { buy: number; sell: number }>();

  if (!marketResult || typeof marketResult !== "object") return out;

  const raw = marketResult as Record<string, unknown>;

  // Market entries may be nested under `items`, `listings`, `market`, or direct array
  const list = Array.isArray(raw.items)
    ? raw.items
    : Array.isArray(raw.listings)
      ? raw.listings
      : Array.isArray(raw.market)
        ? raw.market
        : Array.isArray(marketResult)
          ? (marketResult as unknown[])
          : [];

  for (const entry of list as MarketEntry[]) {
    const itemId = String(entry.item_id ?? entry.id ?? "");
    if (!itemId) continue;

    // buy_price = station buys from us (what we receive when selling)
    // sell_price = station sells to us (what we pay when buying inputs)
    const buy =
      entry.buy_price ?? entry.best_buy ?? entry.price ?? 0;
    const sell =
      entry.sell_price ?? entry.best_sell ?? entry.price ?? 0;

    out.set(itemId, { buy: Number(buy), sell: Number(sell) });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Rank craftable recipes by profit using current market prices.
 * Queries catalog and analyze_market in sequence.
 */
export async function getCraftProfitability(
  deps: CompoundToolDeps,
  args: { limit?: number; skill_filter?: string },
): Promise<CompoundResult> {
  const { client, agentName, statusCache } = deps;
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const skillFilter = args.skill_filter?.toLowerCase();

  // Get current station from cache for the note
  const cached = statusCache.get(agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentStation = player?.current_poi as string | undefined;

  log.info("get_craft_profitability START", { agent: agentName, limit, skillFilter });

  // --- Step 1: Get available recipes from catalog ---
  const catalogResp = await client.execute("catalog", { type: "recipes" });
  if (catalogResp.error) {
    return { error: catalogResp.error };
  }
  const allRecipes = extractRecipes(catalogResp.result);

  if (allRecipes.length === 0) {
    return {
      recipes: [],
      station: currentStation ?? null,
      note: "No recipes found in catalog",
    };
  }

  // --- Step 2: Get market prices ---
  const marketResp = await client.execute("analyze_market");
  if (marketResp.error) {
    return { error: marketResp.error };
  }
  const priceMap = buildPriceMap(marketResp.result);

  // --- Step 3: Calculate profitability for each craftable recipe ---
  const profitable: ProfitableRecipe[] = [];

  for (const recipe of allRecipes) {
    // Filter by skill if requested
    const recipeSkill = recipe.skill ?? recipe.skill_name ?? "";
    if (skillFilter && !recipeSkill.toLowerCase().includes(skillFilter)) {
      continue;
    }

    // Normalize inputs/outputs
    const inputs: RecipeInput[] = recipe.inputs ?? recipe.requires ?? [];
    const outputRaw = recipe.output ?? recipe.produces;

    if (!outputRaw || inputs.length === 0) continue;

    const outputItemId = outputRaw.item_id;
    const outputQty = outputRaw.quantity ?? 1;

    // Get output sell price (what we receive when we sell the crafted item)
    const outputPrices = priceMap.get(outputItemId);
    if (!outputPrices || outputPrices.buy <= 0) {
      // No market for output — can't calculate profit
      continue;
    }
    const unitOutputSellPrice = outputPrices.buy;
    const totalOutputValue = unitOutputSellPrice * outputQty;

    // Calculate total input cost (what we pay to buy the ingredients)
    let totalInputCost = 0;
    let missingInput = false;
    const inputDetails: Array<{
      item: string;
      qty: number;
      unit_cost: number;
      source: ItemSource;
      self_sourceable: boolean;
    }> = [];

    for (const inp of inputs) {
      const inputPrices = priceMap.get(inp.item_id);
      if (!inputPrices || inputPrices.sell <= 0) {
        missingInput = true;
        break;
      }
      const unitCost = inputPrices.sell;
      totalInputCost += unitCost * inp.quantity;
      const source = classifyItemSource(inp.item_id);
      inputDetails.push({
        item: inp.item_id,
        qty: inp.quantity,
        unit_cost: unitCost,
        source,
        self_sourceable: isSelfSourceable(source),
      });
    }

    if (missingInput) continue;
    if (totalInputCost <= 0) continue;

    const profit = totalOutputValue - totalInputCost;
    const marginPct = Math.round((profit / totalInputCost) * 10000) / 100;

    profitable.push({
      name: recipe.name ?? recipe.id ?? recipe.recipe_id ?? "unknown",
      skill: recipeSkill,
      level_required: recipe.level_required ?? recipe.skill_level ?? 0,
      inputs: inputDetails,
      output: {
        item: outputItemId,
        qty: outputQty,
        unit_price: unitOutputSellPrice,
      },
      profit,
      margin_pct: marginPct,
    });
  }

  // --- Step 4: Sort by profit descending, return top N ---
  profitable.sort((a, b) => b.profit - a.profit);
  const topN = profitable.slice(0, limit);

  log.info("get_craft_profitability DONE", {
    agent: agentName,
    total_craftable: profitable.length,
    returned: topN.length,
  });

  return {
    recipes: topN,
    station: currentStation ?? null,
    note: "Prices reflect current station market only",
  };
}
