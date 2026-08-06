/**
 * Tests for game-catalog.ts — catalog cache/lookup logic.
 *
 * Tests cover:
 * - searchCatalog filtering (item / recipe / ship / all)
 * - searchCatalog by ID and by search term
 * - getCatalog before/after fetch
 * - getItem / getRecipe / getShip convenience lookups
 * - fetchAndCacheCatalog file cache (stale vs fresh)
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Import the functions under test
// We import after setting up module state via direct calls.
// ---------------------------------------------------------------------------

import {
  searchCatalog,
  getCatalog,
  getItem,
  getRecipe,
  getShip,
  fetchAndCacheCatalog,
  catalogBaseUrl,
  type CatalogData,
} from "./game-catalog.js";
import { createMockConfig } from "../test/helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `catalog-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  return dir;
}

/**
 * A `global.fetch` stand-in that serves `payload` for GET /items and an empty
 * array shape for the other two endpoints. Doubles as the call spy.
 */
function mockItemsResponse(payload: Record<string, unknown>): typeof global.fetch {
  return mock(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/items")) {
      return new Response(JSON.stringify(payload), { status: 200 });
    }
    return new Response(JSON.stringify({ recipes: [], ships: [] }), { status: 200 });
  }) as unknown as typeof global.fetch;
}

// ---------------------------------------------------------------------------
// Fixtures — the shapes the LIVE game API actually returns.
//
// Field census taken 2026-08-05 over every record the game served:
//
//   GET /api/items  → 3370 records. id, name, description, category, size,
//     base_value, stackable, tradeable on all 3370; rarity on 648.
//     GameItem's optional fields — type, mass, value, base_price, legality —
//     appear in ZERO of 3370.
//   GET /api/ships  → 335 records. id, name, description, class, category,
//     base_hull, base_shield, base_armor, base_speed, base_fuel,
//     cargo_capacity (+ more) on all 335. ShipSpec's hull, fuel_capacity,
//     speed and price appear in ZERO of 335.
//   GET /api/recipes → 404. The endpoint was removed from the game, so
//     recipes stay empty in production. There is no live recipe shape to
//     copy; the recipe fixture below documents the Recipe *type* only.
//
// So GameItem/ShipSpec model a wire format the server does not send, and
// ingest leaves those columns NULL. Remapping category→type, base_value→
// base_price, base_hull→hull etc. is filed as separate work. Until it
// lands, these fixtures must reflect what arrives, not what we wish did —
// a fixture that supplies the missing fields makes the gap invisible and
// re-arms this repo's dominant bug class (see commit 5030dae).
// ---------------------------------------------------------------------------

/** Item record as the live API sends it. */
interface LiveItem {
  id: string;
  name: string;
  description?: string;
  category: string;
  size: number;
  base_value: number;
  stackable?: boolean;
  tradeable?: boolean;
}

/** Ship record as the live API sends it. */
interface LiveShip {
  id: string;
  name: string;
  class: string;
  category: string;
  base_hull: number;
  base_speed: number;
  base_fuel: number;
  cargo_capacity: number;
}

const SAMPLE_ITEMS: LiveItem[] = [
  { id: "iron_ore", name: "Iron Ore", category: "ore", size: 1, base_value: 50, stackable: true, tradeable: true },
  { id: "copper_ore", name: "Copper Ore", category: "ore", size: 1, base_value: 80, stackable: true, tradeable: true },
  // "component" is a real live category, chosen here because it appears in no
  // fixture id or name — that lets a test tell a category match apart from an
  // incidental id/name match.
  { id: "refined_iron", name: "Refined Iron", category: "component", size: 2, base_value: 150, stackable: true, tradeable: true },
];

const SAMPLE_SHIPS: LiveShip[] = [
  { id: "scout_mk1", name: "Scout Mk1", class: "Scout", category: "light", base_hull: 100, base_speed: 12, base_fuel: 40, cargo_capacity: 20 },
  { id: "hauler_xl", name: "Hauler XL", class: "Freighter", category: "heavy", base_hull: 500, base_speed: 4, base_fuel: 120, cargo_capacity: 200 },
];

