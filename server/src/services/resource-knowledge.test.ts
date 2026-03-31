/**
 * Tests for resource knowledge — persisted resource location tracking.
 * Uses in-memory SQLite database.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import { ResourceKnowledge, recordMarketResources } from "./resource-knowledge.js";

describe("ResourceKnowledge", () => {
  let rk: ResourceKnowledge;

  beforeEach(() => {
    createDatabase(":memory:");
    rk = new ResourceKnowledge();
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // record + query
  // -----------------------------------------------------------------------

  it("records and queries a resource", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    const results = rk.query("iron_ore");
    expect(results).toHaveLength(1);
    expect(results[0].system).toBe("SOL-001");
    expect(results[0].station).toBe("Station A");
    expect(results[0].quantity_seen).toBe(100);
    expect(results[0].price_seen).toBe(50);
    expect(results[0].source_agent).toBe("alpha");
  });

  it("upserts on same system/station/resource", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    rk.record("SOL-001", "Station A", "iron_ore", 200, 45, "bravo");
    const results = rk.query("iron_ore");
    expect(results).toHaveLength(1);
    expect(results[0].quantity_seen).toBe(200);
    expect(results[0].price_seen).toBe(45);
    expect(results[0].source_agent).toBe("bravo");
  });

  it("records null station", () => {
    rk.record("SOL-001", null, "iron_ore", 100, 50, "alpha");
    const results = rk.query("iron_ore");
    expect(results).toHaveLength(1);
    expect(results[0].station).toBe("");
  });

  it("records null quantity and price", () => {
    rk.record("SOL-001", "Station A", "iron_ore", null, null, "alpha");
    const results = rk.query("iron_ore");
    expect(results).toHaveLength(1);
    expect(results[0].quantity_seen).toBeNull();
    expect(results[0].price_seen).toBeNull();
  });

  it("returns empty array for unknown resource", () => {
    expect(rk.query("unknown")).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // querySystem
  // -----------------------------------------------------------------------

  it("queries all resources in a system", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    rk.record("SOL-001", "Station A", "copper_ore", 50, 80, "alpha");
    rk.record("SOL-002", "Station B", "gold_ore", 10, 500, "bravo");

    const results = rk.querySystem("SOL-001");
    expect(results).toHaveLength(2);
    expect(results[0].resource).toBe("copper_ore"); // sorted alphabetically
    expect(results[1].resource).toBe("iron_ore");
  });

  it("returns empty array for unknown system", () => {
    expect(rk.querySystem("UNKNOWN")).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // getBestPrice
  // -----------------------------------------------------------------------

  it("gets best (lowest) price for a resource", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    rk.record("SOL-002", "Station B", "iron_ore", 200, 30, "bravo");
    rk.record("SOL-003", "Station C", "iron_ore", 50, 80, "gamma");

    const best = rk.getBestPrice("iron_ore");
    expect(best).not.toBeNull();
    expect(best!.price).toBe(30);
    expect(best!.system).toBe("SOL-002");
  });

  it("returns null when no price data", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, null, "alpha");
    expect(rk.getBestPrice("iron_ore")).toBeNull();
  });

  it("returns null for unknown resource", () => {
    expect(rk.getBestPrice("unknown")).toBeNull();
  });

  // -----------------------------------------------------------------------
  // getBestSellPrice
  // -----------------------------------------------------------------------

  it("gets best (highest) sell price", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    rk.record("SOL-002", "Station B", "iron_ore", 200, 30, "bravo");
    rk.record("SOL-003", "Station C", "iron_ore", 50, 80, "gamma");

    const best = rk.getBestSellPrice("iron_ore");
    expect(best).not.toBeNull();
    expect(best!.price).toBe(80);
    expect(best!.system).toBe("SOL-003");
  });

  // -----------------------------------------------------------------------
  // listResources
  // -----------------------------------------------------------------------

  it("lists all unique resources", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    rk.record("SOL-001", "Station A", "copper_ore", 50, 80, "alpha");
    rk.record("SOL-002", "Station B", "iron_ore", 200, 30, "bravo");

    const resources = rk.listResources();
    expect(resources).toEqual(["copper_ore", "iron_ore"]);
  });

  it("returns empty when no records", () => {
    expect(rk.listResources()).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // prune
  // -----------------------------------------------------------------------

  it("prunes old records", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    // All records have last_seen = now(), so pruning "before now" should keep them
    const deleted = rk.prune("2000-01-01");
    expect(deleted).toBe(0);
    expect(rk.count()).toBe(1);
  });

  it("prunes records older than threshold", () => {
    rk.record("SOL-001", "Station A", "iron_ore", 100, 50, "alpha");
    // Prune anything before far future — should delete everything
    const deleted = rk.prune("2099-01-01");
    expect(deleted).toBe(1);
    expect(rk.count()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // count
  // -----------------------------------------------------------------------

  it("counts records", () => {
    expect(rk.count()).toBe(0);
    rk.record("SOL-001", "A", "iron", 10, 5, "a");
    rk.record("SOL-002", "B", "copper", 20, 10, "b");
    expect(rk.count()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// recordMarketResources
// ---------------------------------------------------------------------------

describe("recordMarketResources", () => {
  let rk: ResourceKnowledge;

  beforeEach(() => {
    createDatabase(":memory:");
    rk = new ResourceKnowledge();
  });

  afterEach(() => {
    closeDb();
  });

  it("parses analyze_market recommendations", () => {
    const result = {
      recommendations: [
        { item_id: "iron_ore", quantity: 100, bid_price: 50 },
        { item_id: "copper_ore", quantity: 50, bid_price: 80 },
      ],
    };
    const count = recordMarketResources(rk, "SOL-001", "Station A", result, "alpha");
    expect(count).toBe(2);
    expect(rk.count()).toBe(2);
    const iron = rk.query("iron_ore");
    expect(iron[0].price_seen).toBe(50);
  });

  it("parses view_market items array", () => {
    const result = {
      items: [
        { item_id: "gold_bar", quantity: 10, price: 500 },
        { id: "silver_bar", quantity: 20, price: 200 },
      ],
    };
    const count = recordMarketResources(rk, "SOL-002", "Station B", result, "bravo");
    expect(count).toBe(2);
    const gold = rk.query("gold_bar");
    expect(gold[0].price_seen).toBe(500);
    const silver = rk.query("silver_bar");
    expect(silver[0].price_seen).toBe(200);
  });

  it("parses view_market sell_orders / buy_orders", () => {
    const result = {
      sell_orders: [
        { item_id: "iron_ore", quantity: 100, price_each: 55 },
      ],
      buy_orders: [
        { item_id: "copper_ore", quantity: 50, price_each: 75 },
      ],
    };
    const count = recordMarketResources(rk, "SOL-001", "Station A", result, "gamma");
    expect(count).toBe(2);
  });

  it("handles empty result", () => {
    expect(recordMarketResources(rk, "SOL-001", "A", {}, "a")).toBe(0);
  });

  it("handles null result", () => {
    expect(recordMarketResources(rk, "SOL-001", "A", null, "a")).toBe(0);
  });

  it("handles items with missing item_id", () => {
    const result = {
      items: [
        { quantity: 10, price: 50 }, // no item_id
        { item_id: "iron_ore", quantity: 100, price: 50 },
      ],
    };
    const count = recordMarketResources(rk, "SOL-001", "A", result, "a");
    expect(count).toBe(1);
  });

  it("handles items with id instead of item_id", () => {
    const result = {
      items: [
        { id: "titanium", quantity: 5, price: 1000 },
      ],
    };
    const count = recordMarketResources(rk, "SOL-003", "C", result, "delta");
    expect(count).toBe(1);
    expect(rk.query("titanium")).toHaveLength(1);
  });

  it("handles mixed response with recommendations and items", () => {
    const result = {
      recommendations: [
        { item_id: "iron_ore", quantity: 100, bid_price: 50 },
      ],
      items: [
        { item_id: "copper_ore", quantity: 50, price: 80 },
      ],
    };
    const count = recordMarketResources(rk, "SOL-001", "A", result, "a");
    expect(count).toBe(2);
  });
});
