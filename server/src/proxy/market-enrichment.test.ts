import { describe, it, expect } from "bun:test";
import { enrichWithGlobalContext } from "./market-enrichment.js";
import type { MarketData } from "./market-cache.js";

const mockMarketData: MarketData = {
  categories: ["ore", "refined"],
  empires: [{ id: "solarian", name: "Solarian" }],
  items: [
    { item_id: "iron_ore", item_name: "Iron Ore", category: "ore", base_value: 10, empire: "solarian", best_bid: 25, best_ask: 5, bid_quantity: 100, ask_quantity: 50, spread: 20, spread_pct: 400 },
    { item_id: "steel_plate", item_name: "Refined Steel", category: "refined", base_value: 100, empire: "solarian", best_bid: 450, best_ask: 200, bid_quantity: 200, ask_quantity: 30, spread: 250, spread_pct: 125 },
  ],
};

describe("enrichWithGlobalContext", () => {
  it("adds better prices for cargo items", () => {
    const cargo = [{ item_id: "iron_ore", quantity: 50 }];
    const localBids = new Map([["iron_ore", 10]]);
    const result = enrichWithGlobalContext(cargo, localBids, mockMarketData, "sol_station");
    expect(result).toBeDefined();
    expect(result!.better_prices_elsewhere).toHaveLength(1);
    expect(result!.better_prices_elsewhere[0].item).toBe("iron_ore");
    expect(result!.better_prices_elsewhere[0].best_bid).toBe(25);
  });

  it("omits items where improvement is less than 20%", () => {
    const cargo = [{ item_id: "iron_ore", quantity: 50 }];
    const localBids = new Map([["iron_ore", 24]]);
    const result = enrichWithGlobalContext(cargo, localBids, mockMarketData, "sol_station");
    expect(result).toBeNull();
  });

  it("returns null when no cargo items have better prices", () => {
    const cargo = [{ item_id: "iron_ore", quantity: 50 }];
    const localBids = new Map([["iron_ore", 30]]);
    const result = enrichWithGlobalContext(cargo, localBids, mockMarketData, "sol_station");
    expect(result).toBeNull();
  });

  it("returns null when market data is null", () => {
    const cargo = [{ item_id: "iron_ore", quantity: 50 }];
    const result = enrichWithGlobalContext(cargo, new Map(), null, "sol_station");
    expect(result).toBeNull();
  });

  it("shows no-local-demand items with global demand", () => {
    const cargo = [{ item_id: "iron_ore", quantity: 50 }];
    const localBids = new Map<string, number>(); // empty = no local data
    const result = enrichWithGlobalContext(cargo, localBids, mockMarketData, "sol_station");
    expect(result).toBeDefined();
    expect(result!.better_prices_elsewhere[0].improvement).toBe("no local demand");
  });
});
