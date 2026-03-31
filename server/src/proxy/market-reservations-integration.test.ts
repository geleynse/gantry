/**
 * Integration tests for market reservation wiring in passthrough-handler.
 *
 * Verifies that:
 * - analyze_market responses get reservation annotations
 * - buy/sell auto-creates reservations
 * - Navigation releases station reservations
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { handlePassthrough, type PassthroughDeps, type PassthroughClient } from "./passthrough-handler.js";
import { MarketReservationCache } from "./market-reservations.js";
import { MarketCache } from "./market-cache.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(executeResult: unknown = { status: "ok" }): PassthroughClient {
  return {
    execute: async () => ({ result: executeResult }),
    waitForTick: async () => {},
    lastArrivalTick: null,
  };
}

function createTestDeps(overrides: Partial<PassthroughDeps> = {}): PassthroughDeps {
  return {
    statusCache: new Map(),
    marketCache: new MarketCache("http://localhost:9999/unused", 999_999_999),
    gameHealthRef: { current: null },
    stateChangingTools: new Set(["buy", "sell", "create_sell_order", "create_buy_order", "jump", "travel"]),
    waitForNavCacheUpdate: async () => true,
    waitForDockCacheUpdate: async () => true,
    decontaminateLog: (r: unknown) => r,
    stripPendingFields: () => {},
    withInjections: async (_agent, response) => response,
    marketReservations: new MarketReservationCache({ ttlMs: 60_000, pruneIntervalMs: 999_999_999 }),
    ...overrides,
  };
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

describe("Market reservation pipeline integration", () => {
  let deps: PassthroughDeps;

  beforeEach(() => {
    deps = createTestDeps();
  });

  afterEach(() => {
    deps.marketReservations?.dispose();
  });

  // ---------- analyze_market annotation ----------

  describe("analyze_market reservation annotations", () => {
    it("should annotate recommendations with reservation hints", async () => {
      // Set up: beta has a reservation for iron_ore at station-A
      deps.marketReservations!.reserve("beta", "station-A", "iron_ore", 30);

      // Set agent's location in statusCache
      deps.statusCache.set("alpha", {
        data: { player: { current_poi: "station-A", current_system: "Sol" } },
        fetchedAt: Date.now(),
      });

      // Mock analyze_market response
      const client = createMockClient({
        recommendations: [
          { item_id: "iron_ore", quantity: 100, estimated_value: 50 },
          { item_id: "copper_ore", quantity: 50, estimated_value: 30 },
        ],
      });

      const result = await handlePassthrough(
        deps, client, "alpha", "analyze_market", "analyze_market",
      );
      const parsed = parseResult(result);

      // iron_ore should have reservation hint
      const ironRec = parsed.recommendations.find((r: any) => r.item_id === "iron_ore");
      expect(ironRec._reservation).toBe("(30 reserved by beta)");
      expect(ironRec._available).toBe(70);

      // copper_ore should have no reservation hint
      const copperRec = parsed.recommendations.find((r: any) => r.item_id === "copper_ore");
      expect(copperRec._reservation).toBeUndefined();
    });

    it("should not annotate when no reservations exist", async () => {
      deps.statusCache.set("alpha", {
        data: { player: { current_poi: "station-A", current_system: "Sol" } },
        fetchedAt: Date.now(),
      });

      const client = createMockClient({
        recommendations: [
          { item_id: "iron_ore", quantity: 100, estimated_value: 50 },
        ],
      });

      const result = await handlePassthrough(
        deps, client, "alpha", "analyze_market", "analyze_market",
      );
      const parsed = parseResult(result);

      const rec = parsed.recommendations[0];
      expect(rec._reservation).toBeUndefined();
      expect(rec._available).toBeUndefined();
    });
  });

  // ---------- Auto-reserve on buy/sell ----------

  describe("auto-reserve on buy/sell", () => {
    it("should create a reservation when buy succeeds", async () => {
      deps.statusCache.set("alpha", {
        data: { player: { current_poi: "station-A", current_system: "Sol" } },
        fetchedAt: Date.now(),
      });

      const client = createMockClient({ status: "completed", purchased: 10 });

      await handlePassthrough(
        deps, client, "alpha", "buy", "buy",
        { item_id: "iron_ore", quantity: 10 },
      );

      const reservations = deps.marketReservations!.getReservations("station-A");
      expect(reservations).toHaveLength(1);
      expect(reservations[0].agent).toBe("alpha");
      expect(reservations[0].itemId).toBe("iron_ore");
      expect(reservations[0].quantity).toBe(10);
    });

    it("should not create reservation when buy returns error", async () => {
      deps.statusCache.set("alpha", {
        data: { player: { current_poi: "station-A", current_system: "Sol" } },
        fetchedAt: Date.now(),
      });

      const client: PassthroughClient = {
        execute: async () => ({ error: { code: "insufficient_funds", message: "Not enough credits" } }),
        waitForTick: async () => {},
        lastArrivalTick: null,
      };

      await handlePassthrough(
        deps, client, "alpha", "buy", "buy",
        { item_id: "iron_ore", quantity: 10 },
      );

      expect(deps.marketReservations!.getReservations("station-A")).toHaveLength(0);
    });
  });

  // ---------- Nav releases station reservations ----------

  describe("navigation releases station reservations", () => {
    it("should release station reservations when agent travels", async () => {
      deps.marketReservations!.reserve("alpha", "station-A", "iron_ore", 50);

      deps.statusCache.set("alpha", {
        data: { player: { current_poi: "station-A", current_system: "Sol" } },
        fetchedAt: Date.now(),
      });

      const client = createMockClient({ status: "completed" });

      await handlePassthrough(
        deps, client, "alpha", "travel", "travel",
        { destination_id: "station-B" },
        "station-B",
      );

      expect(deps.marketReservations!.getReservations("station-A")).toHaveLength(0);
    });

    it("should not release other agents' reservations on travel", async () => {
      deps.marketReservations!.reserve("alpha", "station-A", "iron_ore", 50);
      deps.marketReservations!.reserve("beta", "station-A", "iron_ore", 30);

      deps.statusCache.set("alpha", {
        data: { player: { current_poi: "station-A", current_system: "Sol" } },
        fetchedAt: Date.now(),
      });

      const client = createMockClient({ status: "completed" });

      await handlePassthrough(
        deps, client, "alpha", "travel", "travel",
        { destination_id: "station-B" },
        "station-B",
      );

      // Alpha's reservation gone, beta's remains
      const remaining = deps.marketReservations!.getReservations("station-A");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].agent).toBe("beta");
    });
  });
});
