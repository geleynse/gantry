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
import { buildPriceMap } from "./utils.js";

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
  const isV2 = typeof client.isV2 === "function" && client.isV2();
  const catalogResp = isV2
    ? await client.execute("spacemolt_catalog", { type: "recipes" })
    : await client.execute("catalog", { type: "recipes" });
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
  const marketResp = isV2
    ? await client.execute("spacemolt", { action: "analyze_market" })
    : await client.execute("analyze_market");
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
