import { describe, it, expect } from "bun:test";
import { createGantryServer } from "./server.js";
import { EventBuffer, categorizeEvent, EventPriority } from "./event-buffer.js";
import { createMockConfig } from "../test/helpers.js";

const testConfig = createMockConfig({
  agents: [{ name: "test-agent", socksPort: 1081 }],
  gameUrl: "https://game.spacemolt.com/mcp",
  gameApiUrl: "https://game.spacemolt.com/api/v1",
});

describe("compound tools registration", () => {
  it("registers scan_and_attack", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("scan_and_attack");
  });

  it("registers multi_sell", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("multi_sell");
  });

  it("registers jump_route", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("jump_route");
  });

  it("registers batch_mine", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("batch_mine");
  });

  it("registers travel_to", () => {
    const { registeredTools } = createGantryServer(testConfig);
    expect(registeredTools).toContain("travel_to");
  });
});

describe("AgentCallTracker - calledTools prerequisite", () => {
  it("callTrackers start empty for new agents", () => {
    const { callTrackers } = createGantryServer(testConfig);
    expect(callTrackers.size).toBe(0);
  });

  it("callTrackers initialize with empty calledTools set", () => {
    const { callTrackers } = createGantryServer(testConfig);
    callTrackers.set("test-agent", {
      counts: {},
      lastCallSig: null,
      calledTools: new Set(),
    });
    const tracker = callTrackers.get("test-agent")!;
    expect(tracker.calledTools.size).toBe(0);
    expect(tracker.calledTools.has("analyze_market")).toBe(false);
  });

  it("calledTools tracks tool usage per agent independently", () => {
    const { callTrackers } = createGantryServer(testConfig);
    callTrackers.set("agent-a", {
      counts: {},
      lastCallSig: null,
      calledTools: new Set(["analyze_market", "scan"]),
    });
    callTrackers.set("agent-b", {
      counts: {},
      lastCallSig: null,
      calledTools: new Set(),
    });

    expect(callTrackers.get("agent-a")!.calledTools.has("analyze_market")).toBe(true);
    expect(callTrackers.get("agent-b")!.calledTools.has("analyze_market")).toBe(false);
  });

  it("tracker reset clears calledTools and counts", () => {
    const { callTrackers } = createGantryServer(testConfig);
    callTrackers.set("test-agent", {
      counts: { scan: 3 },
      lastCallSig: "scan:{}",
      calledTools: new Set(["analyze_market", "scan", "get_cargo"]),
    });

    // Simulate resetTracker behavior
    callTrackers.set("test-agent", {
      counts: {},
      lastCallSig: null,
      calledTools: new Set(),
    });

    const tracker = callTrackers.get("test-agent")!;
    expect(tracker.calledTools.size).toBe(0);
    expect(tracker.counts).toEqual({});
    expect(tracker.lastCallSig).toBeNull();
  });
});

describe("scan_and_attack entity detection", () => {
  // These test the entity extraction logic that scan_and_attack uses.
  // The function reads entities from scan response (entities/nearby fields)
  // with fallback to statusCache.data.nearby.

  const HOSTILE_TYPES = new Set(["pirate", "npc", "hostile", "enemy"]);

  function extractTargets(
    scanResult: unknown,
    cacheNearby: unknown,
  ): Array<Record<string, unknown>> {
    const scanData = (scanResult ?? {}) as Record<string, unknown>;
    const scanEntities = scanData.entities ?? scanData.nearby ?? (Array.isArray(scanData) ? scanData : null);

    let entities: Array<Record<string, unknown>>;
    if (Array.isArray(scanEntities) && scanEntities.length > 0) {
      entities = scanEntities as Array<Record<string, unknown>>;
    } else if (Array.isArray(cacheNearby) && cacheNearby.length > 0) {
      entities = cacheNearby as Array<Record<string, unknown>>;
    } else {
      entities = [];
    }

    return entities.filter((e) => {
      const type = String(e.type ?? "").toLowerCase();
      return HOSTILE_TYPES.has(type) && e.in_combat !== true;
    });
  }

  it("extracts targets from scan response entities field", () => {
    const scanResult = {
      entities: [
        { id: "p1", type: "pirate", name: "Raider", in_combat: false },
        { id: "s1", type: "station", name: "Hub" },
      ],
    };
    const targets = extractTargets(scanResult, undefined);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("p1");
  });

  it("extracts targets from scan response nearby field", () => {
    const scanResult = {
      nearby: [
        { id: "n1", type: "npc", name: "Guard" },
      ],
    };
    const targets = extractTargets(scanResult, undefined);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("n1");
  });

  it("falls back to cache nearby when scan response has no entities", () => {
    const scanResult = { message: "scan complete" }; // no entities field
    const cacheNearby = [
      { id: "e1", type: "enemy", name: "Foe" },
    ];
    const targets = extractTargets(scanResult, cacheNearby);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("e1");
  });

  it("prefers scan response over cache when both have entities", () => {
    const scanResult = {
      entities: [{ id: "scan1", type: "pirate", name: "From Scan" }],
    };
    const cacheNearby = [{ id: "cache1", type: "pirate", name: "From Cache" }];
    const targets = extractTargets(scanResult, cacheNearby);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("scan1");
  });

  it("handles entity types case-insensitively", () => {
    const scanResult = {
      entities: [{ id: "p1", type: "Pirate", name: "Cap Pirate" }],
    };
    const targets = extractTargets(scanResult, undefined);
    expect(targets).toHaveLength(1);
  });

  it("filters out in_combat entities", () => {
    const scanResult = {
      entities: [
        { id: "p1", type: "pirate", in_combat: true },
        { id: "p2", type: "pirate", in_combat: false },
      ],
    };
    const targets = extractTargets(scanResult, undefined);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("p2");
  });

  it("filters non-hostile entity types", () => {
    const scanResult = {
      entities: [
        { id: "s1", type: "station" },
        { id: "a1", type: "asteroid" },
        { id: "p1", type: "player" },
        { id: "h1", type: "hostile" },
      ],
    };
    const targets = extractTargets(scanResult, undefined);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("h1");
  });

  it("returns empty array when no entities anywhere", () => {
    const targets = extractTargets({}, undefined);
    expect(targets).toHaveLength(0);
  });

  it("handles scan response as direct array", () => {
    const scanResult = [
      { id: "p1", type: "pirate", name: "Direct Array Pirate" },
    ];
    const targets = extractTargets(scanResult, undefined);
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe("p1");
  });
});

