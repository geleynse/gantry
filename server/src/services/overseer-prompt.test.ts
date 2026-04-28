import { describe, it, expect } from "bun:test";
import { buildSystemPrompt, buildUserPrompt } from "./overseer-prompt.js";
import type { FleetSnapshot } from "./coordinator-state.js";
import type { OverseerDecision } from "../shared/types/overseer.js";

function makeSnapshot(overrides?: Partial<FleetSnapshot>): FleetSnapshot {
  return {
    agents: [
      {
        name: "drifter-gale",
        role: "Leader/Scout",
        credits: 12500,
        system: "Sol",
        poi: "Earth Station",
        cargoUsed: 10,
        cargoMax: 50,
        fuel: 80,
        fuelMax: 100,
        isOnline: true,
        isInCombat: false,
      },
      {
        name: "sable-thorn",
        role: "Combat/Mining",
        credits: 3200,
        system: "Proxima",
        poi: undefined,
        cargoUsed: 25,
        cargoMax: 50,
        fuel: 45,
        fuelMax: 100,
        isOnline: true,
        isInCombat: true,
      },
    ],
    marketSummary: [
      {
        item_id: "iron",
        item_name: "Iron Ore",
        buy_empire: "Sol",
        sell_empire: "Proxima",
        profit_per_unit: 150,
        estimated_volume: 200,
      },
    ],
    activeOrders: [
      {
        id: 1,
        target_agent: "sable-thorn",
        message: "Go mine iron at the asteroid belt",
        priority: "high",
        expires_at: null,
        created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    ],
    recentDeliveries: [],
    recentEvents: [
      { agent: "drifter-gale", type: "docked", timestamp: Date.now() - 60000 },
      { agent: "sable-thorn", type: "combat_started", timestamp: Date.now() - 30000 },
    ],
    fleetTotals: {
      totalCredits: 15700,
      totalCargoUsed: 35,
      totalCargoMax: 100,
      onlineCount: 2,
      offlineCount: 0,
    },
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("includes role definition", () => {
    const prompt = buildSystemPrompt(5);
    expect(prompt).toContain("fleet overseer");
  });

  it("includes max actions number", () => {
    const prompt = buildSystemPrompt(3);
    expect(prompt).toContain("3");
  });

  it("mentions no_action", () => {
    const prompt = buildSystemPrompt(5);
    expect(prompt).toContain("no_action");
  });
});

describe("buildUserPrompt", () => {
  it("includes agent names and locations from snapshot", () => {
    const snapshot = makeSnapshot();
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("drifter-gale");
    expect(prompt).toContain("sable-thorn");
    expect(prompt).toContain("Earth Station");
    expect(prompt).toContain("Proxima");
  });

  it("includes formatted credits with comma separator", () => {
    const snapshot = makeSnapshot();
    const prompt = buildUserPrompt(snapshot, []);
    // 12,500 and 3,200 should be locale-formatted
    expect(prompt).toContain("12,500");
    expect(prompt).toContain("3,200");
  });

  it("includes market summary data", () => {
    const snapshot = makeSnapshot();
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("Iron Ore");
    expect(prompt).toContain("150");
  });

  it("includes fleet totals", () => {
    const snapshot = makeSnapshot();
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("15,700");
    expect(prompt).toContain("35/100");
  });

  it("includes previous decisions when provided", () => {
    const snapshot = makeSnapshot();
    const decisions: OverseerDecision[] = [
      {
        id: 1,
        tick_number: 7,
        triggered_by: "timer",
        snapshot_json: "{}",
        prompt_text: null,
        response_json: "{}",
        actions_json: JSON.stringify([{ type: "issue_order", params: { agent: "drifter-gale" } }]),
        results_json: "[]",
        model: "haiku",
        input_tokens: 500,
        output_tokens: 100,
        cost_estimate: 0.001,
        status: "success",
        duration_ms: 1200,
        created_at: new Date().toISOString(),
      },
    ];
    const prompt = buildUserPrompt(snapshot, decisions);
    expect(prompt).toContain("Tick 7");
    expect(prompt).toContain("timer");
    expect(prompt).toContain("issue_order");
  });

  it("handles empty fleet gracefully", () => {
    const snapshot = makeSnapshot({
      agents: [],
      marketSummary: [],
      activeOrders: [],
      recentEvents: [],
      fleetTotals: {
        totalCredits: 0,
        totalCargoUsed: 0,
        totalCargoMax: 0,
        onlineCount: 0,
        offlineCount: 0,
      },
    });
    expect(() => buildUserPrompt(snapshot, [])).not.toThrow();
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toBeTruthy();
  });

  it("shows AWAITING STATUS for online agent with no status data", () => {
    const snapshot = makeSnapshot({
      agents: [
        {
          name: "ghost-agent",
          role: "Trader",
          credits: undefined,
          system: undefined,
          poi: undefined,
          cargoUsed: undefined,
          cargoMax: undefined,
          fuel: undefined,
          fuelMax: undefined,
          isOnline: true,
          isInCombat: false,
        },
      ],
    });
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("AWAITING STATUS");
    expect(prompt).not.toContain("TRANSIT STUCK");
  });

  it("shows recently delivered orders when present", () => {
    const snapshot = makeSnapshot({
      recentDeliveries: [
        {
          target_agent: "rust-vane",
          message: "Go sell your cargo at the nearest station",
          delivered_at: "2026-03-22T14:32:00.000Z",
        },
      ],
    });
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("Recently Delivered Orders");
    expect(prompt).toContain("rust-vane");
    expect(prompt).toContain("Go sell your cargo at the nearest station");
    expect(prompt).toContain("14:32");
  });

  it("omits recently delivered orders section when empty", () => {
    const snapshot = makeSnapshot({ recentDeliveries: [] });
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).not.toContain("Recently Delivered Orders");
  });

  it("shows TRANSIT IDLE (not STUCK) for online agent in transit with cargo", () => {
    const snapshot = makeSnapshot({
      agents: [
        {
          name: "transit-agent",
          role: "Trader",
          credits: 5000,
          system: undefined,
          poi: undefined,
          cargoUsed: 10,
          cargoMax: 50,
          fuel: 80,
          fuelMax: 100,
          isOnline: true,
          isInCombat: false,
        },
      ],
    });
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("TRANSIT IDLE");
    expect(prompt).toContain("Do NOT stop_agent");
    expect(prompt).not.toContain("TRANSIT STUCK");
    expect(prompt).not.toContain("AWAITING STATUS");
  });

  it("shows TRANSIT STUCK for online agent in transit with no cargo", () => {
    const snapshot = makeSnapshot({
      agents: [
        {
          name: "empty-agent",
          role: "Trader",
          credits: 5000,
          system: undefined,
          poi: undefined,
          cargoUsed: 0,
          cargoMax: 50,
          fuel: 80,
          fuelMax: 100,
          isOnline: true,
          isInCombat: false,
        },
      ],
    });
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("TRANSIT STUCK");
    expect(prompt).not.toContain("TRANSIT IDLE");
  });

  it("shows TRANSIT STUCK when cargoUsed is undefined (no cargo data)", () => {
    const snapshot = makeSnapshot({
      agents: [
        {
          name: "no-cargo-data",
          role: "Trader",
          credits: 5000,
          system: undefined,
          poi: undefined,
          cargoUsed: undefined,
          cargoMax: undefined,
          fuel: 80,
          fuelMax: 100,
          isOnline: true,
          isInCombat: false,
        },
      ],
    });
    const prompt = buildUserPrompt(snapshot, []);
    expect(prompt).toContain("TRANSIT STUCK");
    expect(prompt).not.toContain("TRANSIT IDLE");
  });
});
