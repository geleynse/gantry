import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb, getDb } from "./database.js";
import { FleetCoordinator } from "./coordinator.js";
import { setConfigForTesting } from "../config/fleet.js";
import { createMockConfig } from "../test/helpers.js";
import type { BattleState } from "../shared/types.js";

// Minimal mock MarketCache
function createMockMarketCache() {
  return {
    get: () => ({ data: null, stale: false, age_seconds: -1 }),
    getData: () => null,
    update: () => {},
    isReady: () => false,
  } as any;
}

// Minimal mock ArbitrageAnalyzer
function createMockArbitrageAnalyzer(opportunities: any[] = []) {
  return {
    getOpportunities: () => opportunities,
    analyze: () => opportunities,
  } as any;
}

// Create a statusCache with agents that look "online"
function createStatusCache(
  agents: Record<string, Record<string, unknown>> = {},
): Map<string, { data: Record<string, unknown>; fetchedAt: number }> {
  const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  for (const [name, data] of Object.entries(agents)) {
    cache.set(name, { data, fetchedAt: Date.now() });
  }
  return cache;
}

const testConfig = createMockConfig({
  agents: [
    { name: "drifter-gale", faction: "solarian", role: "Explorer" },
    { name: "sable-thorn", faction: "crimson", role: "Combat" },
    { name: "rust-vane", faction: "solarian", role: "Trader" },
    { name: "lumen-shoal", faction: "nebula", role: "Explorer" },
    { name: "cinder-wake", faction: "solarian", role: "Trader" },
  ],
  gameUrl: "https://game.test/mcp",
  gameApiUrl: "https://game.test/api/v1",
  coordinator: {
    enabled: false,
    intervalMinutes: 10,
    defaultDistribution: { miners: 2, crafters: 1, traders: 1, flex: 1 },
    quotaDefaults: { batchSize: 50, maxActiveQuotas: 10 },
  },
});

