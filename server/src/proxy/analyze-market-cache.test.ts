/**
 * Tests for AnalyzeMarketCache — cross-agent analyze_market and view_market result caching.
 *
 * Covers: hit/miss/expiry, cache store, invalidation by trade tools,
 * freshness annotation, metrics (per-tool and combined), prune, and view_market support.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { AnalyzeMarketCache, CACHE_INVALIDATING_TOOLS } from "./analyze-market-cache.js";

describe("AnalyzeMarketCache", () => {
  let cache: AnalyzeMarketCache;

  beforeEach(() => {
    // Short TTL for expiry tests
    cache = new AnalyzeMarketCache(500);
  });

  // ---------------------------------------------------------------------------
  // Basic hit / miss (analyze_market — backward compat)
  // ---------------------------------------------------------------------------

  describe("get/set", () => {
    it("returns null on cache miss", () => {
      const result = cache.get("sol", "earth_station");
      expect(result).toBeNull();
    });

    it("returns cached entry on hit", () => {
      cache.set("sol", "earth_station", '{"recommendations":[]}', "agent-a");
      const hit = cache.get("sol", "earth_station");
      expect(hit).not.toBeNull();
      expect(hit!.result).toBe('{"recommendations":[]}');
      expect(hit!.agent).toBe("agent-a");
      expect(hit!.station).toBe("earth_station");
      expect(hit!.ageMs).toBeGreaterThanOrEqual(0);
    });

    it("is keyed by system+station — different stations are separate entries", () => {
      cache.set("sol", "earth_station", '{"a":1}', "agent-a");
      cache.set("sol", "mars_station", '{"b":2}', "agent-b");

      const earthHit = cache.get("sol", "earth_station");
      const marsHit = cache.get("sol", "mars_station");

      expect(earthHit!.result).toBe('{"a":1}');
      expect(marsHit!.result).toBe('{"b":2}');
    });

    it("is keyed by system — same station name in different systems are separate", () => {
      cache.set("sol", "trade_hub", '{"sol":true}', "agent-a");
      cache.set("alpha-centauri", "trade_hub", '{"ac":true}', "agent-b");

      expect(cache.get("sol", "trade_hub")!.result).toBe('{"sol":true}');
      expect(cache.get("alpha-centauri", "trade_hub")!.result).toBe('{"ac":true}');
    });

    it("overwrites existing entry on re-set (refresh)", () => {
      cache.set("sol", "earth_station", '{"old":true}', "agent-a");
      cache.set("sol", "earth_station", '{"new":true}', "agent-b");

      const hit = cache.get("sol", "earth_station");
      expect(hit!.result).toBe('{"new":true}');
      expect(hit!.agent).toBe("agent-b");
    });
  });

  // ---------------------------------------------------------------------------
  // view_market support
  // ---------------------------------------------------------------------------

  describe("view_market caching", () => {
    it("caches view_market separately from analyze_market", () => {
      cache.set("sol", "earth_station", '{"analyze":true}', "agent-a", "analyze_market");
      cache.set("sol", "earth_station", '{"view":true}', "agent-b", "view_market");

      const analyzeHit = cache.get("sol", "earth_station", "analyze_market");
      const viewHit = cache.get("sol", "earth_station", "view_market");

      expect(analyzeHit!.result).toBe('{"analyze":true}');
      expect(viewHit!.result).toBe('{"view":true}');
      expect(analyzeHit!.agent).toBe("agent-a");
      expect(viewHit!.agent).toBe("agent-b");
    });

    it("returns null for view_market when only analyze_market is cached", () => {
      cache.set("sol", "earth_station", '{"analyze":true}', "agent-a", "analyze_market");
      const viewHit = cache.get("sol", "earth_station", "view_market");
      expect(viewHit).toBeNull();
    });

    it("returns null for analyze_market when only view_market is cached", () => {
      cache.set("sol", "earth_station", '{"view":true}', "agent-a", "view_market");
      const analyzeHit = cache.get("sol", "earth_station", "analyze_market");
      expect(analyzeHit).toBeNull();
    });

    it("stores toolType in the entry", () => {
      cache.set("sol", "earth_station", '{}', "agent-a", "view_market");
      const hit = cache.get("sol", "earth_station", "view_market");
      expect(hit!.toolType).toBe("view_market");
    });

    it("defaults to analyze_market when toolType is omitted", () => {
      cache.set("sol", "earth_station", '{}', "agent-a");
      const hit = cache.get("sol", "earth_station");
      expect(hit!.toolType).toBe("analyze_market");
    });
  });

  // ---------------------------------------------------------------------------
  // TTL / expiry
  // ---------------------------------------------------------------------------

  describe("TTL expiry", () => {
    it("returns null after TTL expires", async () => {
      cache.set("sol", "earth_station", '{"x":1}', "agent-a");
      // Wait for TTL to pass (500ms in test)
      await new Promise<void>((resolve) => setTimeout(resolve, 550));
      const result = cache.get("sol", "earth_station");
      expect(result).toBeNull();
    });

    it("returns entry before TTL expires", async () => {
      cache.set("sol", "earth_station", '{"x":1}', "agent-a");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const result = cache.get("sol", "earth_station");
      expect(result).not.toBeNull();
    });

    it("expires view_market independently", async () => {
      cache.set("sol", "earth_station", '{}', "agent-a", "view_market");
      await new Promise<void>((r) => setTimeout(r, 550));
      expect(cache.get("sol", "earth_station", "view_market")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Invalidation
  // ---------------------------------------------------------------------------

  describe("invalidate", () => {
    it("removes entry for the given station", () => {
      cache.set("sol", "earth_station", '{"data":1}', "agent-a");
      cache.invalidate("sol", "earth_station", "buy");
      expect(cache.get("sol", "earth_station")).toBeNull();
    });

    it("removes both analyze_market and view_market entries on invalidation", () => {
      cache.set("sol", "earth_station", '{"analyze":1}', "agent-a", "analyze_market");
      cache.set("sol", "earth_station", '{"view":1}', "agent-b", "view_market");

      cache.invalidate("sol", "earth_station", "sell");

      expect(cache.get("sol", "earth_station", "analyze_market")).toBeNull();
      expect(cache.get("sol", "earth_station", "view_market")).toBeNull();
    });

    it("does not affect entries for other stations", () => {
      cache.set("sol", "earth_station", '{"earth":1}', "agent-a");
      cache.set("sol", "mars_station", '{"mars":1}', "agent-b");

      cache.invalidate("sol", "earth_station", "sell");

      expect(cache.get("sol", "earth_station")).toBeNull();
      expect(cache.get("sol", "mars_station")).not.toBeNull();
    });

    it("does not affect entries for same station name in different systems", () => {
      cache.set("sol", "trade_hub", '{"sol":1}', "agent-a");
      cache.set("alpha-centauri", "trade_hub", '{"ac":1}', "agent-b");

      cache.invalidate("sol", "trade_hub", "create_sell_order");

      expect(cache.get("sol", "trade_hub")).toBeNull();
      expect(cache.get("alpha-centauri", "trade_hub")).not.toBeNull();
    });

    it("is a no-op if entry does not exist", () => {
      // Should not throw
      expect(() => cache.invalidate("sol", "nonexistent", "sell")).not.toThrow();
    });

    it("counts invalidations for both tool types separately", () => {
      cache.set("sol", "earth_station", '{}', "a", "analyze_market");
      cache.set("sol", "earth_station", '{}', "b", "view_market");
      cache.invalidate("sol", "earth_station", "buy");

      // Should count 2 invalidations (one for each tool type)
      const m = cache.getMetrics();
      expect(m.invalidations).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // CACHE_INVALIDATING_TOOLS set
  // ---------------------------------------------------------------------------

  describe("CACHE_INVALIDATING_TOOLS", () => {
    it("contains buy, sell, create_sell_order, create_buy_order, multi_sell", () => {
      expect(CACHE_INVALIDATING_TOOLS.has("buy")).toBe(true);
      expect(CACHE_INVALIDATING_TOOLS.has("sell")).toBe(true);
      expect(CACHE_INVALIDATING_TOOLS.has("create_sell_order")).toBe(true);
      expect(CACHE_INVALIDATING_TOOLS.has("create_buy_order")).toBe(true);
      expect(CACHE_INVALIDATING_TOOLS.has("multi_sell")).toBe(true);
    });

    it("does not contain analyze_market, view_market, or nav tools", () => {
      expect(CACHE_INVALIDATING_TOOLS.has("analyze_market")).toBe(false);
      expect(CACHE_INVALIDATING_TOOLS.has("view_market")).toBe(false);
      expect(CACHE_INVALIDATING_TOOLS.has("jump")).toBe(false);
      expect(CACHE_INVALIDATING_TOOLS.has("travel")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Freshness annotation
  // ---------------------------------------------------------------------------

  describe("freshnessAnnotation", () => {
    it("formats age in seconds with agent name", () => {
      const annotation = AnalyzeMarketCache.freshnessAnnotation(30_000, "cinder-wake");
      expect(annotation).toBe("[cached 30s ago from cinder-wake]");
    });

    it("rounds to nearest second", () => {
      const annotation = AnalyzeMarketCache.freshnessAnnotation(30_499, "rust-vane");
      expect(annotation).toBe("[cached 30s ago from rust-vane]");
    });

    it("shows 0s for very fresh cache", () => {
      const annotation = AnalyzeMarketCache.freshnessAnnotation(400, "agent-x");
      expect(annotation).toBe("[cached 0s ago from agent-x]");
    });
  });

  // ---------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------

  describe("metrics", () => {
    it("starts with zero counts", () => {
      const m = cache.getMetrics();
      expect(m.hits).toBe(0);
      expect(m.misses).toBe(0);
      expect(m.invalidations).toBe(0);
      expect(m.entries).toBe(0);
      expect(cache.hitRatePct).toBe("n/a");
    });

    it("counts hits and misses correctly", () => {
      cache.get("sol", "earth_station"); // miss
      cache.set("sol", "earth_station", '{}', "a");
      cache.get("sol", "earth_station"); // hit
      cache.get("sol", "mars_station"); // miss

      const m = cache.getMetrics();
      expect(m.hits).toBe(1);
      expect(m.misses).toBe(2);
    });

    it("counts invalidations", () => {
      cache.set("sol", "earth_station", '{}', "a");
      cache.invalidate("sol", "earth_station", "sell");
      expect(cache.getMetrics().invalidations).toBe(1);
    });

    it("does not count invalidation when entry not present", () => {
      cache.invalidate("sol", "nonexistent", "sell");
      expect(cache.getMetrics().invalidations).toBe(0);
    });

    it("reports entries count correctly", () => {
      expect(cache.getMetrics().entries).toBe(0);
      cache.set("sol", "earth_station", '{}', "a");
      cache.set("sol", "mars_station", '{}', "b");
      expect(cache.getMetrics().entries).toBe(2);
    });

    it("reports hit rate as percentage", () => {
      cache.get("sol", "earth_station"); // miss
      cache.set("sol", "earth_station", '{}', "a");
      cache.get("sol", "earth_station"); // hit
      cache.get("sol", "earth_station"); // hit
      // 2 hits / 3 total = 66.7%
      expect(cache.hitRatePct).toBe("66.7%");
    });

    it("counts expired entries as misses", async () => {
      cache.set("sol", "earth_station", '{}', "a");
      await new Promise<void>((r) => setTimeout(r, 550));
      cache.get("sol", "earth_station"); // expired → miss

      const m = cache.getMetrics();
      expect(m.misses).toBe(1);
      expect(m.hits).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Full metrics (per-tool breakdown)
  // ---------------------------------------------------------------------------

  describe("getFullMetrics", () => {
    it("starts with zero counts for both tool types", () => {
      const fm = cache.getFullMetrics();
      expect(fm.analyze_market.hits).toBe(0);
      expect(fm.analyze_market.misses).toBe(0);
      expect(fm.analyze_market.hit_rate).toBe("n/a");
      expect(fm.view_market.hits).toBe(0);
      expect(fm.view_market.misses).toBe(0);
      expect(fm.view_market.hit_rate).toBe("n/a");
      expect(fm.combined.hits).toBe(0);
    });

    it("tracks analyze_market and view_market hits separately", () => {
      cache.set("sol", "earth_station", '{}', "a", "analyze_market");
      cache.set("sol", "earth_station", '{}', "b", "view_market");

      cache.get("sol", "earth_station", "analyze_market"); // analyze hit
      cache.get("sol", "earth_station", "view_market"); // view hit
      cache.get("sol", "mars_station", "analyze_market"); // analyze miss

      const fm = cache.getFullMetrics();
      expect(fm.analyze_market.hits).toBe(1);
      expect(fm.analyze_market.misses).toBe(1);
      expect(fm.view_market.hits).toBe(1);
      expect(fm.view_market.misses).toBe(0);
      expect(fm.combined.hits).toBe(2);
      expect(fm.combined.misses).toBe(1);
    });

    it("counts entries per tool type", () => {
      cache.set("sol", "earth_station", '{}', "a", "analyze_market");
      cache.set("sol", "mars_station", '{}', "b", "analyze_market");
      cache.set("sol", "earth_station", '{}', "c", "view_market");

      const fm = cache.getFullMetrics();
      expect(fm.analyze_market.entries).toBe(2);
      expect(fm.view_market.entries).toBe(1);
      expect(fm.combined.entries).toBe(3);
    });

    it("reports per-tool hit rates", () => {
      cache.set("sol", "earth_station", '{}', "a", "analyze_market");
      cache.get("sol", "earth_station", "analyze_market"); // hit
      cache.get("sol", "mars_station", "analyze_market"); // miss
      // analyze: 1/2 = 50%

      cache.set("sol", "earth_station", '{}', "b", "view_market");
      cache.get("sol", "earth_station", "view_market"); // hit
      // view: 1/1 = 100%

      const fm = cache.getFullMetrics();
      expect(fm.analyze_market.hit_rate).toBe("50.0%");
      expect(fm.view_market.hit_rate).toBe("100.0%");
    });

    it("tracks invalidations per tool type", () => {
      cache.set("sol", "earth_station", '{}', "a", "analyze_market");
      cache.invalidate("sol", "earth_station", "buy");
      // Only analyze_market existed, so only 1 invalidation

      const fm = cache.getFullMetrics();
      expect(fm.analyze_market.invalidations).toBe(1);
      expect(fm.view_market.invalidations).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // pruneExpired
  // ---------------------------------------------------------------------------

  describe("pruneExpired", () => {
    it("removes expired entries and returns count", async () => {
      cache.set("sol", "earth_station", '{}', "a");
      cache.set("sol", "mars_station", '{}', "b");
      await new Promise<void>((r) => setTimeout(r, 550));
      const pruned = cache.pruneExpired();
      expect(pruned).toBe(2);
      expect(cache.getMetrics().entries).toBe(0);
    });

    it("does not remove non-expired entries", async () => {
      cache.set("sol", "earth_station", '{}', "a");
      await new Promise<void>((r) => setTimeout(r, 550));
      cache.set("sol", "mars_station", '{}', "b"); // fresh
      const pruned = cache.pruneExpired();
      expect(pruned).toBe(1);
      expect(cache.getMetrics().entries).toBe(1);
    });

    it("returns 0 if nothing to prune", () => {
      cache.set("sol", "earth_station", '{}', "a");
      expect(cache.pruneExpired()).toBe(0);
    });

    it("prunes both analyze_market and view_market entries", async () => {
      cache.set("sol", "earth_station", '{}', "a", "analyze_market");
      cache.set("sol", "earth_station", '{}', "b", "view_market");
      await new Promise<void>((r) => setTimeout(r, 550));
      const pruned = cache.pruneExpired();
      expect(pruned).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // clear
  // ---------------------------------------------------------------------------

  describe("clear", () => {
    it("removes all entries", () => {
      cache.set("sol", "earth_station", '{}', "a");
      cache.set("sol", "mars_station", '{}', "b");
      cache.clear();
      expect(cache.getMetrics().entries).toBe(0);
    });

    it("removes both analyze_market and view_market entries", () => {
      cache.set("sol", "earth_station", '{}', "a", "analyze_market");
      cache.set("sol", "earth_station", '{}', "b", "view_market");
      cache.clear();
      expect(cache.getMetrics().entries).toBe(0);
    });
  });
});
