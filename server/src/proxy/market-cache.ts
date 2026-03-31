/**
 * MarketCache — Periodically fetches the public /api/market endpoint and caches results.
 *
 * The public API returns global market data (all items across all empires) without
 * authentication. We cache it in-memory with a configurable TTL (default 5 minutes).
 * On fetch failure, stale data is returned until the next successful refresh.
 */

import { createLogger } from "../lib/logger.js";
import { persistMarketCache } from "./cache-persistence.js";
import { recordPrice } from "../services/market-history.js";
import { CircuitBreaker, type CircuitBreakerConfig } from "./circuit-breaker.js";

import { MARKET_SCAN_INTERVAL_MS } from "../config/env.js";

/**
 * Polyfill for AbortSignal.any() — combines multiple signals into one that
 * aborts when any of the inputs abort. Uses the native implementation when
 * available (Bun ≥ 1.1, Node ≥ 20.3), otherwise falls back to a manual
 * AbortController that listens to each input signal.
 */
export function abortSignalAny(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as { any?: unknown }).any === "function") {
    return (AbortSignal as { any: (signals: AbortSignal[]) => AbortSignal }).any(signals);
  }
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    // Clean up listeners to avoid leaks
    for (const signal of signals) {
      signal.removeEventListener("abort", onAbort);
    }
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

const log = createLogger("market-cache");

export interface MarketItem {
  item_id: string;
  item_name: string;
  category: string;
  base_value: number;
  empire: string;
  best_bid: number;
  best_ask: number;
  bid_quantity: number;
  ask_quantity: number;
  spread: number;
  spread_pct: number;
}

export interface MarketData {
  categories: string[];
  empires: Array<{ id: string; name: string }>;
  items: MarketItem[];
}

export class MarketCache {
  private data: MarketData | null = null;
  private fetchedAt = 0;
  private lastHistorySnapshot = 0;
  private readonly ttlMs: number;
  private readonly url: string;
  private readonly retryDelays: number[];
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshAbort: AbortController | null = null;
  private readonly HISTORY_SNAPSHOT_INTERVAL = 1000 * 60 * 60; // 1 hour
  private readonly breaker: CircuitBreaker;

  constructor(
    url = "https://game.spacemolt.com/api/market",
    ttlMs = MARKET_SCAN_INTERVAL_MS,
    retryDelays = [0, 1000, 2000, 4000, 8000],
    breakerConfig?: Partial<CircuitBreakerConfig>,
  ) {
    this.url = url;
    this.ttlMs = ttlMs;
    this.retryDelays = retryDelays;
    this.breaker = new CircuitBreaker({
      failureThreshold: 3,
      successThreshold: 1,
      cooldownMs: 30_000,
      ...breakerConfig,
    });
  }

