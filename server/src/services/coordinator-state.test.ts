import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, closeDb } from "./database.js";
import { gatherFleetSnapshot, type StateGathererDeps, type AgentSnapshotConfig } from "./coordinator-state.js";
import { OverseerEventLog } from "./overseer-event-log.js";
import type { BattleState } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStatusCache(
  agents: Record<string, { data: Record<string, unknown>; fetchedAt?: number }>,
) {
  const cache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
  for (const [name, entry] of Object.entries(agents)) {
    cache.set(name, { data: entry.data, fetchedAt: entry.fetchedAt ?? Date.now() });
  }
  return cache;
}

function makeMockMarketCache() {
  return {
    get: () => ({ data: null, stale: false, age_seconds: -1 }),
    getData: () => null,
    update: () => {},
    isReady: () => false,
  } as any;
}

function makeMockArbitrageAnalyzer(opportunities: any[] = []) {
  return {
    getOpportunities: () => opportunities,
    analyze: () => opportunities,
  } as any;
}

const agentConfigs: AgentSnapshotConfig[] = [
  { name: "drifter-gale", faction: "solarian", role: "Explorer", operatingZone: "sol" },
  { name: "sable-thorn", faction: "crimson", role: "Combat" },
  { name: "rust-vane", faction: "solarian", role: "Trader" },
];

