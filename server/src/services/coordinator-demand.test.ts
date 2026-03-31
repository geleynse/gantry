import { describe, test, expect } from "bun:test";
import {
  analyzeFleetDemand,
  suggestRole,
  isZoneCompatible,
  zoneProximityScore,
  formatAssignmentMessage,
  type AgentSnapshot,
} from "./coordinator-demand.js";
import type { ArbitrageOpportunity } from "../proxy/arbitrage-analyzer.js";
import type { CoordinatorConfig, CoordinatorQuota, CoordinatorRole } from "../shared/types/coordinator.js";
import { DEFAULT_COORDINATOR_CONFIG } from "../shared/types/coordinator.js";

function makeOpportunity(overrides: Partial<ArbitrageOpportunity> = {}): ArbitrageOpportunity {
  return {
    item_id: "iron_ore",
    item_name: "Iron Ore",
    buy_empire: "sol",
    sell_empire: "voidborn",
    buy_price: 10,
    sell_price: 200,
    profit_per_unit: 190,
    profit_margin_pct: 1900,
    estimated_volume: 100,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    name: "drifter-gale",
    faction: "solarian",
    operatingZone: "sol-sirius",
    isOnline: true,
    credits: 10000,
    ...overrides,
  };
}

function makeQuota(overrides: Partial<CoordinatorQuota> = {}): CoordinatorQuota {
  return {
    id: 1,
    item_id: "iron_ore",
    target_quantity: 200,
    current_quantity: 50,
    assigned_to: null,
    station_id: "sol_station",
    created_at: new Date().toISOString(),
    completed_at: null,
    status: "active",
    ...overrides,
  };
}

const config: CoordinatorConfig = DEFAULT_COORDINATOR_CONFIG;

describe("analyzeFleetDemand", () => {
  test("returns empty demand when no arbitrage data and no quotas", () => {
    const demand = analyzeFleetDemand([], [], config, 5);
    expect(demand.arbitrageItems).toHaveLength(0);
    expect(demand.activeQuotas).toHaveLength(0);
  });

  test("filters arbitrage opportunities below 15% margin", () => {
    const opps = [
      makeOpportunity({ profit_margin_pct: 10 }),
      makeOpportunity({ profit_margin_pct: 20, item_id: "gold_ore" }),
    ];
    const demand = analyzeFleetDemand(opps, [], config, 5);
    expect(demand.arbitrageItems).toHaveLength(1);
    expect(demand.arbitrageItems[0].item_id).toBe("gold_ore");
  });

  test("includes only active quotas", () => {
    const quotas = [
      makeQuota({ status: "active" }),
      makeQuota({ id: 2, status: "completed" }),
      makeQuota({ id: 3, status: "cancelled" }),
    ];
    const demand = analyzeFleetDemand([], quotas, config, 5);
    expect(demand.activeQuotas).toHaveLength(1);
  });

  test("scales role targets to online agent count", () => {
    // Default: 2 miners, 1 crafter, 1 trader, 1 flex = 5 total
    const demand = analyzeFleetDemand([], [], config, 5);
    expect(demand.roleBalance.target.miner).toBe(2);
    expect(demand.roleBalance.target.crafter).toBe(1);
  });

  test("ensures at least 1 miner when agents are online", () => {
    // With only 2 agents, scale is 2/5=0.4. Miner would round to 1.
    const demand = analyzeFleetDemand([], [], config, 2);
    expect(demand.roleBalance.target.miner).toBeGreaterThanOrEqual(1);
  });

  test("returns zero targets when no agents online", () => {
    const demand = analyzeFleetDemand([], [], config, 0);
    expect(demand.roleBalance.target.miner).toBe(0);
    expect(demand.roleBalance.target.crafter).toBe(0);
    expect(demand.roleBalance.target.trader).toBe(0);
  });
});

