/**
 * crafting-profit.ts
 *
 * BOM-based crafting chain analyzer for trader/miner agents.
 * Loads vendored recipe data at startup and ranks crafting paths by profit
 * margin given current (or cached) market prices.
 *
 * Source data: data/vendor/spacemolt-crafting-bom.json
 * License: MIT (Robert Sneddon / rsned/spacemolt-crafting-server)
 *
 * Use case: rust-vane and cinder-wake can call this before mining low-value
 * ore to discover whether a profitable crafting chain exists.
 */

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createLogger } from '../lib/logger.js';
import { getAllRecipes, type Recipe as DbRecipe } from './recipe-registry.js';

const log = createLogger('crafting-profit');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BomInput {
  item_id: string;
  qty: number;
}

export interface BomRecipe {
  id: string;
  name: string;
  output_item_id: string;
  output_qty: number;
  ticks: number;
  skills: string[];
  inputs: BomInput[];
}

export interface BomFile {
  _meta: Record<string, string>;
  recipes: BomRecipe[];
}

export interface PricePoint {
  bid: number;  // what station pays us (we sell to station)
  ask: number;  // what station charges us (we buy from station)
}

export interface CraftChain {
  recipe_id: string;
  recipe_name: string;
  ingredient: string;         // primary input item_id that prompted this result
  output_item_id: string;
  output_qty: number;
  ticks: number;
  skills: string[];
  inputs: Array<{
    item_id: string;
    qty: number;
    unit_cost: number;       // ask price per unit (what we pay)
    total_cost: number;
  }>;
  total_input_cost: number;
  output_unit_price: number; // bid price per unit (what we receive)
  total_output_value: number;
  profit: number;
  profit_per_tick: number;
  margin_pct: number;
  data_quality: 'live' | 'stale' | 'partial';
}

// ---------------------------------------------------------------------------
// BOM loader — loaded once at module init
// ---------------------------------------------------------------------------

let _recipes: BomRecipe[] | null = null;