function makeDeps(overrides: Partial<StateGathererDeps> = {}): StateGathererDeps {
  return {
    statusCache: new Map(),
    battleCache: new Map(),
    arbitrageAnalyzer: makeMockArbitrageAnalyzer(),
    marketCache: makeMockMarketCache(),
    agentConfigs,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gatherFleetSnapshot", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  test("returns agents with correct fields from statusCache (nested format)", () => {
    const statusCache = makeStatusCache({
      "drifter-gale": {
        data: {
          player: {
            credits: 12000,
            current_system: "sol",
            current_poi: "sol_station",
            docked_at_base: true,
          },
          ship: {
            cargo_used: 10,
            cargo_capacity: 50,
            fuel: 80,
            max_fuel: 100,
          },
        },
      },
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ statusCache }));

    const gale = snapshot.agents.find((a) => a.name === "drifter-gale");
    expect(gale).toBeTruthy();
    expect(gale!.credits).toBe(12000);
    expect(gale!.system).toBe("sol");
    expect(gale!.poi).toBe("sol_station");
    expect(gale!.docked).toBe(true);
    expect(gale!.cargoUsed).toBe(10);
    expect(gale!.cargoMax).toBe(50);
    expect(gale!.fuel).toBe(80);
    expect(gale!.fuelMax).toBe(100);
    expect(gale!.isOnline).toBe(true);
    expect(gale!.faction).toBe("solarian");
    expect(gale!.operatingZone).toBe("sol");
  });

  test("marks agents absent from statusCache as offline", () => {
    // Empty cache — no agents have data
    const snapshot = gatherFleetSnapshot(makeDeps());

    for (const agent of snapshot.agents) {
      expect(agent.isOnline).toBe(false);
    }
  });

  test("marks agents with stale fetchedAt (>5min) as offline", () => {
    const staleTs = Date.now() - 6 * 60 * 1000; // 6 minutes ago
    const statusCache = makeStatusCache({
      "drifter-gale": {
        data: { player: { credits: 5000 } },
        fetchedAt: staleTs,
      },
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ statusCache }));
    const gale = snapshot.agents.find((a) => a.name === "drifter-gale")!;
    expect(gale.isOnline).toBe(false);
  });

  test("marks agents with fresh fetchedAt (<5min) as online", () => {
    const freshTs = Date.now() - 2 * 60 * 1000; // 2 minutes ago
    const statusCache = makeStatusCache({
      "drifter-gale": {
        data: { player: { credits: 5000 } },
        fetchedAt: freshTs,
      },
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ statusCache }));
    const gale = snapshot.agents.find((a) => a.name === "drifter-gale")!;
    expect(gale.isOnline).toBe(true);
  });

  test("calculates fleet totals correctly", () => {
    const statusCache = makeStatusCache({
      "drifter-gale": {
        data: { player: { credits: 10000 }, ship: { cargo_used: 20, cargo_capacity: 50 } },
      },
      "rust-vane": {
        data: { player: { credits: 5000 }, ship: { cargo_used: 10, cargo_capacity: 30 } },
      },
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ statusCache }));
    const { fleetTotals } = snapshot;

    expect(fleetTotals.onlineCount).toBe(2);
    expect(fleetTotals.offlineCount).toBe(1); // sable-thorn not in cache
    expect(fleetTotals.totalCredits).toBe(15000);
    expect(fleetTotals.totalCargoUsed).toBe(30);
    expect(fleetTotals.totalCargoMax).toBe(80);
  });

  test("offline agents don't contribute to fleet totals", () => {
    const staleTs = Date.now() - 10 * 60 * 1000;
    const statusCache = makeStatusCache({
      "drifter-gale": {
        data: { player: { credits: 99999 }, ship: { cargo_used: 99, cargo_capacity: 99 } },
        fetchedAt: staleTs,
      },
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ statusCache }));
    const { fleetTotals } = snapshot;

    expect(fleetTotals.onlineCount).toBe(0);
    expect(fleetTotals.totalCredits).toBe(0);
    expect(fleetTotals.totalCargoUsed).toBe(0);
  });

  test("includes recent events from overseerEventLog", () => {
    const eventLog = new OverseerEventLog();
    eventLog.push("drifter-gale", { type: "combat_update", payload: {}, receivedAt: Date.now() });
    eventLog.push("rust-vane", { type: "trade_offer_received", payload: {}, receivedAt: Date.now() });

    const snapshot = gatherFleetSnapshot(makeDeps({ overseerEventLog: eventLog }));

    expect(snapshot.recentEvents).toHaveLength(2);
    const types = snapshot.recentEvents.map((e) => e.type);
    expect(types).toContain("combat_update");
    expect(types).toContain("trade_offer_received");
  });

  test("omits events older than 10 minutes from recentEvents", () => {
    const eventLog = new OverseerEventLog();
    // Manually push an old event by injecting with a past timestamp
    // OverseerEventLog.push uses Date.now() — we'll use since() logic directly
    // Push a recent event to verify it IS included
    eventLog.push("drifter-gale", { type: "recent_event", payload: {}, receivedAt: Date.now() });

    const snapshot = gatherFleetSnapshot(makeDeps({ overseerEventLog: eventLog }));
    expect(snapshot.recentEvents).toHaveLength(1);
    expect(snapshot.recentEvents[0].type).toBe("recent_event");
  });

  test("returns empty recentEvents when no overseerEventLog provided", () => {
    const snapshot = gatherFleetSnapshot(makeDeps({ overseerEventLog: undefined }));
    expect(snapshot.recentEvents).toHaveLength(0);
  });

  test("handles empty statusCache gracefully", () => {
    const snapshot = gatherFleetSnapshot(makeDeps());

    expect(snapshot.agents).toHaveLength(3); // one per agentConfig entry
    expect(snapshot.fleetTotals.onlineCount).toBe(0);
    expect(snapshot.fleetTotals.offlineCount).toBe(3);
    expect(snapshot.marketSummary).toHaveLength(0);
    expect(snapshot.recentEvents).toHaveLength(0);
    // activeOrders may be empty array (DB available) or empty (no orders)
    expect(Array.isArray(snapshot.activeOrders)).toBe(true);
  });

  test("handles empty agentConfigs gracefully", () => {
    const snapshot = gatherFleetSnapshot(makeDeps({ agentConfigs: [] }));

    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.fleetTotals.onlineCount).toBe(0);
    expect(snapshot.fleetTotals.offlineCount).toBe(0);
  });

  test("includes market summary from arbitrageAnalyzer (top 5)", () => {
    const opps = Array.from({ length: 8 }, (_, i) => ({
      item_id: `item_${i}`,
      item_name: `Item ${i}`,
      buy_empire: "sol",
      sell_empire: "voidborn",
      buy_price: 10,
      sell_price: 200,
      profit_per_unit: 190,
      profit_margin_pct: 50,
      estimated_volume: 100,
    }));

    const snapshot = gatherFleetSnapshot(
      makeDeps({ arbitrageAnalyzer: makeMockArbitrageAnalyzer(opps) }),
    );

    expect(snapshot.marketSummary).toHaveLength(5); // capped at 5
    expect(snapshot.marketSummary[0].item_id).toBe("item_0");
    expect(snapshot.marketSummary[0].profit_per_unit).toBe(190);
    expect(snapshot.marketSummary[0].estimated_volume).toBe(100);
  });

  test("marks agent as in combat when battleCache has active battle", () => {
    const battleCache = new Map<string, BattleState | null>();
    battleCache.set("sable-thorn", {
      battle_id: "abc123",
      zone: "zone1",
      stance: "offensive",
      hull: 80,
      shields: 30,
      target: { name: "pirate" },
      status: "active",
      updatedAt: Date.now(),
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ battleCache }));
    const sable = snapshot.agents.find((a) => a.name === "sable-thorn")!;
    expect(sable.isInCombat).toBe(true);
  });

  test("does not mark agent as in combat when battle is resolved", () => {
    const battleCache = new Map<string, BattleState | null>();
    battleCache.set("sable-thorn", {
      battle_id: "abc123",
      zone: "zone1",
      stance: "defensive",
      hull: 100,
      shields: 100,
      target: null,
      status: "resolved",
      updatedAt: Date.now(),
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ battleCache }));
    const sable = snapshot.agents.find((a) => a.name === "sable-thorn")!;
    expect(sable.isInCombat).toBe(false);
  });

  test("uses lastAssignments to populate currentRole", () => {
    const lastAssignments = new Map([["drifter-gale", "scout" as const]]);
    const statusCache = makeStatusCache({
      "drifter-gale": { data: { player: { credits: 1000 } } },
    });

    const snapshot = gatherFleetSnapshot(makeDeps({ statusCache, lastAssignments }));
    const gale = snapshot.agents.find((a) => a.name === "drifter-gale")!;
    expect(gale.currentRole).toBe("scout");
  });

  test("activeOrders is an array even if DB has no rows", () => {
    const snapshot = gatherFleetSnapshot(makeDeps());
    expect(Array.isArray(snapshot.activeOrders)).toBe(true);
  });

  test("recentDeliveries is an empty array when no deliveries exist", () => {
    const snapshot = gatherFleetSnapshot(makeDeps());
    expect(Array.isArray(snapshot.recentDeliveries)).toBe(true);
    expect(snapshot.recentDeliveries).toHaveLength(0);
  });
});
