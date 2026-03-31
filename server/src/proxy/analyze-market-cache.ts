/**
 * AnalyzeMarketCache — Cross-agent cache for analyze_market and view_market tool results.
 *
 * analyze_market and view_market hit the game API and return responses the Claude
 * model processes in context (the main token cost). If agent B calls either tool
 * at the same station within 60s of agent A, we return A's cached result
 * directly, skipping the game API call entirely.
 *
 * Cache key: `${toolType}:${system}:${station}` — station-specific, tool-specific.
 * Agents at different stations see different market data.
 *
 * Invalidation: buy/sell/create_sell_order/create_buy_order/multi_sell at the
 * same station evict both analyze_market and view_market entries immediately.
 *
 * TTL: 60 seconds. Configurable for testing.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("analyze-market-cache");

const DEFAULT_TTL_MS = 60_000; // 60 seconds

/** Cache tool types supported by this cache. */
export type MarketCacheToolType = "analyze_market" | "view_market";

/** Serialized tool result text (the string inside McpTextResult.content[0].text). */
export interface AnalyzeMarketEntry {
  /** The raw serialized result stored as a JSON string. */
  result: string;
  cachedAt: number;
  /** Agent that originally fetched this result (for logging). */
  agent: string;
  /** Station POI ID this result is for. */
  station: string;
  /** Which tool produced this result. */
  toolType: MarketCacheToolType;
}

export interface AnalyzeMarketCacheMetrics {
  hits: number;
  misses: number;
  invalidations: number;
  entries: number;
}

export interface MarketCacheFullMetrics {
  analyze_market: AnalyzeMarketCacheMetrics & { hit_rate: string };
  view_market: AnalyzeMarketCacheMetrics & { hit_rate: string };
  combined: AnalyzeMarketCacheMetrics & { hit_rate: string };
}

/** Tools that should evict the cache for the agent's current station. */
export const CACHE_INVALIDATING_TOOLS = new Set([
  "buy",
  "sell",
  "create_sell_order",
  "create_buy_order",
  "multi_sell",
]);

export class AnalyzeMarketCache {
  /** Key: `${toolType}:${system}:${station}` */
  private cache = new Map<string, AnalyzeMarketEntry>();
  private readonly ttlMs: number;

  // Per-tool metrics indexed by tool type
  private metrics: Record<MarketCacheToolType, { hits: number; misses: number; invalidations: number }> = {
    analyze_market: { hits: 0, misses: 0, invalidations: 0 },
    view_market: { hits: 0, misses: 0, invalidations: 0 },
  };

  // Aggregate accessors across both tool types
  get hits(): number { return this.metrics.analyze_market.hits + this.metrics.view_market.hits; }
  get misses(): number { return this.metrics.analyze_market.misses + this.metrics.view_market.misses; }
  get invalidations(): number { return this.metrics.analyze_market.invalidations + this.metrics.view_market.invalidations; }

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private key(system: string, station: string, toolType: MarketCacheToolType = "analyze_market"): string {
    return `${toolType}:${system}:${station}`;
  }

  /**
   * Check the cache for a market tool result at the given station.
   * Returns the cached entry (with age) or null on miss/expired.
   */
  get(system: string, station: string, toolType: MarketCacheToolType = "analyze_market"): (AnalyzeMarketEntry & { ageMs: number }) | null {
    const k = this.key(system, station, toolType);
    const entry = this.cache.get(k);
    if (!entry) {
      this.metrics[toolType].misses++;
      return null;
    }

    const ageMs = Date.now() - entry.cachedAt;
    if (ageMs > this.ttlMs) {
      this.cache.delete(k);
      this.metrics[toolType].misses++;
      log.debug(`${toolType} cache expired`, { system, station, age_ms: ageMs });
      return null;
    }

    this.metrics[toolType].hits++;
    log.debug(`${toolType} cache hit`, { system, station, age_ms: ageMs, cached_by: entry.agent });
    return { ...entry, ageMs };
  }

  /**
   * Store a market tool result for the given station.
   * Overwrites any existing entry (refresh).
   */
  set(system: string, station: string, result: string, agent: string, toolType: MarketCacheToolType = "analyze_market"): void {
    const k = this.key(system, station, toolType);
    this.cache.set(k, {
      result,
      cachedAt: Date.now(),
      agent,
      station,
      toolType,
    });
    log.debug(`${toolType} cache set`, { system, station, agent, result_len: result.length });
  }

  /**
   * Evict cache entries for a specific station.
   * Call this after buy/sell/create_*_order at the station.
   * Evicts BOTH analyze_market and view_market entries.
   */
  invalidate(system: string, station: string, reason: string): void {
    for (const toolType of ["analyze_market", "view_market"] as const) {
      const k = this.key(system, station, toolType);
      if (this.cache.has(k)) {
        this.cache.delete(k);
        this.metrics[toolType].invalidations++;
        log.debug(`${toolType} cache invalidated`, { system, station, reason });
      }
    }
  }

  /**
   * Build a freshness annotation to append to cached results, e.g.:
   * "[cached 30s ago from cinder-wake]"
   */
  static freshnessAnnotation(ageMs: number, agent: string): string {
    const ageSec = Math.round(ageMs / 1000);
    return `[cached ${ageSec}s ago from ${agent}]`;
  }

  private static hitRateStr(hits: number, total: number): string {
    return total === 0 ? "n/a" : ((hits / total) * 100).toFixed(1) + "%";
  }

  /** Current cache metrics snapshot (combined for backward compat). */
  getMetrics(): AnalyzeMarketCacheMetrics {
    return {
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      entries: this.cache.size,
    };
  }

  /** Per-tool and combined metrics for dashboard/API. */
  getFullMetrics(): MarketCacheFullMetrics {
    const am = this.metrics.analyze_market;
    const vm = this.metrics.view_market;

    // Count entries per tool type
    let analyzeEntries = 0;
    let viewEntries = 0;
    for (const entry of this.cache.values()) {
      if (entry.toolType === "view_market") viewEntries++;
      else analyzeEntries++;
    }

    return {
      analyze_market: {
        ...am,
        entries: analyzeEntries,
        hit_rate: AnalyzeMarketCache.hitRateStr(am.hits, am.hits + am.misses),
      },
      view_market: {
        ...vm,
        entries: viewEntries,
        hit_rate: AnalyzeMarketCache.hitRateStr(vm.hits, vm.hits + vm.misses),
      },
      combined: {
        hits: this.hits,
        misses: this.misses,
        invalidations: this.invalidations,
        entries: this.cache.size,
        hit_rate: AnalyzeMarketCache.hitRateStr(this.hits, this.hits + this.misses),
      },
    };
  }

  /** Hit rate as a percentage string, or "n/a" if no requests yet. */
  get hitRatePct(): string {
    return AnalyzeMarketCache.hitRateStr(this.hits, this.hits + this.misses);
  }

  /** Evict all expired entries. Returns the number removed. */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [k, entry] of this.cache) {
      if (now - entry.cachedAt > this.ttlMs) {
        this.cache.delete(k);
        pruned++;
      }
    }
    return pruned;
  }

  /** Clear everything (for testing / graceful shutdown). */
  clear(): void {
    this.cache.clear();
  }
}
