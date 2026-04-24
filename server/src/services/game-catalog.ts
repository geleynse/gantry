/**
 * game-catalog.ts — Fetch and cache game item/recipe/ship catalog data.
 *
 * Fetches from the game API on first call or when the file cache is stale
 * (> 24 hours). Persists to FLEET_DIR/data/catalog.json for offline use.
 * Also populates the game_items and game_recipes DB tables so agents can
 * cross-reference via the query_catalog MCP tool.
 *
 * Usage:
 *   await fetchAndCacheCatalog(gameApiUrl, fleetDir);  // startup
 *   const catalog = getCatalog();                       // synchronous read
 *   const item = getItem("iron_ore");
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createLogger } from "../lib/logger.js";
import { registerItem } from "./game-item-registry.js";
import { registerRecipe } from "./recipe-registry.js";
import type { GameItem } from "./game-item-registry.js";
import type { Recipe } from "./recipe-registry.js";

const log = createLogger("game-catalog");

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipSpec {
  id: string;
  name: string;
  class?: string;
  hull?: number;
  fuel_capacity?: number;
  cargo_capacity?: number;
  speed?: number;
  price?: number;
  description?: string;
}

export interface CatalogData {
  items: GameItem[];
  recipes: Recipe[];
  ships: ShipSpec[];
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Module-level in-memory cache
// ---------------------------------------------------------------------------

let _catalog: CatalogData | null = null;

// ---------------------------------------------------------------------------
// File cache path helper
// ---------------------------------------------------------------------------

function catalogPath(fleetDir: string): string {
  return join(fleetDir, "data", "catalog.json");
}

function isCacheStale(catalog: CatalogData): boolean {
  const fetchedAt = new Date(catalog.fetched_at).getTime();
  return Date.now() - fetchedAt > CACHE_TTL_MS;
}

// ---------------------------------------------------------------------------
// Fetchers — individual game API endpoint calls
// ---------------------------------------------------------------------------

async function fetchItems(gameApiUrl: string): Promise<GameItem[]> {
  const url = `${gameApiUrl}/items`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) {
    log.warn(`items API returned ${resp.status}`, { url });
    return [];
  }
  const data = await resp.json() as unknown;
  if (Array.isArray(data)) return data as GameItem[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as GameItem[];
    if (Array.isArray(obj.data)) return obj.data as GameItem[];
  }
  return [];
}

async function fetchRecipes(gameApiUrl: string): Promise<Recipe[]> {
  const url = `${gameApiUrl}/recipes`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) {
    log.warn(`recipes API returned ${resp.status}`, { url });
    return [];
  }
  const data = await resp.json() as unknown;
  if (Array.isArray(data)) return data as Recipe[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.recipes)) return obj.recipes as Recipe[];
    if (Array.isArray(obj.data)) return obj.data as Recipe[];
  }
  return [];
}

async function fetchShips(gameApiUrl: string): Promise<ShipSpec[]> {
  const url = `${gameApiUrl}/ships`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) {
    log.warn(`ships API returned ${resp.status}`, { url });
    return [];
  }
  const data = await resp.json() as unknown;
  if (Array.isArray(data)) return data as ShipSpec[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.ships)) return obj.ships as ShipSpec[];
    if (Array.isArray(obj.data)) return obj.data as ShipSpec[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// DB population helpers
// ---------------------------------------------------------------------------

function persistToDB(catalog: CatalogData): void {
  let itemsOk = 0;
  let recipesOk = 0;

  for (const item of catalog.items) {
    try {
      if (item.id && item.name) {
        registerItem(item);
        itemsOk++;
      }
    } catch {
      // non-fatal — registry logs its own errors
    }
  }

  for (const recipe of catalog.recipes) {
    try {
      if (recipe.id && recipe.output_item_id) {
        registerRecipe(recipe);
        recipesOk++;
      }
    } catch {
      // non-fatal
    }
  }

  if (itemsOk > 0 || recipesOk > 0) {
    log.info("Catalog persisted to DB", { items: itemsOk, recipes: recipesOk });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch catalog from the game API and cache to disk + DB.
 * Non-blocking — designed to be called from server startup with .catch().
 *
 * @param gameApiUrl  e.g. "https://game.spacemolt.com/api/v1"
 * @param fleetDir    e.g. process.env.FLEET_DIR or FLEET_DIR constant
 */