  /** Start periodic background refresh. Non-blocking initial fetch. Returns the interval handle. */
  start(): ReturnType<typeof setInterval> {
    // Fetch immediately (non-blocking)
    this.refresh().catch(() => {});
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.ttlMs);
    this.refreshTimer.unref();
    return this.refreshTimer;
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.refreshAbort) {
      this.refreshAbort.abort();
      this.refreshAbort = null;
    }
  }

  /** Restore previously persisted cache data without triggering a network fetch. */
  restore(data: MarketData, fetchedAt: number): void {
    this.data = data;
    this.fetchedAt = fetchedAt;
  }

  /** Force a refresh. Retries with exponential backoff; on 429, gives up early with longer gap before next scheduled refresh. */
  async refresh(): Promise<boolean> {
    // If circuit breaker is open, return stale cached data instead of retrying
    if (!this.breaker.allowConnection()) {
      log.debug("circuit breaker open — returning stale data");
      return false;
    }

    // Abort any previous ongoing refresh attempt
    if (this.refreshAbort) this.refreshAbort.abort();
    this.refreshAbort = new AbortController();
    const signal = this.refreshAbort.signal;

    const delays = this.retryDelays;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (signal.aborted) return false;

      if (delays[attempt] > 0) {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delays[attempt]);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
        } catch (err) {
          return false; // Aborted during wait
        }
      }

      if (signal.aborted) return false;

      try {
        const timeoutSignal = AbortSignal.timeout(10_000);
        const combinedSignal = abortSignalAny([signal, timeoutSignal]);

        const resp = await fetch(this.url, { signal: combinedSignal });
        if (!resp.ok) {
          // If 429 (rate limited), don't retry immediately — abort and wait for next scheduled refresh
          if (resp.status === 429) {
            log.warn(`rate limited (429) on attempt ${attempt + 1} — backing off until next scheduled refresh`);
            this.breaker.recordFailure();
            this.refreshAbort = null;
            return false;
          }
          log.warn(`fetch failed: HTTP ${resp.status} (attempt ${attempt + 1})`);
          continue;
        }
        const text = await resp.text();
        if (signal.aborted) return false;

        let raw: MarketData;
        try {
          raw = JSON.parse(text) as MarketData;
        } catch {
          log.warn(`JSON parse error on attempt ${attempt + 1} — truncated response? (${text.length} chars)`);
          continue;
        }
        if (!raw.items || !Array.isArray(raw.items)) {
          log.warn("invalid response shape — missing items array");
          this.breaker.recordFailure();
          this.refreshAbort = null;
          return false;
        }
        this.fetchedAt = Date.now();
        this.data = raw;
        this.breaker.recordSuccess();

        // Record history snapshot every hour
        if (this.fetchedAt - this.lastHistorySnapshot > this.HISTORY_SNAPSHOT_INTERVAL) {
          this.recordHistory(raw);
          this.lastHistorySnapshot = this.fetchedAt;
        }

        // Persist to database so cache survives server restart (errors handled internally)
        persistMarketCache(raw, this.fetchedAt);
        log.info(`refreshed: ${raw.items.length} items across ${raw.categories?.length ?? "?"} categories`);
        this.refreshAbort = null;
        return true;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return false;
        log.error(`fetch error (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // All retries exhausted
    this.breaker.recordFailure();
    this.refreshAbort = null;
    return false;
  }

  /** Get cached data, optionally filtered by item name (case-insensitive substring match). */
  get(itemName?: string): { data: MarketData | null; stale: boolean; age_seconds: number } {
    const age = this.fetchedAt > 0 ? Math.round((Date.now() - this.fetchedAt) / 1000) : -1;
    const stale = this.fetchedAt > 0 && (Date.now() - this.fetchedAt) > this.ttlMs;

    if (!this.data) {
      return { data: null, stale: false, age_seconds: age };
    }

    if (!itemName) {
      return { data: this.data, stale, age_seconds: age };
    }

    // Filter items by name (case-insensitive substring)
    const lower = itemName.toLowerCase();
    const filtered = this.data.items.filter(
      (item) => item.item_name.toLowerCase().includes(lower) || item.item_id.toLowerCase().includes(lower),
    );

    return {
      data: { ...this.data, items: filtered },
      stale,
      age_seconds: age,
    };
  }

  /** Resolve item_id to item_name from cached data. */
  getItemName(itemId: string): string | null {
    if (!this.data) return null;
    const item = this.data.items.find((i) => i.item_id === itemId);
    return item?.item_name ?? null;
  }

  /** Whether any data has been fetched (even if stale). */
  get hasData(): boolean {
    return this.data !== null;
  }

  /** Get the circuit breaker instance (for monitoring / testing). */
  getBreaker(): CircuitBreaker {
    return this.breaker;
  }

  /** Persist the current market data to market_history table. */
  private recordHistory(data: MarketData): void {
    log.info(`recording market history snapshot for ${data.items.length} items`);
    for (const item of data.items) {
      if (item.best_bid > 0) {
        recordPrice({
          item_id: item.item_id,
          poi_id: `global:${item.empire || 'neutral'}`,
          price: item.best_bid,
          type: 'sell' // Best bid is what a player can sell for
        });
      }
      if (item.best_ask > 0) {
        recordPrice({
          item_id: item.item_id,
          poi_id: `global:${item.empire || 'neutral'}`,
          price: item.best_ask,
          type: 'buy' // Best ask is what a player can buy for
        });
      }
    }
  }
}
