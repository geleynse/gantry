import { describe, it, expect } from "bun:test";
import { summarizeToolResult } from "./summarizers.js";

describe("summarizeToolResult", () => {
  it("extracts key fields from get_status", () => {
    const raw = {
      username: "Drifter Gale",
      credits: 5000,
      current_system: "SOL-001",
      current_poi: "Station Alpha",
      docked_at_base: true,
      ship: {
        name: "Windrunner",
        class_id: "scout",
        hull: 80, max_hull: 100,
        fuel: 50, max_fuel: 100,
        cargo_used: 3, cargo_capacity: 10,
        modules: [{ id: "laser", type: "weapon" }],
      },
      stats: { kills: 5, deaths: 2 },
      skill_xp: { mining: 100, combat: 50 },
      primary_color: "#ff0000",
      secondary_color: "#00ff00",
      status_message: "Exploring the cosmos",
      discovered_systems: ["SOL-001", "SOL-002", "SOL-003"],
      created_at: "2026-01-01T00:00:00Z",
      last_login_at: "2026-02-17T10:00:00Z",
    };
    const result = summarizeToolResult("get_status", raw) as Record<string, unknown>;
    expect(result.username).toBe("Drifter Gale");
    expect(result.credits).toBe(5000);
    expect(result.current_system).toBe("SOL-001");
    expect(result).toHaveProperty("ship");
    expect(result).toHaveProperty("stats");
    expect(result).toHaveProperty("discovered_systems");
    expect(result).toHaveProperty("status_message");
    // Extra fields are now preserved (robust discovery mode)
    expect(result).toHaveProperty("skill_xp");
    expect(result).not.toHaveProperty("created_at"); // strictly in SKIP_FIELDS
  });

  it("extracts key fields from get_system", () => {
    const raw = {
      id: "SOL-001", name: "Sol", empire: "federation",
      connections: ["SOL-002", "SOL-003"],
      pois: [{ id: "station-1", name: "Station Alpha", type: "station" }],
      police_level: 3,
      position: { x: 100, y: 200 },
      discovered_at: "2026-01-15T00:00:00Z",
    };
    const result = summarizeToolResult("get_system", raw) as Record<string, unknown>;
    expect(result.id).toBe("SOL-001");
    expect(result.name).toBe("Sol");
    expect(result).toHaveProperty("connections");
    expect(result).toHaveProperty("pois");
    const pois = result.pois as Record<string, unknown>[];
    expect(pois[0].id).toBe("station-1");
    expect(pois[0].name).toBe("Station Alpha");
    expect(result).toHaveProperty("position");
    // Extra fields are now preserved
    expect(result).toHaveProperty("discovered_at");
  });

  it("limits get_nearby to 10 entries", () => {
    const raw = {
      count: 15,
      nearby: Array.from({ length: 15 }, (_, i) => ({
        username: `Player${i}`, ship_class: "scout", in_combat: false,
        primary_color: "#000", status_message: "hi", last_seen: "2026-02-17T10:00:00Z",
      })),
    };
    const result = summarizeToolResult("get_nearby", raw) as Record<string, unknown>;
    const nearby = (result as { nearby: unknown[] }).nearby;
    expect(nearby).toHaveLength(10);
    expect(nearby[0]).not.toHaveProperty("primary_color");
    expect(nearby[0]).toHaveProperty("status_message");
  });

  it("applies generic summarizer to unknown tools", () => {
    const raw = {
      important: "data",
      created_at: "2026-01-01T00:00:00Z",
      primary_color: "#ff0000",
      description: "some long description",
    };
    const result = summarizeToolResult("unknown_tool", raw) as Record<string, unknown>;
    expect(result).toHaveProperty("important", "data");
    expect(result).not.toHaveProperty("created_at");
    expect(result).not.toHaveProperty("primary_color");
    expect(result).toHaveProperty("description");
  });

  it("passes through error responses unchanged", () => {
    const error = { error: { code: "not_docked", message: "You are not docked" } };
    const result = summarizeToolResult("get_status", error);
    expect(result).toEqual(error);
  });

  it("limits get_missions to 5 entries", () => {
    const raw = {
      missions: Array.from({ length: 10 }, (_, i) => ({
        id: `m${i}`, title: `Mission ${i}`, objectives: ["do stuff"],
        reward: { credits: 100 },
        description: "A very long mission description that takes tokens",
        created_at: "2026-01-01T00:00:00Z",
      })),
    };
    const result = summarizeToolResult("get_missions", raw) as Record<string, unknown>;
    const missions = (result as { missions: unknown[] }).missions;
    expect(missions).toHaveLength(5);
    // Fields are preserved even in limited arrays
    expect(missions[0]).toHaveProperty("description");
    expect(missions[0]).not.toHaveProperty("created_at");
  });

  it("limits view_market to 15 entries", () => {
    const raw = {
      orders: Array.from({ length: 20 }, (_, i) => ({
        id: `o${i}`, item_id: "iron", quantity: 10, price: 50, seller: `Player${i}`,
        created_at: "2026-01-01T00:00:00Z",
      })),
    };
    const result = summarizeToolResult("view_market", raw) as Record<string, unknown>;
    const orders = (result as { orders: unknown[] }).orders;
    expect(orders).toHaveLength(15);
    expect(orders[0]).not.toHaveProperty("created_at");
  });
});