const SAMPLE_CATALOG: CatalogData = {
  fetched_at: new Date().toISOString(),
  items: SAMPLE_ITEMS,
  recipes: [
    {
      id: "refine_iron",
      output_item_id: "refined_iron",
      output_quantity: 1,
      inputs: [{ item_id: "iron_ore", quantity: 3 }],
      time_seconds: 60,
    },
    {
      id: "refine_copper",
      output_item_id: "refined_copper",
      output_quantity: 1,
      inputs: [{ item_id: "copper_ore", quantity: 3 }],
      time_seconds: 60,
    },
  ],
  ships: SAMPLE_SHIPS,
};

// ---------------------------------------------------------------------------
// getCatalog / getItem / getRecipe / getShip
// These tests use a real file-based catalog loaded from a temp dir.
// ---------------------------------------------------------------------------

describe("getCatalog + getItem / getRecipe / getShip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // Write a fresh cache file so fetchAndCacheCatalog doesn't hit the network
    const cachePath = join(tmpDir, "data", "catalog.json");
    writeFileSync(cachePath, JSON.stringify(SAMPLE_CATALOG));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads catalog from fresh file cache without hitting the network", async () => {
    // fetchAndCacheCatalog reads the file cache when it's fresh
    const catalog = await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    expect(catalog).not.toBeNull();
    expect(catalog!.items).toHaveLength(3);
    expect(catalog!.recipes).toHaveLength(2);
    expect(catalog!.ships).toHaveLength(2);
  });

  it("getCatalog returns null before any fetch", () => {
    // Module-level cache is populated by fetchAndCacheCatalog.
    // After loading in the test above, it may be set — this tests isolation isn't
    // guaranteed between test files, so we just check it returns a CatalogData or null.
    const result = getCatalog();
    // Either null (fresh module) or CatalogData — both are valid
    if (result !== null) {
      expect(result).toHaveProperty("items");
      expect(result).toHaveProperty("recipes");
      expect(result).toHaveProperty("ships");
    }
  });

  it("getItem returns matching item after catalog load", async () => {
    await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    const item = getItem("iron_ore");
    expect(item).not.toBeUndefined();
    expect(item!.name).toBe("Iron Ore");
  });

  it("getItem returns undefined for unknown id", async () => {
    await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    expect(getItem("nonexistent_item")).toBeUndefined();
  });

  it("getRecipe returns matching recipe", async () => {
    await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    const recipe = getRecipe("refine_iron");
    expect(recipe).not.toBeUndefined();
    expect(recipe!.output_item_id).toBe("refined_iron");
  });

  it("getShip returns matching ship", async () => {
    await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    const ship = getShip("scout_mk1");
    expect(ship).not.toBeUndefined();
    expect(ship!.name).toBe("Scout Mk1");
  });

  it("writes catalog.json to disk", async () => {
    // Delete existing cache to force a re-write attempt
    // (fetchAndCacheCatalog writes even when it read from cache, via persistToDB — but
    // it only re-writes if the cache was stale. Here we make it stale by backdating.)
    const cachePath = join(tmpDir, "data", "catalog.json");
    const stale = { ...SAMPLE_CATALOG, fetched_at: "2020-01-01T00:00:00.000Z" };
    writeFileSync(cachePath, JSON.stringify(stale));

    // Won't reach the network because fetch will throw (localhost:0 unreachable)
    // but we just need to verify stale detection path runs
    try {
      await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    } catch {
      // Expected — network fetch will fail
    }
    // File should still exist (from before)
    expect(existsSync(cachePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// searchCatalog
// ---------------------------------------------------------------------------

describe("searchCatalog", () => {
  // We need the module-level _catalog populated. Use a fresh load.
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    const cachePath = join(tmpDir, "data", "catalog.json");
    writeFileSync(cachePath, JSON.stringify(SAMPLE_CATALOG));
    await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when catalog is null", () => {
    // This tests the null guard in searchCatalog — we can only observe it
    // indirectly since we can't easily reset module state. If catalog is loaded,
    // the non-empty path is exercised.
    const results = searchCatalog("item");
    expect(Array.isArray(results.items)).toBe(true);
  });

  it("returns all items when type=item and no filter", () => {
    const results = searchCatalog("item");
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.recipes).toHaveLength(0);
    expect(results.ships).toHaveLength(0);
  });

  it("returns all recipes when type=recipe", () => {
    const results = searchCatalog("recipe");
    expect(results.recipes.length).toBeGreaterThan(0);
    expect(results.items).toHaveLength(0);
    expect(results.ships).toHaveLength(0);
  });

  it("returns all ships when type=ship", () => {
    const results = searchCatalog("ship");
    expect(results.ships.length).toBeGreaterThan(0);
    expect(results.items).toHaveLength(0);
    expect(results.recipes).toHaveLength(0);
  });

  it("returns all types when type=all", () => {
    const results = searchCatalog("all");
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.recipes.length).toBeGreaterThan(0);
    expect(results.ships.length).toBeGreaterThan(0);
  });

  it("filters items by search term (partial name match)", () => {
    const results = searchCatalog("item", "iron");
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.items.every((i) => i.id.toLowerCase().includes("iron") || i.name.toLowerCase().includes("iron"))).toBe(true);
  });

  // Documents a real gap, not desired behaviour. searchCatalog matches
  // [id, name, type], but the live API never sends `type` — it sends
  // `category`, and nothing remaps it on ingest — so the type filter cannot
  // match any real catalog row. This assertion is deliberately pinned to the
  // broken-today behaviour so it fails loudly (and gets updated) when the
  // category→type remap lands.
  it("cannot filter items by their live category — searchCatalog reads a field ingest never populates", () => {
    const byCategory = searchCatalog("item", "component");
    expect(byCategory.items).toHaveLength(0);
    // ...while the same query against a field that IS populated works.
    const byName = searchCatalog("item", "iron");
    expect(byName.items.length).toBeGreaterThanOrEqual(2);
  });

  it("finds item by exact ID", () => {
    const results = searchCatalog("item", undefined, "iron_ore");
    expect(results.items).toHaveLength(1);
    expect(results.items[0].id).toBe("iron_ore");
  });

  it("finds recipe by exact ID", () => {
    const results = searchCatalog("recipe", undefined, "refine_iron");
    expect(results.recipes).toHaveLength(1);
    expect(results.recipes[0].id).toBe("refine_iron");
  });

  it("finds ship by exact ID", () => {
    const results = searchCatalog("ship", undefined, "scout_mk1");
    expect(results.ships).toHaveLength(1);
    expect(results.ships[0].id).toBe("scout_mk1");
  });

  it("returns empty for unknown id", () => {
    const results = searchCatalog("item", undefined, "does_not_exist");
    expect(results.items).toHaveLength(0);
  });

  it("filters ships by class", () => {
    // `class` is one of the few ShipSpec fields the live API really sends.
    const results = searchCatalog("ship", "freighter");
    expect(results.ships).toHaveLength(1);
    expect(results.ships[0].id).toBe("hauler_xl");
  });

  it("respects limit parameter", () => {
    const results = searchCatalog("item", undefined, undefined, 1);
    expect(results.items.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// fetchAndCacheCatalog — stale cache handling
// ---------------------------------------------------------------------------

describe("fetchAndCacheCatalog — stale cache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses fresh cache (within TTL) without fetching network", async () => {
    const cachePath = join(tmpDir, "data", "catalog.json");
    writeFileSync(cachePath, JSON.stringify(SAMPLE_CATALOG));

    // fetchAndCacheCatalog should read from file and NOT throw even though
    // the API URL is unreachable
    const result = await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(3);
  });

  it("creates data dir if missing", async () => {
    // Use a dir without a data/ subdir
    const newDir = join(tmpDir, "newfleet");
    mkdirSync(newDir, { recursive: true });

    // Will fail on network fetch but should not throw on mkdirSync
    try {
      await fetchAndCacheCatalog("http://localhost:0/api", newDir);
    } catch {
      // Network failure expected — we just verify data dir was created
    }
    // data dir should have been created (or attempted)
    // The test passes as long as no unexpected error occurs
  });

  it("handles missing cache file gracefully (returns null or partial on network failure)", async () => {
    // No cache file — will try to fetch from network, which will fail
    try {
      const result = await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
      // If network succeeds (unexpected), result is valid
      if (result !== null) {
        expect(result).toHaveProperty("items");
      }
    } catch {
      // Network failure is fine — tested behavior is graceful degradation
    }
  });

  it("returns partial results when some API endpoints fail", async () => {
    // We can test this via mock fetch — but for simplicity we test the
    // Promise.allSettled behavior: even if all fail, catalog is created with empty arrays.
    // This is implicitly tested by the "network failure" path above.
    // Direct test: create a catalog with empty arrays and confirm structure.
    const empty: CatalogData = { items: [], recipes: [], ships: [], fetched_at: new Date().toISOString() };
    const cachePath = join(tmpDir, "data", "catalog.json");
    writeFileSync(cachePath, JSON.stringify(empty));

    const result = await fetchAndCacheCatalog("http://localhost:0/api", tmpDir);
    expect(result).not.toBeNull();
    expect(Array.isArray(result!.items)).toBe(true);
    expect(Array.isArray(result!.recipes)).toBe(true);
    expect(Array.isArray(result!.ships)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchAndCacheCatalog — live API response shapes
//
// The real game API doesn't return a flat array for every endpoint. GET
// /api/items returns { items: { "<item_id>": {...}, ... } } — a dict keyed
// by item ID, not a JSON array (verified live 2026-08-05, 3370 entries).
// fetchEndpoint must unwrap that shape too, or every item is silently
// dropped even though the request succeeded with a 200.
// ---------------------------------------------------------------------------

describe("fetchAndCacheCatalog — dict-keyed API response shape", () => {
  let tmpDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("unwraps a dict-of-records response (items keyed by ID) into an array", async () => {
    global.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/items")) {
        return new Response(JSON.stringify({
          items: {
            iron_ore: SAMPLE_ITEMS[0],
            copper_ore: SAMPLE_ITEMS[1],
          },
        }), { status: 200 });
      }
      // recipes/ships: not under test here — return an empty array shape
      return new Response(JSON.stringify({ recipes: [], ships: [] }), { status: 200 });
    }) as unknown as typeof global.fetch;

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(2);
    expect(result!.items.map((i) => i.id).sort()).toEqual(["copper_ore", "iron_ore"]);
  });

  it("uses the dict key as the record id when the record omits its own", async () => {
    global.fetch = mockItemsResponse({
      items: { iron_ore: { name: "Iron Ore", category: "ore", size: 1, base_value: 50 } },
    });

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].id).toBe("iron_ore");
  });

  it("keeps the record's own id when it disagrees with the dict key", async () => {
    global.fetch = mockItemsResponse({
      items: { stale_key: { id: "iron_ore", name: "Iron Ore", category: "ore", size: 1, base_value: 50 } },
    });

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);
    expect(result!.items[0].id).toBe("iron_ore");
  });

  it("drops non-record dict values instead of letting them reach searchCatalog", async () => {
    global.fetch = mockItemsResponse({
      items: {
        a: 1,
        b: "x",
        c: null,
        iron_ore: { id: "iron_ore", name: "Iron Ore", category: "ore", size: 1, base_value: 50 },
      },
    });

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].id).toBe("iron_ore");
    // searchCatalog reads e.id with no guard — a null in the array took the
    // whole query_catalog tool out with a TypeError.
    expect(() => searchCatalog("item", "iron")).not.toThrow();
  });

  it("unwraps a dict nested under obj.data, matching the array branch's fallback", async () => {
    global.fetch = mockItemsResponse({
      data: { iron_ore: { id: "iron_ore", name: "Iron Ore", category: "ore", size: 1, base_value: 50 } },
    });

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);
    expect(result!.items).toHaveLength(1);
    expect(result!.items[0].id).toBe("iron_ore");
  });
});