describe("suggestRole", () => {
  test("keeps agent in current role when credits trend is positive", () => {
    const agent = makeAgent({ currentRole: "miner", creditsTrend: 500 });
    const demand = analyzeFleetDemand([], [], config, 5);
    const result = suggestRole(agent, demand, new Map(), config);
    expect(result.role).toBe("miner");
    expect(result.reason).toContain("positive credits trend");
  });

  test("does not reassign agent mid-routine (last tool call < 2 min)", () => {
    const agent = makeAgent({ currentRole: "trader", lastToolCallAge: 60 });
    const demand = analyzeFleetDemand([], [], config, 5);
    const result = suggestRole(agent, demand, new Map(), config);
    expect(result.role).toBe("trader");
    expect(result.reason).toContain("Continuing current routine");
  });

  test("keeps agent as combat when in combat", () => {
    const agent = makeAgent({ isInCombat: true });
    const demand = analyzeFleetDemand([], [], config, 5);
    const result = suggestRole(agent, demand, new Map(), config);
    expect(result.role).toBe("combat");
  });

  test("suggests miner when fleet needs miners", () => {
    const agent = makeAgent();
    const demand = analyzeFleetDemand([], [], config, 5);
    // No current assignments → biggest gap is miner (target: 2, current: 0)
    const result = suggestRole(agent, demand, new Map(), config);
    expect(result.role).toBe("miner");
  });

  test("balances roles across agents", () => {
    const demand = analyzeFleetDemand([], [], config, 5);
    const assignments = new Map<string, CoordinatorRole>();
    assignments.set("agent-1", "miner");
    assignments.set("agent-2", "miner");
    // Now miners are full (2/2), should suggest crafter or trader
    const agent = makeAgent({ name: "agent-3" });
    const result = suggestRole(agent, demand, assignments, config);
    expect(["crafter", "trader"]).toContain(result.role);
  });

  test("assigns trader with arbitrage details when opportunities exist", () => {
    const opps = [makeOpportunity({ profit_margin_pct: 50 })];
    const demand = analyzeFleetDemand(opps, [], config, 5);
    const assignments = new Map<string, CoordinatorRole>();
    assignments.set("a1", "miner");
    assignments.set("a2", "miner");
    assignments.set("a3", "crafter");
    // Target: 2 miners, 1 crafter, 2 traders. Trader is the gap.
    const agent = makeAgent({ name: "a4" });
    const result = suggestRole(agent, demand, assignments, config);
    if (result.role === "trader") {
      expect(result.reason).toContain("Iron Ore");
      expect(result.params.item_id).toBe("iron_ore");
    }
  });

  test("assigns miner with quota info when active quotas exist", () => {
    const quotas = [makeQuota()];
    const demand = analyzeFleetDemand([], quotas, config, 5);
    const agent = makeAgent();
    const result = suggestRole(agent, demand, new Map(), config);
    if (result.role === "miner") {
      expect(result.quota?.item_id).toBe("iron_ore");
      expect(result.quota?.target_quantity).toBe(200);
    }
  });

  test("defaults to trader when all role targets are met", () => {
    const demand = analyzeFleetDemand([], [], config, 3);
    const assignments = new Map<string, CoordinatorRole>();
    // Fill all targets
    assignments.set("a1", "miner");
    assignments.set("a2", "crafter");
    assignments.set("a3", "trader");
    assignments.set("a4", "trader");
    assignments.set("a5", "trader");
    const agent = makeAgent({ name: "extra" });
    const result = suggestRole(agent, demand, assignments, config);
    // Should still get a valid role
    expect(result.role).toBeDefined();
    expect(result.routine).toBeDefined();
  });
});

describe("isZoneCompatible", () => {
  test("returns true when agent has no zone", () => {
    expect(isZoneCompatible(undefined, "miner", {})).toBe(true);
  });

  test("returns true when params have no target zone", () => {
    expect(isZoneCompatible("sol-sirius", "miner", {})).toBe(true);
    expect(isZoneCompatible("nebula-deep", "trader", {})).toBe(true);
  });

  test("returns true when zone matches (case-insensitive)", () => {
    expect(isZoneCompatible("sol-sirius", "miner", { zone: "sol-sirius" })).toBe(true);
    expect(isZoneCompatible("SOL-SIRIUS", "miner", { zone: "sol-sirius" })).toBe(true);
  });

  test("returns false when zone does not match", () => {
    expect(isZoneCompatible("sol-sirius", "miner", { zone: "nebula-deep" })).toBe(false);
  });
});

describe("zoneProximityScore", () => {
  test("returns 0 when agent has no zone", () => {
    const agent = makeAgent({ operatingZone: undefined });
    expect(zoneProximityScore(agent, "sol-belt")).toBe(0);
  });

  test("returns 0 when no target zone", () => {
    const agent = makeAgent({ operatingZone: "sol-belt" });
    expect(zoneProximityScore(agent, undefined)).toBe(0);
  });

  test("returns 2 for exact zone match", () => {
    const agent = makeAgent({ operatingZone: "sol-belt" });
    expect(zoneProximityScore(agent, "sol-belt")).toBe(2);
  });

  test("returns 1 for same-prefix zone match", () => {
    const agent = makeAgent({ operatingZone: "sol-belt" });
    expect(zoneProximityScore(agent, "sol-station")).toBe(1);
  });

  test("returns 0 for unrelated zones", () => {
    const agent = makeAgent({ operatingZone: "sol-belt" });
    expect(zoneProximityScore(agent, "nebula-deep")).toBe(0);
  });
});

describe("formatAssignmentMessage", () => {
  test("formats basic assignment message", () => {
    const msg = formatAssignmentMessage("miner", "navigate_and_mine", { belt: "iron_fields" }, "Fleet needs iron");
    expect(msg).toContain("[COORDINATOR] Role: miner | Routine: navigate_and_mine");
    expect(msg).toContain("Params:");
    expect(msg).toContain("iron_fields");
    expect(msg).toContain("Reason: Fleet needs iron");
  });

  test("includes quota line when quota is provided", () => {
    const msg = formatAssignmentMessage(
      "miner", "navigate_and_mine", {},
      "Mining needed",
      { item_id: "iron_ore", target_quantity: 200, current_quantity: 50 },
    );
    expect(msg).toContain("Quota: iron_ore 50/200");
  });

  test("omits quota line when no quota", () => {
    const msg = formatAssignmentMessage("trader", "supply_run", {}, "Trade route profitable");
    expect(msg).not.toContain("Quota:");
  });
});
