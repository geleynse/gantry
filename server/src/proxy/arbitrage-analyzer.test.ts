import { describe, it, expect } from "bun:test";
import { ArbitrageAnalyzer } from "./arbitrage-analyzer.js";
import type { MarketData, MarketItem } from "./market-cache.js";

function makeItem(overrides: Partial<MarketItem> & { item_id: string; empire: string }): MarketItem {
  return {
    item_name: overrides.item_id.replace(/_/g, " "),
    category: "ore",
    base_value: 10,
    best_bid: 0,
    best_ask: 0,
    bid_quantity: 100,
    ask_quantity: 100,
    spread: 0,
    spread_pct: 0,
    ...overrides,
  };
}

function makeData(items: MarketItem[]): MarketData {
  return {
    categories: ["ore"],
    empires: [{ id: "sol", name: "Sol" }, { id: "voidborn", name: "Voidborn" }],
    items,
  };
}

describe("ArbitrageAnalyzer.analyze()", () => {
  const analyzer = new ArbitrageAnalyzer();

  it("returns empty array for empty market data", () => {
    const result = analyzer.analyze(makeData([]));
    expect(result).toEqual([]);
  });

  it("returns empty array when only one empire entry for an item", () => {
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 10, best_bid: 200, bid_quantity: 100, ask_quantity: 50 }),
    ]);
    expect(analyzer.analyze(data)).toHaveLength(0);
  });

  it("returns empty when cheapest ask and richest bid are in same empire", () => {
    // sol has both cheapest ask (5) and richest bid (200) — no cross-empire trade
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 5, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 500, best_bid: 10, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    expect(analyzer.analyze(data)).toHaveLength(0);
  });

  it("identifies cross-empire opportunity with correct fields", () => {
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 5, best_bid: 10, bid_quantity: 20, ask_quantity: 200 }),
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 50, best_bid: 200, bid_quantity: 100, ask_quantity: 10 }),
    ]);
    const result = analyzer.analyze(data);
    expect(result).toHaveLength(1);
    const opp = result[0];
    expect(opp.item_id).toBe("iron_ore");
    expect(opp.buy_empire).toBe("voidborn");      // cheapest ask = 5
    expect(opp.sell_empire).toBe("sol");           // richest bid = 200
    expect(opp.buy_price).toBe(5);
    expect(opp.sell_price).toBe(200);
    expect(opp.profit_per_unit).toBe(195);
    expect(opp.profit_margin_pct).toBe(3900);
    expect(opp.estimated_volume).toBe(100);        // min(ask_qty=200, bid_qty=100)
  });

  it("filters out <10% margin opportunities", () => {
    // margin = (109-100)/100*100 = 9% → excluded
    const data = makeData([
      makeItem({ item_id: "low_margin", empire: "sol", best_ask: 100, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "low_margin", empire: "voidborn", best_ask: 5000, best_bid: 109, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    const result = analyzer.analyze(data);
    expect(result).toHaveLength(0);
  });

  it("includes opportunities with exactly 10% margin", () => {
    // margin = (110-100)/100*100 = 10% → included
    const data = makeData([
      makeItem({ item_id: "ten_pct", empire: "sol", best_ask: 100, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "ten_pct", empire: "voidborn", best_ask: 5000, best_bid: 110, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    const result = analyzer.analyze(data);
    expect(result).toHaveLength(1);
    expect(result[0].profit_margin_pct).toBe(10);
  });

  it("filters out opportunities with estimated_volume = 0", () => {
    // cheapest ask is sol with ask_quantity=0 → estimated_volume = min(0, 100) = 0
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 100, ask_quantity: 0 }),
      makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    expect(analyzer.analyze(data)).toHaveLength(0);
  });

  it("sorts by profit_per_unit * estimated_volume descending", () => {
    // item_big: profit=100/unit * volume=100 = total 10,000
    // item_small: profit=500/unit * volume=10 = total 5,000
    const data = makeData([
      makeItem({ item_id: "item_big", empire: "sol", best_ask: 100, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "item_big", empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "item_small", empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 10, ask_quantity: 100 }),
      makeItem({ item_id: "item_small", empire: "voidborn", best_ask: 5000, best_bid: 510, bid_quantity: 10, ask_quantity: 100 }),
    ]);
    const result = analyzer.analyze(data);
    expect(result).toHaveLength(2);
    expect(result[0].item_id).toBe("item_big");   // 10,000 total
    expect(result[1].item_id).toBe("item_small");  // 5,000 total
  });

  it("caps results at 20 opportunities", () => {
    const items: MarketItem[] = [];
    for (let i = 0; i < 25; i++) {
      items.push(makeItem({ item_id: `item_${i}`, empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }));
      items.push(makeItem({ item_id: `item_${i}`, empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }));
    }
    expect(analyzer.analyze(makeData(items))).toHaveLength(20);
  });

  it("ignores entries with zero best_ask when finding cheapest", () => {
    // sol has ask=0 → removed from withAsk; only voidborn in withAsk
    // cheapest=voidborn(10), richest=voidborn(200) → same empire → no opportunity
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 0, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 10, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    expect(analyzer.analyze(data)).toHaveLength(0);
  });

  it("ignores entries with zero best_bid when finding richest", () => {
    // sol has bid=0 → removed from withBid; only voidborn in withBid
    // cheapest ask=sol(10), richest bid=voidborn(200) → different empires → valid opportunity
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 10, best_bid: 0, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 500, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    const result = analyzer.analyze(data);
    expect(result).toHaveLength(1);
    expect(result[0].buy_empire).toBe("sol");
    expect(result[0].sell_empire).toBe("voidborn");
  });

  it("calculates estimated_volume as min(ask_quantity, bid_quantity)", () => {
    // sol (cheapest ask): ask_quantity=30; voidborn (richest bid): bid_quantity=50
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 999, ask_quantity: 30 }),
      makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 50, ask_quantity: 999 }),
    ]);
    const result = analyzer.analyze(data);
    expect(result[0].estimated_volume).toBe(30); // min(30, 50)
  });

  it("rounds profit_margin_pct to 1 decimal place", () => {
    // (133-100)/100 * 100 = 33.0 exactly
    const data = makeData([
      makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 100, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 5000, best_bid: 133, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    expect(analyzer.analyze(data)[0].profit_margin_pct).toBe(33);
  });

  it("handles multiple items across three empires", () => {
    const data = makeData([
      makeItem({ item_id: "item_a", empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "item_a", empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
      makeItem({ item_id: "item_a", empire: "crimson", best_ask: 8, best_bid: 500, bid_quantity: 100, ask_quantity: 100 }),
    ]);
    const result = analyzer.analyze(data);
    // cheapest ask: crimson(8), richest bid: crimson(500) → same empire → skip
    // Actually: withAsk=[sol(10), voidborn(5000), crimson(8)] → cheapest=crimson(8)
    //           withBid=[sol(5), voidborn(200), crimson(500)] → richest=crimson(500)
    //           same empire (crimson) → no opportunity
    expect(result).toHaveLength(0);
  });
});

describe("ArbitrageAnalyzer.getOpportunities()", () => {
  it("returns cached results within TTL (same reference)", () => {
    const analyzer = new ArbitrageAnalyzer(60_000);
    const data: MarketData = {
      categories: ["ore"],
      empires: [{ id: "sol", name: "Sol" }, { id: "voidborn", name: "Voidborn" }],
      items: [
        makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
        makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
      ],
    };

    const mockCache = { get: () => ({ data, stale: false, age_seconds: 10 }) } as any;
    const first = analyzer.getOpportunities(mockCache);
    expect(first).toHaveLength(1);

    // Change cache data — should still return cached results
    const emptyCache = { get: () => ({ data: { ...data, items: [] }, stale: false, age_seconds: 10 }) } as any;
    const second = analyzer.getOpportunities(emptyCache);
    expect(second).toBe(first);  // same array reference = cached
  });

  it("recomputes after TTL expires", async () => {
    const analyzer = new ArbitrageAnalyzer(1); // 1ms TTL
    const data: MarketData = {
      categories: ["ore"],
      empires: [{ id: "sol", name: "Sol" }, { id: "voidborn", name: "Voidborn" }],
      items: [
        makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
        makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
      ],
    };
    const mockCache = { get: () => ({ data, stale: false, age_seconds: 10 }) } as any;
    const first = analyzer.getOpportunities(mockCache);
    expect(first).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 5)); // let TTL expire

    const emptyCache = { get: () => ({ data: { ...data, items: [] }, stale: false, age_seconds: 10 }) } as any;
    const second = analyzer.getOpportunities(emptyCache);
    expect(second).toHaveLength(0); // recomputed, now empty
  });

  it("returns empty array when market cache has no data", () => {
    const analyzer = new ArbitrageAnalyzer();
    const noDataCache = { get: () => ({ data: null, stale: false, age_seconds: -1 }) } as any;
    expect(analyzer.getOpportunities(noDataCache)).toEqual([]);
  });

  it("returns stale cached results when cache has no data yet", () => {
    const analyzer = new ArbitrageAnalyzer(60_000);
    const data: MarketData = {
      categories: ["ore"],
      empires: [{ id: "sol", name: "Sol" }, { id: "voidborn", name: "Voidborn" }],
      items: [
        makeItem({ item_id: "iron_ore", empire: "sol", best_ask: 10, best_bid: 5, bid_quantity: 100, ask_quantity: 100 }),
        makeItem({ item_id: "iron_ore", empire: "voidborn", best_ask: 5000, best_bid: 200, bid_quantity: 100, ask_quantity: 100 }),
      ],
    };
    // First call populates cache
    const realCache = { get: () => ({ data, stale: false, age_seconds: 10 }) } as any;
    const first = analyzer.getOpportunities(realCache);
    expect(first).toHaveLength(1);

    // Force TTL expiry, then return null data
    const expiredNoDataCache = { get: () => ({ data: null, stale: true, age_seconds: 999 }) } as any;
    // TTL not yet expired (60s), so still returns cached
    const second = analyzer.getOpportunities(expiredNoDataCache);
    expect(second).toBe(first); // cached, TTL not expired
  });
});