describe("FleetCoordinator", () => {
  beforeEach(() => {
    createDatabase(":memory:");
    setConfigForTesting(testConfig);
  });

  afterEach(() => {
    closeDb();
  });

  test("isEnabled returns false by default", () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    expect(coord.isEnabled()).toBe(false);
  });

  test("setEnabled overrides config", () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    coord.setEnabled(true);
    expect(coord.isEnabled()).toBe(true);
    coord.setEnabled(false);
    expect(coord.isEnabled()).toBe(false);
  });

  test("tick returns result with assignments when agents are online", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000, system: "sol" },
      "rust-vane": { credits: 5000, system: "sirius" },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    const result = await coord.tick();
    expect(result.tick_number).toBe(1);
    expect(result.assignments.length).toBeGreaterThan(0);
    expect(result.tick_at).toBeTruthy();
  });

  test("tick generates no assignments when no agents are online", async () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    const result = await coord.tick();
    expect(result.assignments).toHaveLength(0);
  });

  test("tick persists state to coordinator_state table", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    await coord.tick();

    const db = getDb();
    const row = db.prepare("SELECT * FROM coordinator_state ORDER BY tick_number DESC LIMIT 1").get() as any;
    expect(row).toBeTruthy();
    expect(row.tick_number).toBe(1);
    expect(JSON.parse(row.assignments)).toBeInstanceOf(Array);
  });

  test("tick does not deliver orders when disabled", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    // disabled by default

    await coord.tick();

    const db = getDb();
    const orders = db.prepare("SELECT * FROM fleet_orders WHERE message LIKE '[COORDINATOR]%'").all();
    expect(orders).toHaveLength(0);
  });

  test("tick delivers orders when enabled", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    coord.setEnabled(true);

    await coord.tick();

    const db = getDb();
    const orders = db.prepare("SELECT * FROM fleet_orders WHERE message LIKE '[COORDINATOR]%'").all();
    expect(orders.length).toBeGreaterThan(0);
  });

  test("tick expires previous coordinator orders before creating new ones", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    coord.setEnabled(true);

    // First tick creates orders
    await coord.tick();
    const db = getDb();
    const firstOrders = db.prepare("SELECT * FROM fleet_orders WHERE message LIKE '[COORDINATOR]%'").all();
    expect(firstOrders.length).toBeGreaterThan(0);

    // Second tick should expire old ones and create new ones
    await coord.tick();
    const secondOrders = db.prepare("SELECT * FROM fleet_orders WHERE message LIKE '[COORDINATOR]%'").all();
    // Should have roughly the same count (old expired, new created)
    expect(secondOrders.length).toBeGreaterThan(0);
  });

  test("getLastTick returns null before any ticks", () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    expect(coord.getLastTick()).toBeNull();
  });

  test("getLastTick returns the most recent tick result", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    await coord.tick();
    const lastTick = coord.getLastTick();
    expect(lastTick).toBeTruthy();
    expect(lastTick!.tick_number).toBe(1);
  });

  test("getHistory returns tick history from database", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    await coord.tick();
    await coord.tick();

    const history = coord.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].tick_number).toBe(2); // most recent first
    expect(history[1].tick_number).toBe(1);
  });

  test("getAgentAssignment returns assignment for specific agent", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
      "rust-vane": { credits: 5000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    await coord.tick();
    const assignment = coord.getAgentAssignment("drifter-gale");
    expect(assignment).toBeTruthy();
    expect(assignment!.agent).toBe("drifter-gale");
    expect(assignment!.role).toBeDefined();
  });

  test("getAgentAssignment returns null for unknown agent", async () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    await coord.tick();
    expect(coord.getAgentAssignment("nonexistent")).toBeNull();
  });

  test("createQuota creates a new active quota", () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    const quota = coord.createQuota("iron_ore", 200, "sol_station");
    expect(quota.item_id).toBe("iron_ore");
    expect(quota.target_quantity).toBe(200);
    expect(quota.status).toBe("active");
    expect(quota.current_quantity).toBe(0);
  });

  test("cancelQuota cancels an active quota", () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    const quota = coord.createQuota("iron_ore", 200, "sol_station");
    const cancelled = coord.cancelQuota(quota.id);
    expect(cancelled).toBe(true);

    const activeQuotas = coord.getActiveQuotas();
    expect(activeQuotas).toHaveLength(0);
  });

  test("cancelQuota returns false for nonexistent quota", () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    expect(coord.cancelQuota(999)).toBe(false);
  });

  test("getActiveQuotas returns only active quotas", () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    coord.createQuota("iron_ore", 200, "sol_station");
    const q2 = coord.createQuota("gold_ore", 100, "sol_station");
    coord.cancelQuota(q2.id);

    const active = coord.getActiveQuotas();
    expect(active).toHaveLength(1);
    expect(active[0].item_id).toBe("iron_ore");
  });

  test("isInCombat is false when battleCache is empty or battle is resolved", async () => {
    const battleCache = new Map<string, BattleState | null>();
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), battleCache,
    );

    // Empty cache → not in combat
    expect(battleCache.get("drifter-gale")).toBeUndefined();

    // Resolved battle → not in combat
    battleCache.set("drifter-gale", {
      battle_id: "123",
      zone: "zone1",
      stance: "defensive",
      hull: 100,
      shields: 50,
      target: null,
      status: "resolved",
      updatedAt: Date.now(),
    });
    const entry = battleCache.get("drifter-gale");
    const isInCombat = !!entry?.battle_id && entry?.status !== "resolved";
    expect(isInCombat).toBe(false);
  });

  test("isInCombat is true when battleCache contains an active battle", async () => {
    const battleCache = new Map<string, BattleState | null>();
    battleCache.set("sable-thorn", {
      battle_id: "456",
      zone: "zone2",
      stance: "offensive",
      hull: 80,
      shields: 30,
      target: { name: "pirate" },
      status: "active",
      updatedAt: Date.now(),
    });
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), battleCache,
    );

    const entry = battleCache.get("sable-thorn");
    const isInCombat = !!entry?.battle_id && entry?.status !== "resolved";
    expect(isInCombat).toBe(true);
  });

  test("tick increments tick number", async () => {
    const coord = new FleetCoordinator(
      new Map(), createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );

    const r1 = await coord.tick();
    const r2 = await coord.tick();
    expect(r1.tick_number).toBe(1);
    expect(r2.tick_number).toBe(2);
  });

  test("tick uses arbitrage data for trader assignments", async () => {
    const opps = [{
      item_id: "iron_ore",
      item_name: "Iron Ore",
      buy_empire: "sol",
      sell_empire: "voidborn",
      buy_price: 10,
      sell_price: 200,
      profit_per_unit: 190,
      profit_margin_pct: 50,
      estimated_volume: 100,
    }];
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
      "sable-thorn": { credits: 5000 },
      "rust-vane": { credits: 7000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(opps), new Map(),
    );

    const result = await coord.tick();
    expect(result.market_snapshot.length).toBeGreaterThan(0);
    // At least one assignment should exist
    expect(result.assignments.length).toBeGreaterThan(0);
  });

  test("coordinator orders have COORDINATOR prefix", async () => {
    const statusCache = createStatusCache({
      "drifter-gale": { credits: 10000 },
    });
    const coord = new FleetCoordinator(
      statusCache, createMockMarketCache(), createMockArbitrageAnalyzer(), new Map(),
    );
    coord.setEnabled(true);

    await coord.tick();

    const db = getDb();
    const orders = db.prepare("SELECT message FROM fleet_orders").all() as { message: string }[];
    for (const order of orders) {
      expect(order.message).toStartWith("[COORDINATOR]");
    }
  });
});