function getBomPath(): string {
  const candidates = [
    join(process.cwd(), 'data', 'vendor', 'spacemolt-crafting-bom.json'),
    join(process.cwd(), 'server', 'data', 'vendor', 'spacemolt-crafting-bom.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error('spacemolt-crafting-bom.json not found. Checked: ' + candidates.join(', '));
}

export function loadBom(customPath?: string): BomRecipe[] {
  const path = customPath ?? getBomPath();
  const raw = readFileSync(path, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to parse BOM JSON at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('BOM JSON must be an object');
  }

  const bom = parsed as BomFile;
  if (!Array.isArray(bom.recipes)) {
    throw new Error('BOM JSON missing "recipes" array');
  }

  _recipes = bom.recipes;
  log.info(`Loaded ${_recipes.length} BOM recipes`);
  return _recipes;
}

export function getRecipes(): BomRecipe[] {
  if (!_recipes) {
    try {
      return loadBom();
    } catch (e) {
      log.warn('Could not load BOM', { error: e });
      return [];
    }
  }
  return _recipes;
}

/**
 * Approximate game ticks from a recipe's `time_seconds`. A tick is ~30s; we
 * floor at 1 so `profit_per_tick` never divides by zero. Returns 0 when no
 * time data is available (callers treat ticks=0 as instant/onboard crafts).
 */
function ticksFromSeconds(timeSeconds: number | undefined): number {
  if (!timeSeconds || timeSeconds <= 0) return 0;
  return Math.max(1, Math.round(timeSeconds / 30));
}

/** Map a game-catalog DB recipe (recipe-registry) onto the flat BomRecipe shape. */
function dbRecipeToBom(recipe: DbRecipe): BomRecipe {
  return {
    id: recipe.id,
    name: recipe.id, // DB recipes have no human label
    output_item_id: recipe.output_item_id,
    output_qty: recipe.output_quantity > 0 ? recipe.output_quantity : 1,
    ticks: ticksFromSeconds(recipe.time_seconds),
    skills: (recipe.skills ?? []).map((s) => `${s.skill_id} ${s.level}`),
    inputs: (recipe.inputs ?? []).map((i) => ({ item_id: i.item_id, qty: i.quantity })),
  };
}

/**
 * Recipes the fleet has discovered in the live game catalog (the `game_recipes`
 * SQLite table populated by discovery-service / game-catalog), mapped onto the
 * BomRecipe shape and tagged so callers know they're DB-sourced (lower quality
 * than the hand-verified vendored BOM). Returns [] if the DB is unavailable.
 *
 * Recipe IDs already present in the vendored set are skipped — the vendored
 * recipe is authoritative for those.
 */
export function getDbRecipes(): BomRecipe[] {
  let dbRecipes: DbRecipe[];
  try {
    dbRecipes = getAllRecipes();
  } catch (e) {
    log.warn('Could not load game-catalog recipes', { error: e });
    return [];
  }
  if (dbRecipes.length === 0) return [];
  const vendoredIds = new Set(getRecipes().map((r) => r.id));
  return dbRecipes
    .filter((r) => !vendoredIds.has(r.id) && r.inputs && r.inputs.length > 0)
    .map(dbRecipeToBom);
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

/**
 * For a single recipe, calculate profit given the price map.
 * Returns null if any required price is missing.
 */
export function evaluateRecipe(
  recipe: BomRecipe,
  prices: Map<string, PricePoint>,
  quality: 'live' | 'stale' | 'partial' = 'live',
): CraftChain | null {
  const outputPrices = prices.get(recipe.output_item_id);
  if (!outputPrices || outputPrices.bid <= 0) return null;

  let totalInputCost = 0;
  const inputs: CraftChain['inputs'] = [];
  let allPriced = true;

  for (const inp of recipe.inputs) {
    const inPrices = prices.get(inp.item_id);
    if (!inPrices || inPrices.ask <= 0) {
      allPriced = false;
      break;
    }
    const unitCost = inPrices.ask;
    const total = unitCost * inp.qty;
    totalInputCost += total;
    inputs.push({ item_id: inp.item_id, qty: inp.qty, unit_cost: unitCost, total_cost: total });
  }

  if (!allPriced || totalInputCost <= 0) return null;

  const totalOutputValue = outputPrices.bid * recipe.output_qty;
  const profit = totalOutputValue - totalInputCost;
  const marginPct = Math.round((profit / totalInputCost) * 10000) / 100;
  const profitPerTick = recipe.ticks > 0 ? Math.round(profit / recipe.ticks) : profit;

  // Primary ingredient = the first input (most significant contributor by convention)
  const ingredient = recipe.inputs[0]?.item_id ?? recipe.id;

  return {
    recipe_id: recipe.id,
    recipe_name: recipe.name,
    ingredient,
    output_item_id: recipe.output_item_id,
    output_qty: recipe.output_qty,
    ticks: recipe.ticks,
    skills: recipe.skills,
    inputs,
    total_input_cost: totalInputCost,
    output_unit_price: outputPrices.bid,
    total_output_value: totalOutputValue,
    profit,
    profit_per_tick: profitPerTick,
    margin_pct: marginPct,
    data_quality: quality,
  };
}

/**
 * Find all profitable crafting chains, optionally filtered by ingredient or output target.
 *
 * Searches the vendored BOM first; then falls back to recipes the fleet has
 * discovered in the live game catalog (`game_recipes` table), which cover
 * multi-step / component chains the 20-recipe vendored set doesn't. DB-sourced
 * chains are tagged `data_quality: 'partial'` so callers can flag them as
 * less-trusted. Pass `includeDbRecipes: false` to restrict to the vendored set.
 *
 * @param ingredient  item_id to filter by (e.g. "iron_ore"). Matches any input.
 * @param prices      Current price map (bid/ask per item_id).
 * @param target      Optional output item_id filter.
 * @param opts        Optional behavior flags.
 * @returns Ranked crafting paths sorted by profit descending.
 */
export function findCraftChains(
  ingredient: string | undefined,
  prices: Map<string, PricePoint>,
  target?: string,
  opts?: { includeDbRecipes?: boolean },
): CraftChain[] {
  const includeDb = opts?.includeDbRecipes ?? true;
  const sources: Array<{ recipes: BomRecipe[]; quality: 'live' | 'partial' }> = [
    { recipes: getRecipes(), quality: 'live' },
  ];
  if (includeDb) {
    const dbRecipes = getDbRecipes();
    if (dbRecipes.length > 0) sources.push({ recipes: dbRecipes, quality: 'partial' });
  }

  const results: CraftChain[] = [];
  const seenRecipeIds = new Set<string>();

  for (const { recipes, quality } of sources) {
    for (const recipe of recipes) {
      if (seenRecipeIds.has(recipe.id)) continue;

      // Filter by ingredient if specified
      if (ingredient) {
        const hasIngredient = recipe.inputs.some((inp) => inp.item_id === ingredient);
        if (!hasIngredient) continue;
      }

      // Filter by target output if specified
      if (target && recipe.output_item_id !== target) continue;

      const chain = evaluateRecipe(recipe, prices, quality);
      if (!chain) continue;

      // Only return profitable chains (positive margin)
      if (chain.profit <= 0) continue;

      seenRecipeIds.add(recipe.id);
      results.push(chain);
    }
  }

  // Sort by profit descending
  results.sort((a, b) => b.profit - a.profit);
  return results;
}

/**
 * Find all chains regardless of profitability — useful for planning even if
 * market data is partially missing.
 */
export function findAllChains(
  ingredient: string | undefined,
  prices: Map<string, PricePoint>,
): { profitable: CraftChain[]; unpriceable: string[] } {
  const recipes = getRecipes();
  const profitable: CraftChain[] = [];
  const unpriceable: string[] = [];

  const filtered = ingredient
    ? recipes.filter((r) => r.inputs.some((inp) => inp.item_id === ingredient))
    : recipes;

  for (const recipe of filtered) {
    const chain = evaluateRecipe(recipe, prices);
    if (chain) {
      if (chain.profit > 0) profitable.push(chain);
    } else {
      unpriceable.push(recipe.id);
    }
  }

  profitable.sort((a, b) => b.profit - a.profit);
  return { profitable, unpriceable };
}
