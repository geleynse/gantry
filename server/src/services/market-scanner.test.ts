import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { type MarketData } from "./market-scanner.js";
import { createDatabase, closeDb } from "./database.js";
import { runMarketScan } from "./market-scanner.js";
import { MarketCache } from "../proxy/market-cache.js";

const MOCK_MARKET_DATA: MarketData = {
  categories: ["ore"],
  empires: [{ id: "solarian", name: "Solarian" }, { id: "voidborn", name: "Voidborn" }],
  items: [
    { item_id: "iron_ore", item_name: "Iron Ore", category: "ore", base_value: 10,
      empire: "solarian", best_bid: 200, best_ask: 10, bid_quantity: 100, ask_quantity: 50, spread: 190, spread_pct: 1900 },
    { item_id: "iron_ore", item_name: "Iron Ore", category: "ore", base_value: 10,
      empire: "voidborn", best_bid: 10, best_ask: 5, bid_quantity: 20, ask_quantity: 200, spread: 5, spread_pct: 100 },
  ],
};

describe("runMarketScan", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });
  afterEach(() => { closeDb(); });

  it("creates orders for trade opportunities", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => MOCK_MARKET_DATA,
    })) as unknown as typeof fetch;

    try {
      const result = await runMarketScan();
      expect(result.opportunities).toBeGreaterThan(0);
      expect(result.orders_created).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("deduplicates orders for the same item+empire on second scan", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => MOCK_MARKET_DATA,
    })) as unknown as typeof fetch;

    try {
      const result1 = await runMarketScan();
      const result2 = await runMarketScan();
      // Second scan: same opportunities but no new orders (already exist)
      expect(result2.orders_created).toBe(0);
      expect(result1.opportunities).toBe(result2.opportunities);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("consumes a shared market cache instead of fetching", async () => {
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("scanner must not fetch when a cache is available");
    }) as unknown as typeof fetch;

    try {
      const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
      cache.restore(MOCK_MARKET_DATA, Date.now());
      const result = await runMarketScan(cache);
      expect(result.opportunities).toBeGreaterThan(0);
      expect(result.orders_created).toBeGreaterThan(0);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("skips the scan when cache data is too stale", async () => {
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("scanner must not fall back to fetch on stale cache");
    }) as unknown as typeof fetch;

    try {
      const cache = new MarketCache("http://localhost/api/market", 60_000, [0]);
      cache.restore(MOCK_MARKET_DATA, Date.now() - 16 * 60 * 1000); // > 15 min old
      const result = await runMarketScan(cache);
      expect(result.opportunities).toBe(0);
      expect(result.orders_created).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns zero when no opportunities found", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({ categories: [], empires: [], items: [] }),
    })) as unknown as typeof fetch;

    try {
      const result = await runMarketScan();
      expect(result.opportunities).toBe(0);
      expect(result.orders_created).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