export async function fetchAndCacheCatalog(
  gameApiUrl: string,
  fleetDir: string,
): Promise<CatalogData | null> {
  // Check file cache first
  const cachePath = catalogPath(fleetDir);
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as CatalogData;
      if (!isCacheStale(cached)) {
        log.info("Catalog loaded from file cache", {
          items: cached.items.length,
          recipes: cached.recipes.length,
          ships: cached.ships.length,
          fetched_at: cached.fetched_at,
        });
        _catalog = cached;
        // Still populate DB in case it's a fresh deployment with empty tables
        persistToDB(cached);
        return cached;
      }
      log.info("Catalog file cache stale, refreshing from game API");
    } catch (e) {
      log.warn("Failed to read catalog file cache, fetching fresh", { error: String(e) });
    }
  }

  // Fetch from game API — all three endpoints in parallel
  log.info("Fetching catalog from game API", { base: gameApiUrl });
  const [items, recipes, ships] = await Promise.allSettled([
    fetchItems(gameApiUrl),
    fetchRecipes(gameApiUrl),
    fetchShips(gameApiUrl),
  ]);

  const catalog: CatalogData = {
    items: items.status === "fulfilled" ? items.value : [],
    recipes: recipes.status === "fulfilled" ? recipes.value : [],
    ships: ships.status === "fulfilled" ? ships.value : [],
    fetched_at: new Date().toISOString(),
  };

  log.info("Catalog fetched", {
    items: catalog.items.length,
    recipes: catalog.recipes.length,
    ships: catalog.ships.length,
  });

  // Write file cache
  try {
    mkdirSync(join(fleetDir, "data"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(catalog, null, 2));
    log.info("Catalog written to file cache", { path: cachePath });
  } catch (e) {
    log.warn("Failed to write catalog file cache (non-fatal)", { error: String(e) });
  }

  // Persist to DB
  persistToDB(catalog);

  _catalog = catalog;
  return catalog;
}

/**
 * Synchronously read the in-memory catalog.
 * Returns null if fetchAndCacheCatalog has never been called or failed.
 */
export function getCatalog(): CatalogData | null {
  return _catalog;
}

/**
 * Set the catalog directly for unit tests.
 */
export function setCatalogForTesting(catalog: CatalogData | null): void {
  _catalog = catalog;
}

/**
 * Look up a specific item by ID.
 */
export function getItem(id: string): GameItem | undefined {
  return _catalog?.items.find((i) => i.id === id);
}

/**
 * Look up a specific recipe by ID.
 */
export function getRecipe(id: string): Recipe | undefined {
  return _catalog?.recipes.find((r) => r.id === id);
}

/**
 * Look up a specific ship by ID.
 */
export function getShip(id: string): ShipSpec | undefined {
  return _catalog?.ships.find((s) => s.id === id);
}

/**
 * Search catalog entries by name or category.
 * Returns up to limit results across the requested type.
 */
export function searchCatalog(
  type: "item" | "recipe" | "ship" | "all",
  search?: string,
  id?: string,
  limit = 50,
): { items: GameItem[]; recipes: Recipe[]; ships: ShipSpec[] } {
  const catalog = _catalog;
  const empty = { items: [] as GameItem[], recipes: [] as Recipe[], ships: [] as ShipSpec[] };
  if (!catalog) return empty;

  const needle = search?.toLowerCase();

  function matchItem(item: GameItem): boolean {
    if (id) return item.id === id;
    if (!needle) return true;
    return item.id.toLowerCase().includes(needle) || item.name.toLowerCase().includes(needle) || (item.type ?? "").toLowerCase().includes(needle);
  }

  function matchRecipe(recipe: Recipe): boolean {
    if (id) return recipe.id === id;
    if (!needle) return true;
    return recipe.id.toLowerCase().includes(needle) || recipe.output_item_id.toLowerCase().includes(needle);
  }

  function matchShip(ship: ShipSpec): boolean {
    if (id) return ship.id === id;
    if (!needle) return true;
    return ship.id.toLowerCase().includes(needle) || ship.name.toLowerCase().includes(needle) || (ship.class ?? "").toLowerCase().includes(needle);
  }

  const result: { items: GameItem[]; recipes: Recipe[]; ships: ShipSpec[] } = { items: [], recipes: [], ships: [] };

  if (type === "item" || type === "all") {
    result.items = catalog.items.filter(matchItem).slice(0, limit);
  }
  if (type === "recipe" || type === "all") {
    result.recipes = catalog.recipes.filter(matchRecipe).slice(0, limit);
  }
  if (type === "ship" || type === "all") {
    result.ships = catalog.ships.filter(matchShip).slice(0, limit);
  }

  return result;
}