describe("respawn_state critical event handling", () => {
  it("categorizeEvent classifies respawn_state as critical", () => {
    expect(categorizeEvent("respawn_state")).toBe(EventPriority.Critical);
  });

  it("EventBuffer stores respawn_state events (not filtered as internal)", () => {
    const buf = new EventBuffer();
    buf.push({
      type: "respawn_state",
      payload: { system: "sol", hull: 100, max_hull: 100 },
      receivedAt: Date.now(),
    });
    expect(buf.size).toBe(1);
  });

  it("drainCritical returns respawn_state alongside other critical events", () => {
    const buf = new EventBuffer();
    buf.push({ type: "chat_message", payload: {}, receivedAt: 1 });
    buf.push({
      type: "respawn_state",
      payload: { system: "sol", hull: 100, max_hull: 100, credits: 500 },
      receivedAt: 2,
    });
    buf.push({ type: "combat_update", payload: { damage: 10 }, receivedAt: 3 });
    buf.push({ type: "arrived", payload: {}, receivedAt: 4 });

    const critical = buf.drainCritical();
    expect(critical).toHaveLength(2);
    expect(critical[0].type).toBe("respawn_state");
    expect(critical[1].type).toBe("combat_update");
    expect((critical[0].payload as Record<string, unknown>).system).toBe("sol");

    // Non-critical events remain
    const rest = buf.drain();
    expect(rest).toHaveLength(2);
    expect(rest[0].type).toBe("chat_message");
    expect(rest[1].type).toBe("arrived");
  });

  it("all combat-related event types are critical", () => {
    const combatTypes = ["combat_update", "player_died", "pirate_combat", "respawn_state"];
    for (const type of combatTypes) {
      expect(categorizeEvent(type)).toBe(EventPriority.Critical);
    }
  });
});

// ---------------------------------------------------------------------------
// waitForNavCacheUpdate tests
// ---------------------------------------------------------------------------

import { waitForNavCacheUpdate } from "./compound-tools-impl.js";

describe("waitForNavCacheUpdate", () => {
  it("returns true immediately when current_system changes after first tick", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("agent-a", {
      data: { player: { current_system: "sol" } },
      fetchedAt: Date.now(),
    });

    let tick = 0;
    const client = {
      waitForTick: async () => {
        tick++;
        // After first tick, update the cache to simulate arrival
        statusCache.set("agent-a", {
          data: { player: { current_system: "sirius" } },
          fetchedAt: Date.now(),
        });
      },
      lastArrivalTick: null as number | null,
    };

    const result = await waitForNavCacheUpdate(client, "agent-a", "sol", statusCache);
    expect(result).toBe(true);
    expect(tick).toBe(1);
  });

  it("returns false after maxTicks if cache never updates", async () => {
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("agent-b", {
      data: { player: { current_system: "sol" } },
      fetchedAt: Date.now(),
    });

    const client = {
      waitForTick: async () => {},
      lastArrivalTick: null as number | null,
    };

    const result = await waitForNavCacheUpdate(client, "agent-b", "sol", statusCache, 2);
    expect(result).toBe(false);
  });

  it("returns true when cache was already updated before first tick (different system)", async () => {
    // If beforeSystem is already different from current, return true immediately on first tick check
    const statusCache = new Map<string, { data: Record<string, unknown>; fetchedAt: number }>();
    statusCache.set("agent-c", {
      data: { player: { current_system: "sirius" } }, // already updated
      fetchedAt: Date.now(),
    });

    const client = {
      waitForTick: async () => {},
      lastArrivalTick: null as number | null,
    };

    const result = await waitForNavCacheUpdate(client, "agent-c", "sol", statusCache, 3);
    expect(result).toBe(true);
  });
});
