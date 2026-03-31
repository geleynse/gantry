import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createDatabase, getDb, closeDb } from "../services/database.js";
import { persistGameState, persistBattleState, persistCallTracker, restoreAllCaches } from "./cache-persistence.js";

describe("cache-persistence", () => {
  beforeEach(() => {
    createDatabase(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  describe("persistGameState", () => {
    it("inserts state into proxy_game_state", async () => {
      const state = { data: { player: { credits: 100 } }, fetchedAt: 1000 };
      await persistGameState("test-agent", state);
      const db = getDb();
      const row = db.prepare("SELECT state_json FROM proxy_game_state WHERE agent = ?").get("test-agent") as { state_json: string } | undefined;
      expect(row).toBeDefined();
      const parsed = JSON.parse(row!.state_json);
      expect(parsed.data.player.credits).toBe(100);
      expect(parsed.fetchedAt).toBe(1000);
    });

    it("upserts on repeated persist", async () => {
      await persistGameState("test-agent", { data: { player: { credits: 50 } }, fetchedAt: 1 });
      await persistGameState("test-agent", { data: { player: { credits: 999 } }, fetchedAt: 2 });
      const db = getDb();
      const row = db.prepare("SELECT state_json FROM proxy_game_state WHERE agent = ?").get("test-agent") as { state_json: string };
      expect(JSON.parse(row.state_json).data.player.credits).toBe(999);
    });

    it("silently handles db failure", async () => {
      closeDb();
      // getDb() will throw, but persistGameState should handle it gracefully
      await expect(persistGameState("test-agent", { data: {}, fetchedAt: 0 })).resolves.toBeUndefined();
      createDatabase(":memory:");
    });
  });

  describe("persistBattleState", () => {
    it("inserts battle state", async () => {
      const battle = { battle_id: "b1", zone: "outer", stance: "aggressive", hull: 90, shields: 50, target: {}, status: "active", updatedAt: 1 };
      await persistBattleState("test-agent", battle);
      const db = getDb();
      const row = db.prepare("SELECT battle_json FROM proxy_battle_state WHERE agent = ?").get("test-agent") as { battle_json: string };
      expect(JSON.parse(row.battle_json).battle_id).toBe("b1");
    });

    it("stores null for cleared battle", async () => {
      await persistBattleState("test-agent", null);
      const db = getDb();
      const row = db.prepare("SELECT battle_json FROM proxy_battle_state WHERE agent = ?").get("test-agent") as { battle_json: string | null };
      expect(row).toBeDefined();
      expect(row.battle_json).toBeNull();
    });
  });

  describe("persistCallTracker", () => {
    it("serializes Set to array in JSON", async () => {
      await persistCallTracker("test-agent", {
        counts: { mine: 3 },
        lastCallSig: "mine:3",
        calledTools: new Set(["scan", "mine"]),
      });
      const db = getDb();
      const row = db.prepare("SELECT counts_json, last_call_sig, called_tools_json FROM proxy_call_trackers WHERE agent = ?").get("test-agent") as {
        counts_json: string;
        last_call_sig: string;
        called_tools_json: string;
      };
      expect(JSON.parse(row.counts_json).mine).toBe(3);
      expect(row.last_call_sig).toBe("mine:3");
      const tools = JSON.parse(row.called_tools_json) as string[];
      expect(tools).toContain("scan");
      expect(tools).toContain("mine");
    });

    it("silently handles failure", async () => {
      closeDb();
      await expect(
        persistCallTracker("test-agent", { counts: {}, lastCallSig: null, calledTools: new Set() }),
      ).resolves.toBeUndefined();
      createDatabase(":memory:");
    });
  });

  // Full state fixture matching the shape produced by onStateUpdate / refreshStatus
  const FULL_STATE = {
    data: {
      tick: 42,
      player: {
        username: "drifter-gale",
        credits: 5000,
        current_system: "Krynn",
        current_poi: "Krynn Station Alpha",
        docked_at_base: "Krynn Station Alpha",
        home_system: "Solara",
        home_poi: "Solara Base",
        skills: { mining: { name: "Mining", level: 5, xp: 1200, xp_to_next: 800 } },
      },
      ship: {
        name: "Drifter",
        class_id: "scout",
        hull: 95,
        max_hull: 100,
        shield: 40,
        max_shield: 50,
        fuel: 80,
        max_fuel: 100,
        cargo_used: 10,
        cargo_capacity: 100,
        modules: [{ slot_type: "weapon", item_id: "laser-1", item_name: "Basic Laser" }],
        cargo: [{ item_id: "iron-ore", name: "Iron Ore", quantity: 10 }],
      },
      in_combat: false,
    },
    fetchedAt: 1700000000000,
  };

  describe("restoreAllCaches", () => {
    it("populates maps from database with all fields", async () => {
      const db = getDb();
      db.prepare("INSERT OR REPLACE INTO proxy_game_state (agent, state_json) VALUES (?, ?)").run(
        "agent-a", JSON.stringify(FULL_STATE)
      );
      db.prepare("INSERT OR REPLACE INTO proxy_battle_state (agent, battle_json) VALUES (?, ?)").run(
        "agent-a", JSON.stringify({ battle_id: "b1", zone: "outer", stance: "aggressive", hull: 90, shields: 50, target: {}, status: "active", updatedAt: 1 })
      );
      db.prepare("INSERT OR REPLACE INTO proxy_call_trackers (agent, counts_json, last_call_sig, called_tools_json) VALUES (?, ?, ?, ?)").run(
        "agent-a", JSON.stringify({ mine: 2 }), null, JSON.stringify(["scan"])
      );

      const statusCache = new Map();
      const battleCache = new Map();
      const callTrackers = new Map();
      await restoreAllCaches(statusCache, battleCache, callTrackers);

      expect(statusCache.has("agent-a")).toBe(true);
      const restored = statusCache.get("agent-a");
      const player = restored.data.player as Record<string, unknown>;
      const ship = restored.data.ship as Record<string, unknown>;

      // Core player fields
      expect(player.credits).toBe(5000);
      expect(player.current_system).toBe("Krynn");
      expect(player.current_poi).toBe("Krynn Station Alpha");
      expect(player.docked_at_base).toBe("Krynn Station Alpha");
      expect(player.home_system).toBe("Solara");

      // Ship fields
      expect(ship.hull).toBe(95);
      expect(ship.max_hull).toBe(100);
      expect(ship.fuel).toBe(80);
      expect(ship.max_fuel).toBe(100);
      expect(ship.shield).toBe(40);
      expect(ship.cargo_used).toBe(10);
      expect(ship.cargo_capacity).toBe(100);

      // Nested data
      expect((player.skills as Record<string, any>).mining.level).toBe(5);
      expect((ship.cargo as any[]).length).toBe(1);
      expect((ship.modules as any[]).length).toBe(1);

      // Metadata
      expect(restored.data.tick).toBe(42);
      expect(restored.data.in_combat).toBe(false);
      expect(restored.fetchedAt).toBe(1700000000000);

      // Battle + call trackers
      expect(battleCache.get("agent-a")?.battle_id).toBe("b1");
      expect(callTrackers.get("agent-a")?.calledTools).toBeInstanceOf(Set);
      expect(callTrackers.get("agent-a")?.calledTools.has("scan")).toBe(true);
    });

    it("handles database unavailable gracefully", async () => {
      closeDb();
      const statusCache = new Map();
      const battleCache = new Map();
      const callTrackers = new Map();
      await expect(restoreAllCaches(statusCache, battleCache, callTrackers)).resolves.toBeUndefined();
      expect(statusCache.size).toBe(0);
      createDatabase(":memory:");
    });

    it("handles empty tables gracefully", async () => {
      const statusCache = new Map();
      const battleCache = new Map();
      const callTrackers = new Map();
      await restoreAllCaches(statusCache, battleCache, callTrackers);
      expect(statusCache.size).toBe(0);
      expect(battleCache.size).toBe(0);
      expect(callTrackers.size).toBe(0);
    });

    it("persist then restore round-trip preserves all fields", async () => {
      // Persist via the normal code path (same as onStateUpdate → throttledPersistGameState)
      await persistGameState("round-trip-agent", FULL_STATE);

      const statusCache = new Map();
      const battleCache = new Map();
      const callTrackers = new Map();
      await restoreAllCaches(statusCache, battleCache, callTrackers);

      const restored = statusCache.get("round-trip-agent");
      expect(restored).toBeDefined();

      // Deep equality — the entire state blob should survive the round-trip unchanged
      expect(restored.data).toEqual(FULL_STATE.data);
      expect(restored.fetchedAt).toBe(FULL_STATE.fetchedAt);
    });

    it("restored state works with STATUS_SLICE_EXTRACTORS", async () => {
      // Verify that restored data is compatible with cached-queries extractors
      await persistGameState("extractor-agent", FULL_STATE);

      const statusCache = new Map();
      await restoreAllCaches(statusCache, new Map(), new Map());

      const entry = statusCache.get("extractor-agent")!;
      const data = entry.data;

      // Simulate what get_location extractor does
      const player = (data.player ?? data) as Record<string, unknown>;
      expect(player.current_system).toBe("Krynn");
      expect(player.current_poi).toBe("Krynn Station Alpha");
      expect(player.docked_at_base).toBe("Krynn Station Alpha");

      // Simulate what get_fuel extractor does
      const ship = (data.ship ?? data) as Record<string, unknown>;
      expect(ship.fuel).toBe(80);
      expect(ship.max_fuel).toBe(100);

      // Simulate what get_health extractor does
      expect(ship.hull).toBe(95);
      expect(ship.max_hull).toBe(100);

      // Simulate what get_credits extractor does
      expect(player.credits).toBe(5000);

      // Simulate what get_cargo_summary extractor does
      expect(ship.cargo_used).toBe(10);
      expect(ship.cargo_capacity).toBe(100);
      expect(Array.isArray(ship.cargo)).toBe(true);
    });

    it("restores multiple agents independently", async () => {
      const state1 = { data: { player: { credits: 100, current_system: "Alpha" }, ship: { fuel: 50 } }, fetchedAt: 1 };
      const state2 = { data: { player: { credits: 999, current_system: "Beta" }, ship: { fuel: 90 } }, fetchedAt: 2 };
      await persistGameState("agent-1", state1);
      await persistGameState("agent-2", state2);

      const statusCache = new Map();
      await restoreAllCaches(statusCache, new Map(), new Map());

      expect(statusCache.size).toBe(2);
      expect((statusCache.get("agent-1").data.player as any).current_system).toBe("Alpha");
      expect((statusCache.get("agent-2").data.player as any).current_system).toBe("Beta");
      expect((statusCache.get("agent-1").data.ship as any).fuel).toBe(50);
      expect((statusCache.get("agent-2").data.ship as any).fuel).toBe(90);
    });

    it("restores battle null state correctly", async () => {
      const db = getDb();
      db.prepare("INSERT OR REPLACE INTO proxy_battle_state (agent, battle_json) VALUES (?, ?)").run("agent-b", null);
      const statusCache = new Map();
      const battleCache = new Map();
      const callTrackers = new Map();
      await restoreAllCaches(statusCache, battleCache, callTrackers);
      expect(battleCache.has("agent-b")).toBe(true);
      expect(battleCache.get("agent-b")).toBeNull();
    });
  });
});