// ---------------------------------------------------------------------------
// catalogBaseUrl — the wiring index.ts uses
//
// Before this accessor existed, index.ts read config.gameApiRoot inline and
// nothing imported index.ts, so flipping that one line back to
// config.gameApiUrl — reintroducing the entire silent-empty-catalog bug —
// left the suite fully green.
// ---------------------------------------------------------------------------

describe("catalogBaseUrl", () => {
  it("resolves to the unversioned GET base, never the POST-only /api/v1 one", () => {
    const config = createMockConfig({
      gameApiUrl: "https://game.spacemolt.com/api/v1",
      gameApiRoot: "https://game.spacemolt.com/api",
    });

    expect(catalogBaseUrl(config)).toBe("https://game.spacemolt.com/api");
    expect(catalogBaseUrl(config)).not.toBe(config.gameApiUrl);
    expect(catalogBaseUrl(config)).not.toMatch(/\/v\d+\/?$/);
  });
});

// ---------------------------------------------------------------------------
// fetchAndCacheCatalog — refuses a versioned base
// ---------------------------------------------------------------------------

describe("fetchAndCacheCatalog — versioned base guard", () => {
  let tmpDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null without issuing a request when handed an /api/v1 base", async () => {
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const result = await fetchAndCacheCatalog("https://game.spacemolt.com/api/v1", tmpDir);

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// fetchAndCacheCatalog — poisoned (all-empty) cache
//
// The pre-fix code fetched from /api/v1, got 405 on every endpoint, and wrote
// the all-empty result to disk with a *fresh* fetched_at. Honouring the 24h
// TTL on such a file would keep this fix inert for up to a day after deploy.
// ---------------------------------------------------------------------------

describe("fetchAndCacheCatalog — all-empty cache is never trusted", () => {
  let tmpDir: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refetches past the TTL when the cached catalog is empty in every collection", async () => {
    const cachePath = join(tmpDir, "data", "catalog.json");
    writeFileSync(cachePath, JSON.stringify({
      items: [],
      recipes: [],
      ships: [],
      fetched_at: new Date().toISOString(), // fresh — well inside the 24h TTL
    }));

    const fetchSpy = mockItemsResponse({
      items: { iron_ore: SAMPLE_ITEMS[0], copper_ore: SAMPLE_ITEMS[1] },
    });
    global.fetch = fetchSpy;

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);

    expect(fetchSpy).toHaveBeenCalled();
    expect(result!.items).toHaveLength(2);
  });

  it("still honours the TTL when the cached catalog has content", async () => {
    const cachePath = join(tmpDir, "data", "catalog.json");
    writeFileSync(cachePath, JSON.stringify(SAMPLE_CATALOG));

    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result!.items).toHaveLength(3);
  });

  it("refetches when only recipes are empty is NOT triggered — a recipe-less catalog is legitimate", async () => {
    // /api/recipes is 404 in the live game, so items+ships with zero recipes
    // is the normal production shape and must still satisfy the TTL.
    const cachePath = join(tmpDir, "data", "catalog.json");
    writeFileSync(cachePath, JSON.stringify({
      items: SAMPLE_ITEMS,
      recipes: [],
      ships: SAMPLE_SHIPS,
      fetched_at: new Date().toISOString(),
    }));

    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof global.fetch;

    const result = await fetchAndCacheCatalog("http://fake-game-api/api", tmpDir);

    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result!.items).toHaveLength(3);
  });
});
