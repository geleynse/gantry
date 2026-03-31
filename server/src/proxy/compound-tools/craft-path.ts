/**
 * compound-tools/craft-path.ts
 *
 * Implementation of the craft_path_to compound tool.
 * Traces the full crafting chain for a target item — from raw materials
 * to final product — with costs and source classification.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { getRecipesByOutput } from "../../services/recipe-registry.js";
import type { Recipe } from "../../services/recipe-registry.js";
import { classifyItemSource, isSelfSourceable } from "./item-source.js";

const log = createLogger("compound-tools");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InputSource = "market" | "craft" | "mine" | "salvage" | "harvest";

interface CraftStep {
  recipe_id: string;
  recipe_name: string;
  inputs: Array<{ item: string; qty: number; source: InputSource }>;
  output: { item: string; qty: number };
  step_cost: number;
}

interface RawMaterial {
  item: string;
  quantity: number;
  source: string;
}

interface CraftPathResult {
  target_item: string;
  path: CraftStep[];
  total_raw_materials: RawMaterial[];
  estimated_cost: number;
  estimated_revenue: number;
  estimated_profit: number;
}

interface MarketEntry {
  item_id?: string;
  id?: string;
  buy_price?: number;
  sell_price?: number;
  best_buy?: number;
  best_sell?: number;
  price?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPriceMap(
  marketResult: unknown,
): Map<string, { buy: number; sell: number }> {
  const out = new Map<string, { buy: number; sell: number }>();

  if (!marketResult || typeof marketResult !== "object") return out;

  const raw = marketResult as Record<string, unknown>;

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

    const buy = entry.buy_price ?? entry.best_buy ?? entry.price ?? 0;
    const sell = entry.sell_price ?? entry.best_sell ?? entry.price ?? 0;

    out.set(itemId, { buy: Number(buy), sell: Number(sell) });
  }

  return out;
}

/**
 * Recursively resolve the crafting path for an item.
 * Returns null if the item is not craftable (no registered recipe).
 * Accumulates steps in order (deepest dependencies first).
 *
 * visited guards against circular recipe references.
 */
function resolvePath(
  itemId: string,
  quantity: number,
  priceMap: Map<string, { buy: number; sell: number }>,
  steps: CraftStep[],
  rawMaterials: Map<string, { quantity: number; source: string }>,
  visited: Set<string>,
): boolean {
  if (visited.has(itemId)) {
    // Circular reference — treat as raw material
    accumulateRaw(itemId, quantity, priceMap, rawMaterials);
    return false;
  }

  const recipes = getRecipesByOutput(itemId);
  if (recipes.length === 0) {
    // Not craftable — raw material
    accumulateRaw(itemId, quantity, priceMap, rawMaterials);
    return false;
  }

  // Use the first recipe (recipes are ordered by DB insertion; pick simplest)
  const recipe = recipes[0];

  visited.add(itemId);

  const inputDetails: Array<{ item: string; qty: number; source: InputSource }> = [];
  let stepCost = 0;

  for (const inp of recipe.inputs) {
    const neededQty = inp.quantity * quantity;
    const isCraftable = getRecipesByOutput(inp.item_id).length > 0;

    if (isCraftable && !visited.has(inp.item_id)) {
      resolvePath(inp.item_id, neededQty, priceMap, steps, rawMaterials, visited);
      inputDetails.push({ item: inp.item_id, qty: neededQty, source: "craft" });
    } else {
      const src = isCraftable ? "craft" : (classifyItemSource(inp.item_id) as InputSource);
      accumulateRaw(inp.item_id, neededQty, priceMap, rawMaterials);
      inputDetails.push({ item: inp.item_id, qty: neededQty, source: src });

      // Cost of raw inputs (market buy price; self-sourceable = 0).
      // When src="craft" (circular reference — item already visited), we do NOT add market
      // cost here because the recursive call already costed it. Treat as zero-cost handoff.
      const prices = priceMap.get(inp.item_id);
      const marketBuyPrice = prices?.sell ?? 0;
      if (src !== "craft" && !isSelfSourceable(src as "mine" | "salvage" | "harvest" | "market")) {
        stepCost += marketBuyPrice * neededQty;
      }
    }
  }

  visited.delete(itemId);

  steps.push({
    recipe_id: recipe.id,
    recipe_name: recipe.id, // Recipe has no `name` field — use id
    inputs: inputDetails,
    output: { item: recipe.output_item_id, qty: recipe.output_quantity * quantity },
    step_cost: stepCost,
  });

  return true;
}

function accumulateRaw(
  itemId: string,
  quantity: number,
  priceMap: Map<string, { buy: number; sell: number }>,
  rawMaterials: Map<string, { quantity: number; source: string }>,
): void {
  const source = classifyItemSource(itemId);
  const existing = rawMaterials.get(itemId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    rawMaterials.set(itemId, { quantity, source });
  }
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Trace the full crafting chain for a target item.
 * Steps are ordered from raw material processing to final product.
 */
export async function craftPathTo(
  deps: CompoundToolDeps,
  args: { item_id: string },
): Promise<CompoundResult> {
  const { client, agentName } = deps;
  const { item_id } = args;

  if (!item_id || typeof item_id !== "string") {
    return { error: "item_id is required" };
  }

  log.info("craft_path_to START", { agent: agentName, item_id });

  // Check if the item is craftable at all
  const topRecipes = getRecipesByOutput(item_id);
  if (topRecipes.length === 0) {
    return {
      target_item: item_id,
      craftable: false,
      note: `No recipe found for ${item_id}. Item must be sourced from market, mining, or salvage.`,
    };
  }

  // Get market prices for cost estimation
  const marketResp = await client.execute("analyze_market");
  if (marketResp.error) {
    return { error: marketResp.error };
  }
  const priceMap = buildPriceMap(marketResp.result);

  // Resolve full crafting path
  const steps: CraftStep[] = [];
  const rawMaterialsMap = new Map<string, { quantity: number; source: string }>();
  const visited = new Set<string>();

  resolvePath(item_id, 1, priceMap, steps, rawMaterialsMap, visited);

  // Build raw materials list
  const total_raw_materials: RawMaterial[] = Array.from(rawMaterialsMap.entries()).map(
    ([item, { quantity, source }]) => ({ item, quantity, source }),
  );

  // Estimate total cost (sum of all step costs, i.e. market-sourced inputs only)
  const estimated_cost = steps.reduce((acc, s) => acc + s.step_cost, 0);

  // Estimate revenue from selling the final product (buy_price = what station pays us)
  const topRecipe = topRecipes[0];
  const outputPrices = priceMap.get(item_id);
  const estimated_revenue = (outputPrices?.buy ?? 0) * topRecipe.output_quantity;
  const estimated_profit = estimated_revenue - estimated_cost;

  const result: CraftPathResult = {
    target_item: item_id,
    path: steps,
    total_raw_materials,
    estimated_cost,
    estimated_revenue,
    estimated_profit,
  };

  log.info("craft_path_to DONE", {
    agent: agentName,
    item_id,
    steps: steps.length,
    raw_materials: total_raw_materials.length,
    estimated_profit,
  });

  return result as unknown as CompoundResult;
}
