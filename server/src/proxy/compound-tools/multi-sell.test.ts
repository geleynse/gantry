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

/**
 * Build a default waitForTick that simulates a successful refreshStatus by
 * advancing the cache entry's fetchedAt for `agentName`. multi-sell now uses
 * fetchedAt advancement as the signal for "post-action verification succeeded";
 * tests that don't override waitForTick should reflect the success path.
 */
function makeAdvancingWaitForTick(
  cache: Map<string, StatusEntry>,
  agentName: string,
): GameClientLike["waitForTick"] {
  return async () => {
    const entry = cache.get(agentName);
    if (entry) cache.set(agentName, { data: entry.data, fetchedAt: Date.now() + 1 });
  };
}

function makeClient(
  overrides: Partial<{
    execute: GameClientLike["execute"];
    waitForTick: GameClientLike["waitForTick"];
  }> = {},
  // Optional cache + agent so the default waitForTick advances fetchedAt
  cacheCtx?: { cache: Map<string, StatusEntry>; agentName: string },
): GameClientLike {
  const defaultWaitForTick = cacheCtx
    ? makeAdvancingWaitForTick(cacheCtx.cache, cacheCtx.agentName)
    : (async () => {}) as GameClientLike["waitForTick"];
  return {
    execute: overrides.execute ?? (async () => ({ result: { ok: true } })),
    waitForTick: overrides.waitForTick ?? defaultWaitForTick,
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.error).toBeTruthy();
    expect(String(result.error)).toContain("docked");
  });

  it("confirms dock from the get_status TEXT dashboard when cache is stale (no extra refresh round-trip)", async () => {
    // Cache stale (says not docked); the agent actually just docked. The fresh
    // get_status text carries "Docked at:" — multi_sell should read it directly
    // and proceed, instead of false-blocking. Guards the v0.417.3 dock fix.
    const cache = makeStatusCache("agent", {
      player: { docked_at_base: null, credits: 1000 },
    });
    let dockRefreshGetLocation = false;
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "get_status") {
          return {
            result:
              "Agent [solarian] | 1,000cr | Sirius\n" +
              "Fuel: 50/100 | Cargo: 10/50 | CPU: 4/16 | Power: 10/28\n" +
              "Docked at: sirius_observatory_station\n" +
              "Security: High Security (active police)",
          };
        }
        // The dock check must NOT need get_location — text alone settles it.
        if (tool === "get_location" || args?.action === "get_location") dockRefreshGetLocation = true;
        if (tool === "sell") return { result: { credits_earned: 100 } };
        return { result: {} };
      },
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    // Dock confirmed from the get_status text → sell proceeds instead of false-blocking.
    expect(result.error).toBeFalsy();
    expect(result.status).toBe("completed");
    expect(dockRefreshGetLocation).toBe(false);
  });

  it("resolves quantity=ALL from name-keyed cargo cache (slug match)", async () => {
    // refreshStatus stores cargo as { name, quantity } (no item_id). ALL-resolution
    // must slug the name to match the requested item_id, else it false-errors
    // "No <item> in cargo to sell".
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 14, cargo: [{ name: "Iron Ore", quantity: 7 }] },
    });
    let soldQty: number | undefined;
    const client = makeClient({
      execute: async (tool, args) => {
        if (tool === "sell") { soldQty = args?.quantity as number; return { result: { credits_earned: 70 } }; }
        return { result: {} };
      },
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: "ALL" as unknown as number }],
      new Set(["analyze_market"]),
    );

    expect(result.status).toBe("completed");
    expect(soldQty).toBe(7); // resolved from "Iron Ore" → iron_ore
  });

  it("adds cargo_warning when cargo is unchanged after sells", async () => {
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      // cargo_used is same before and after
      ship: { cargo_used: 15 },
    });
    const client = makeClient({
      execute: async () => ({ result: { ok: true } }),
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
    }, { cache, agentName: "agent" });
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
        // Simulate refreshStatus success: advance fetchedAt so verification passes
        const entry = cache.get("agent");
        if (entry) cache.set("agent", { data: entry.data, fetchedAt: Date.now() + tickCount });
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
        // Simulate refreshStatus success: advance fetchedAt so verification passes
        const entry = cache.get("agent");
        if (entry) cache.set("agent", { data: entry.data, fetchedAt: Date.now() + tickCount });
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

  it("flags verification_status=rate_limited when post-sell refreshStatus fails (does NOT lie about credits_delta=0)", async () => {
    // Repro: rust-vane plasma sale 2026-05-06. multi_sell completes the underlying sell
    // calls; refreshStatus then hits -32029 rate-limit; pre-sale cache stays stale; old
    // code returned credits_delta=0 + "cargo unchanged" warning, agent narrated item loss.
    // Expected new behavior: verification_status="rate_limited", no credits_delta lie,
    // explicit "verify with get_status / get_cargo" message.
    const cache = makeStatusCache("agent", {
      player: { current_poi: "ccc_central", credits: 50_845_456, docked_at_base: "ccc_central" },
      ship: { cargo_used: 189 },
    });
    let sellCount = 0;
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          sellCount++;
          // Game returns the buggy success-shape "Sold 0 for 0cr" — same as production
          return { result: { message: "Sold 0 for 0cr" } };
        }
        return { result: {} };
      },
      // Critical: waitForTick returns but does NOT advance fetchedAt — simulates
      // refreshStatus hitting -32029 on both get_status + get_location.
      waitForTick: async () => { /* no-op: cache stays stale */ },
    });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "plasma_cell_pack", quantity: 75 }],
      new Set(["analyze_market"]),
    );

    expect(sellCount).toBe(1);
    expect(result.status).toBe("completed");
    // The fix: report rate-limited verification, not a fabricated zero delta.
    expect(result.verification_status).toBe("rate_limited");
    expect(String(result.verification_message)).toContain("rate-limited");
    expect(String(result.verification_message)).toContain("get_cargo");
    // Must NOT emit the misleading shape that started this whole incident.
    expect(result.cargo_warning).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.credits_after).toBeUndefined();
    expect((result as Record<string, unknown>).credits_delta).toBeUndefined();
    // Pre-sale state is exposed under explicit "_before" names so the agent knows
    // these are NOT the post-sale numbers.
    expect(result.credits_before).toBe(50_845_456);
    expect(result.cargo_used_before).toBe(189);
  }, 15_000); // helper retries with 1s backoff x2 — generous timeout

  it("flags verification_status=ok and computes credits_delta when refresh succeeds", async () => {
    // Counterpoint to the rate-limited test: when the post-sell refresh succeeds
    // (cache.fetchedAt advances), normal verification + delta computation runs.
    const cache = makeStatusCache("agent", {
      player: { current_poi: "ccc_central", credits: 50_845_456, docked_at_base: "ccc_central" },
      ship: { cargo_used: 189 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          // Simulate the sell settling: bump credits, drop cargo
          const entry = cache.get("agent")!;
          cache.set("agent", {
            ...entry,
            data: {
              ...entry.data,
              player: { ...(entry.data.player as Record<string, unknown>), credits: 50_850_691 },
              ship: { cargo_used: 114 },
            },
          });
          return { result: { ok: true } };
        }
        return { result: {} };
      },
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "plasma_cell_pack", quantity: 75 }],
      new Set(["analyze_market"]),
    );

    expect(result.verification_status).toBe("ok");
    expect(result.credits_after).toBe(50_850_691);
    expect(result.cargo_warning).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(result.verification_message).toBeUndefined();
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
    }, { cache, agentName: "agent" });
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

  // ---------------------------------------------------------------------------
  // "Sold 0 for 0cr" normalization (sable-thorn 2026-06-01)
  // ---------------------------------------------------------------------------

  it("zero-cr display: when credits increased despite 'Sold 0 for 0cr' result, surfaces real delta as multi_sell_ok", async () => {
    // Repro: game returns { message: "Sold 0 for 0cr" } cosmetically, but credits
    // actually transferred. Without normalization the agent sees "Sold 0" and retries.
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          // Credits update in cache (simulates post-sell state_update)
          const entry = cache.get("agent")!;
          cache.set("agent", {
            ...entry,
            data: {
              ...entry.data,
              player: { ...(entry.data.player as Record<string, unknown>), credits: 1500 },
              ship: { cargo_used: 5 },
            },
          });
          // But display says "Sold 0 for 0cr" — cosmetic lag
          return { result: { message: "Sold 0 for 0cr" } };
        }
        return { result: {} };
      },
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.status).toBe("completed");
    expect(result.verification_status).toBe("ok");
    // Must NOT warn "0 credits earned" when credits actually changed
    expect(result.warning).toBeUndefined();
    // Must expose credits_delta so the agent sees the real outcome
    // Note: normalization flags are on the per-item result object, not the sell entry
    const sellEntry = (result.sells as Array<Record<string, unknown>>)[0];
    const sellResult = sellEntry.result as Record<string, unknown>;
    expect(sellResult._cosmetic_zero_cr).toBe(true);
    expect(typeof sellResult.credits_delta).toBe("number");
    expect((sellResult.credits_delta as number)).toBeGreaterThan(0);
  });

  it("zero-cr display: when credits DID NOT change after 'Sold 0 for 0cr', normalizes to multi_sell_no_op with cause hint", async () => {
    // Genuine no-op: game says "Sold 0 for 0cr" AND credits stayed the same.
    // Should produce a clear no-op marker instead of an opaque 0-credit display.
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 5000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          // Credits do NOT change — genuine no-op
          return { result: { message: "Sold 0 for 0cr" } };
        }
        return { result: {} };
      },
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "unknown_item", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.status).toBe("completed");
    const sellEntry = (result.sells as Array<Record<string, unknown>>)[0];
    const sellResult = sellEntry.result as Record<string, unknown>;
    // Should be flagged as a genuine no-op with a cause hint
    expect(sellResult._sell_no_op).toBe(true);
    expect(typeof sellResult.cause_hint).toBe("string");
    expect(String(sellResult.cause_hint)).toContain("no demand");
  });

  it("zero-cr display: when credits_before is unavailable, marks _cosmetic_display_unknown and does NOT fabricate a delta", async () => {
    // Degrade gracefully when we can't compute a real delta.
    // credits_before = undefined because cache had no credits field.
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", docked_at_base: "sol_station" }, // no credits field
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") return { result: { message: "Sold 0 for 0cr" } };
        return { result: {} };
      },
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.status).toBe("completed");
    const sellEntry = (result.sells as Array<Record<string, unknown>>)[0];
    const sellResult = sellEntry.result as Record<string, unknown>;
    // Must NOT fabricate a delta
    expect(sellResult.credits_delta).toBeUndefined();
    // Must flag the ambiguity so the agent can verify independently
    expect(sellResult._cosmetic_display_unknown).toBe(true);
  });

  it("zero-cr display: normal 'Sold X for Ycr' result is not affected by normalization", async () => {
    // Regression guard: the normalization only fires on the zero-cr pattern.
    const cache = makeStatusCache("agent", {
      player: { current_poi: "sol_station", credits: 1000, docked_at_base: "sol_station" },
      ship: { cargo_used: 10 },
    });
    const client = makeClient({
      execute: async (tool) => {
        if (tool === "sell") {
          const entry = cache.get("agent")!;
          cache.set("agent", {
            ...entry,
            data: {
              ...entry.data,
              player: { ...(entry.data.player as Record<string, unknown>), credits: 1500 },
              ship: { cargo_used: 5 },
            },
          });
          return { result: { message: "Sold 5 iron_ore for 500cr" } };
        }
        return { result: {} };
      },
    }, { cache, agentName: "agent" });
    const deps = makeDeps("agent", client, cache);

    const result = await multiSell(
      deps,
      [{ item_id: "iron_ore", quantity: 5 }],
      new Set(["analyze_market"]),
    );

    expect(result.status).toBe("completed");
    const sellEntry = (result.sells as Array<Record<string, unknown>>)[0];
    const sellResult = sellEntry.result as Record<string, unknown>;
    // None of the normalization fields should be present
    expect(sellResult._cosmetic_zero_cr).toBeUndefined();
    expect(sellResult._sell_no_op).toBeUndefined();
    expect(sellResult._cosmetic_display_unknown).toBeUndefined();
  });
});
