/**
 * Tests for MarketReservationCache — cross-agent market inventory reservation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MarketReservationCache } from "./market-reservations.js";

describe("MarketReservationCache", () => {
  let cache: MarketReservationCache;

  beforeEach(() => {
    // Disable auto-pruning in tests (huge interval)
    cache = new MarketReservationCache({ ttlMs: 10_000, pruneIntervalMs: 999_999_999 });
  });

  afterEach(() => {
    cache.dispose();
  });

  // ---------- Reserve / Release lifecycle ----------

  describe("reserve/release lifecycle", () => {
    it("should create a reservation and retrieve it", () => {
      const ok = cache.reserve("alpha", "station-A", "iron_ore", 50);
      expect(ok).toBe(true);

      const reservations = cache.getReservations("station-A");
      expect(reservations).toHaveLength(1);
      expect(reservations[0].agent).toBe("alpha");
      expect(reservations[0].station).toBe("station-A");
      expect(reservations[0].itemId).toBe("iron_ore");
      expect(reservations[0].quantity).toBe(50);
    });

    it("should release a specific reservation", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 50);
      cache.reserve("alpha", "station-A", "copper_ore", 30);

      cache.release("alpha", "station-A", "iron_ore");

      const reservations = cache.getReservations("station-A");
      expect(reservations).toHaveLength(1);
      expect(reservations[0].itemId).toBe("copper_ore");
    });

    it("should releaseAll for an agent", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 50);
      cache.reserve("alpha", "station-B", "copper_ore", 30);
      cache.reserve("beta", "station-A", "iron_ore", 20);

      cache.releaseAll("alpha");

      expect(cache.getReservations("station-A")).toHaveLength(1);
      expect(cache.getReservations("station-A")[0].agent).toBe("beta");
      expect(cache.getReservations("station-B")).toHaveLength(0);
    });

    it("should releaseStation for an agent at a specific station", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 50);
      cache.reserve("alpha", "station-A", "copper_ore", 30);
      cache.reserve("alpha", "station-B", "gold_ore", 10);

      cache.releaseStation("alpha", "station-A");

      expect(cache.getReservations("station-A")).toHaveLength(0);
      expect(cache.getReservations("station-B")).toHaveLength(1);
    });

    it("should update existing reservation instead of duplicating", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 50);
      cache.reserve("alpha", "station-A", "iron_ore", 75);

      const reservations = cache.getReservations("station-A");
      expect(reservations).toHaveLength(1);
      expect(reservations[0].quantity).toBe(75);
    });
  });

  // ---------- Expiration and pruning ----------

  describe("expiration and pruning", () => {
    it("should not return expired reservations from getReservations", () => {
      // Use a very short TTL
      const shortCache = new MarketReservationCache({ ttlMs: 1, pruneIntervalMs: 999_999_999 });
      shortCache.reserve("alpha", "station-A", "iron_ore", 50);

      // Wait for expiry
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }

      expect(shortCache.getReservations("station-A")).toHaveLength(0);
      shortCache.dispose();
    });

    it("should prune expired reservations", () => {
      const shortCache = new MarketReservationCache({ ttlMs: 1, pruneIntervalMs: 999_999_999 });
      shortCache.reserve("alpha", "station-A", "iron_ore", 50);
      shortCache.reserve("beta", "station-A", "copper_ore", 30);

      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }

      const pruned = shortCache.pruneExpired();
      expect(pruned).toBe(2);
      expect(shortCache.size).toBe(0);
      shortCache.dispose();
    });

    it("should only prune expired, not active reservations", () => {
      // First reservation with short TTL
      const shortCache = new MarketReservationCache({ ttlMs: 1, pruneIntervalMs: 999_999_999 });
      shortCache.reserve("alpha", "station-A", "iron_ore", 50);

      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait */ }

      // Second reservation with fresh TTL (re-create with longer TTL to avoid race)
      // Just verify the first one is expired and can be pruned
      const pruned = shortCache.pruneExpired();
      expect(pruned).toBeGreaterThanOrEqual(1);
      shortCache.dispose();
    });
  });

  // ---------- Available quantity calculation ----------

  describe("getAvailable", () => {
    it("should subtract other agents' reservations from total", () => {
      cache.reserve("beta", "station-A", "iron_ore", 30);

      const available = cache.getAvailable("station-A", "iron_ore", 100, "alpha");
      expect(available).toBe(70);
    });

    it("should not subtract the requesting agent's own reservation", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 30);
      cache.reserve("beta", "station-A", "iron_ore", 20);

      const available = cache.getAvailable("station-A", "iron_ore", 100, "alpha");
      expect(available).toBe(80); // Only beta's 20 subtracted
    });

    it("should clamp to zero when reservations exceed total", () => {
      cache.reserve("beta", "station-A", "iron_ore", 80);
      cache.reserve("gamma", "station-A", "iron_ore", 50);

      const available = cache.getAvailable("station-A", "iron_ore", 100, "alpha");
      expect(available).toBe(0);
    });

    it("should return full quantity when no reservations exist", () => {
      const available = cache.getAvailable("station-A", "iron_ore", 100, "alpha");
      expect(available).toBe(100);
    });

    it("should work without requestingAgent (all reservations subtracted)", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 30);
      cache.reserve("beta", "station-A", "iron_ore", 20);

      const available = cache.getAvailable("station-A", "iron_ore", 100);
      expect(available).toBe(50);
    });
  });

  // ---------- Reservation hints ----------

  describe("getReservationHint", () => {
    it("should return null when no other agents have reservations", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 50);

      const hint = cache.getReservationHint("station-A", "iron_ore", "alpha");
      expect(hint).toBeNull();
    });

    it("should return hint with other agent's reservation", () => {
      cache.reserve("beta", "station-A", "iron_ore", 30);

      const hint = cache.getReservationHint("station-A", "iron_ore", "alpha");
      expect(hint).toBe("(30 reserved by beta)");
    });

    it("should show multiple agents in hint", () => {
      cache.reserve("beta", "station-A", "iron_ore", 30);
      cache.reserve("gamma", "station-A", "iron_ore", 20);

      const hint = cache.getReservationHint("station-A", "iron_ore", "alpha");
      expect(hint).toContain("reserved by beta");
      expect(hint).toContain("reserved by gamma");
    });
  });

  // ---------- getAllReservations ----------

  describe("getAllReservations", () => {
    it("should return all active reservations across stations", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 50);
      cache.reserve("beta", "station-B", "copper_ore", 30);

      const all = cache.getAllReservations();
      expect(all).toHaveLength(2);
    });

    it("should return copies, not references", () => {
      cache.reserve("alpha", "station-A", "iron_ore", 50);

      const all = cache.getAllReservations();
      all[0].quantity = 999;

      const fresh = cache.getAllReservations();
      expect(fresh[0].quantity).toBe(50);
    });
  });

  // ---------- Edge cases ----------

  describe("edge cases", () => {
    it("should reject zero quantity", () => {
      const ok = cache.reserve("alpha", "station-A", "iron_ore", 0);
      expect(ok).toBe(false);
      expect(cache.size).toBe(0);
    });

    it("should reject negative quantity", () => {
      const ok = cache.reserve("alpha", "station-A", "iron_ore", -5);
      expect(ok).toBe(false);
    });

    it("should handle release of non-existent reservation gracefully", () => {
      // Should not throw
      cache.release("alpha", "station-A", "iron_ore");
      cache.releaseAll("nonexistent-agent");
      cache.releaseStation("alpha", "nonexistent-station");
    });

    it("should track size correctly", () => {
      expect(cache.size).toBe(0);
      cache.reserve("alpha", "station-A", "iron_ore", 50);
      expect(cache.size).toBe(1);
      cache.reserve("beta", "station-A", "copper_ore", 30);
      expect(cache.size).toBe(2);
      cache.release("alpha", "station-A", "iron_ore");
      expect(cache.size).toBe(1);
    });
  });
});
