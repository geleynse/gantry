/**
 * compound-tools/multi-sell.test.ts
 *
 * Tests for the multi_sell compound tool, imported directly from the source module.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "../../services/database.js";
import { multiSell } from "./multi-sell.js";
import type { CompoundToolDeps, GameClientLike, MultiSellItem } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type StatusEntry = { data: Record<string, unknown>; fetchedAt: number };

function makeClient(
  overrides: Partial<{
    execute: GameClientLike["execute"];
    waitForTick: GameClientLike["waitForTick"];
  }> = {},
): GameClientLike {
  return {
    execute: overrides.execute ?? (async () => ({ result: { ok: true } })),
    waitForTick: overrides.waitForTick ?? (async () => {}),
    lastArrivalTick: null,
  };
}

function makeStatusCache(
  agentName: string,
  data: Record<string, unknown>,
): Map<string, StatusEntry> {
  const cache = new Map<string, StatusEntry>();
  cache.set(agentName, { data, fetchedAt: Date.now() });
  return cache;
}

function makeDeps(
  agentName: string,
  client: GameClientLike,
  statusCache: Map<string, StatusEntry>,
  overrides: Partial<Pick<CompoundToolDeps, "sellLog">> = {},
): CompoundToolDeps {
  return {
    client,
    agentName,
    statusCache,
    battleCache: new Map(),
    sellLog: overrides.sellLog ?? new SellLog(),
    galaxyGraph: new GalaxyGraph(),
    persistBattleState: () => {},
    upsertNote: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("multi-sell (direct import)", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("sells all items and returns completed status with items_sold count", async () => {
    const cache = makeStatusCache("agent", {
      player: {
        current_poi: "sol_station",
        credits: 1000,
        docked_at_base: "sol_station",
      },
      ship: { cargo_used: 20 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          // Simulate cargo decreasing after sells
          const entry = cache.get("agent")!;
          cache.set("agent", {
            ...entry,
            data: {
              ...entry.data,
              ship: { cargo_used: 5 },
              player: { ...(entry.data.player as Record<string, unknown>), credits: 1500 },
            },
          });
          return { result: { credits_earned: 500 } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const items: MultiSellItem[] = [
      { item_id: "iron_ore", quantity: 10 },
      { item_id: "copper_ore", quantity: 5 },
    ];
    const result = await multiSell(deps, items, new Set(["analyze_market"]));

    expect(result.status).toBe("completed");
    expect(result.items_sold).toBe(2);
    const sells = result.sells as Array<{ item_id: string; quantity: number }>;
    expect(sells[0].item_id).toBe("iron_ore");
    expect(sells[1].item_id).toBe("copper_ore");
  });

  it("proceeds with advisory when analyze_market not called (no block)", async () => {
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: "sol_station", credits: 1000 },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set<string>(), // No analyze_market
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result._market_advisory).toContain("analyze_market");
  });

  it("allows sell when analyze_market is in the called tools set", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
  });

  it("allows sell when recent market analysis is in the status cache (within 20 min)", async () => {
    const recentTimestamp = Date.now() - 5 * 60_000; // 5 minutes ago
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
      _last_market_analysis_at: recentTimestamp,
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache);

    // calledTools is empty, but cache has recent market analysis
    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set<string>(),
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
  });

  it("proceeds with advisory when cache market analysis is stale", async () => {
    const staleTimestamp = Date.now() - 25 * 60_000; // 25 minutes ago
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: "sol_station", credits: 1000 },
      ship: { cargo_used: 10 },
      _last_market_analysis_at: staleTimestamp,
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set<string>(),
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result._market_advisory).toContain("analyze_market");
  });

  it("blocks when not docked even after a fresh status refresh", async () => {
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null, credits: 1000 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "get_status") {
          // Refresh but still not docked
          return { result: { player: { docked_at_base: null } } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("docked");
  });

  it("adds cargo_warning when cargo is unchanged after sells", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      // cargo_used is same before and after
      ship: { cargo_used: 15 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.cargo_warning).toBeTruthy();
    expect(String(result.cargo_warning)).toContain("unchanged");
  });

  it("does not add cargo_warning when cargo decreased after sells", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 20 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          const entry = cache.get("agent")!;
          cache.set("agent", {
            ...entry,
            data: { ...entry.data, ship: { cargo_used: 5 } },
          });
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 15 }],
      new Set(["analyze_market"]),
    );

    expect(result.cargo_warning).toBeUndefined();
  });

  it("adds zero-credits warning when no credits were earned", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 5000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
      // credits never change in cache
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.warning).toBeTruthy();
    expect(String(result.warning)).toContain("0 credits");
  });

  it("records successful sells in the sell log for fleet deconfliction", async () => {
    const sellLog = new SellLog();
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache, { sellLog });

    await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 10 }],
      new Set(["analyze_market"]),
    );

    const recent = sellLog.getRecent("sol_station");
    expect(recent).toHaveLength(1);
    expect(recent[0].item_id).toBe("iron_ore");
    expect(recent[0].agent).toBe("agent");
    expect(recent[0].quantity).toBe(10);
  });

  it("does not record sells when result has an 'error' key (explicit error shape)", async () => {
    const sellLog = new SellLog();
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    // Return an error object that itself has an "error" key — the sell-log filter
    // checks `"error" in r.result` to detect error results.
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") return { error: { error: "item_not_found", code: 404 } };
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache, { sellLog });

    await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    const recent = sellLog.getRecent("sol_station");
    // When error has an "error" key, the sell-log filter skips it
    expect(recent).toHaveLength(0);
  });

  it("includes fleet_sell_warning when another agent recently sold the same item", async () => {
    const sellLog = new SellLog();

    // Simulate another agent having sold at the same station recently
    sellLog.record("sol_station", {
      agent: "other-agent",
      item_id: "iron_ore",
      quantity: 20,
      timestamp: Date.now() - 60_000, // 1 minute ago
    });

    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    });
    const deps = makeDeps("agent", client, cache, { sellLog });

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.fleet_sell_warning).toBeTruthy();
    expect(String(result.fleet_sell_warning)).toContain("other-agent");
  });

  it("waits for tick between sell batches when selling 35+ items", async () => {
    let tickCount = 0;
    let sellCount = 0;

    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 100_000, docked_at_base: "sol_station" },
      ship: { cargo_used: 50 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          sellCount++;
          return { result: { ok: true } };
        }
        return { result: {} };
      },
      waitForTick: async () => {
        tickCount++;
      },
    });
    const deps = makeDeps("agent", client, cache);

    // 70 items = 2 batches of 35
    const items: MultiSellItem[] = Array.from({ length: 70 }, (_, i) => ({
      item_id: `item_${i}`,
      quantity: 1,
    }));

    await multiSell(deps, items, new Set(["analyze_market"]));

    expect(sellCount).toBe(70);
    // Only 1 final tick wait — batch tick waits removed to prevent HTTP response timeouts
    expect(tickCount).toBe(1);
  });

  it("always waits for a final tick after all sells to allow credits to settle", async () => {
    let tickCount = 0;

    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 5 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
      waitForTick: async () => {
        tickCount++;
      },
    });
    const deps = makeDeps("agent", client, cache);

    await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 1 }],
      new Set(["analyze_market"]),
    );

    // At minimum, 1 final tick wait should occur
    expect(tickCount).toBeGreaterThanOrEqual(1);
  });

  it("includes all sell results even when some fail", async () => {
    let sellIndex = 0;
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 20 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          sellIndex++;
          if (sellIndex === 2) return { error: { code: "item_not_in_cargo" } };
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    });
    const deps = makeDeps("agent", client, cache);

    const items: MultiSellItem[] = [
      { item_id: "iron_ore", quantity: 5 },
      { item_id: "missing_item", quantity: 1 },
      { item_id: "copper_ore", quantity: 3 },
    ];
    const result = await multiSell(deps, items, new Set(["analyze_market"]));

    // All 3 items should appear in sells (success or failure)
    expect(result.items_sold).toBe(3);
    const sells = result.sells as Array<{ item_id: string; result: unknown }>;
    expect(sells.find((s) => s.item_id === "missing_item")).toBeTruthy();
  });
});
