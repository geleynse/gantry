/**
 * ArbitrageAnalyzer — Cross-empire arbitrage opportunity analysis.
 *
 * Compares buy (ask) prices and sell (bid) prices across empires for the same item,
 * identifying profitable cross-empire trade routes. Results are cached with a
 * configurable TTL (default 5 minutes, matching MarketCache).
 */
import type { MarketData, MarketItem, MarketCache } from "./market-cache.js";

export interface ArbitrageOpportunity {
  item_id: string;
  item_name: string;
  buy_empire: string;       // where to buy (empire with lowest ask)
  sell_empire: string;      // where to sell (empire with highest bid)
  buy_price: number;        // best_ask in buy empire
  sell_price: number;       // best_bid in sell empire
  profit_per_unit: number;
  profit_margin_pct: number;
  estimated_volume: number; // min(ask_quantity, bid_quantity)
}

const MIN_MARGIN_PCT = 10;
const MAX_OPPORTUNITIES = 20;

export class ArbitrageAnalyzer {
  private cachedOpportunities: ArbitrageOpportunity[] = [];
  private lastAnalyzedAt = 0;
  private readonly ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** Pure: analyze market data and return cross-empire arbitrage opportunities. */
  analyze(data: MarketData): ArbitrageOpportunity[] {
    const byItem = new Map<string, MarketItem[]>();
    for (const item of data.items) {
      let list = byItem.get(item.item_id);
      if (!list) { list = []; byItem.set(item.item_id, list); }
      list.push(item);
    }

    const opportunities: ArbitrageOpportunity[] = [];

    for (const [, entries] of byItem) {
      if (entries.length < 2) continue;

      const withAsk = entries.filter((e) => e.best_ask > 0);
      const withBid = entries.filter((e) => e.best_bid > 0);

      if (withAsk.length === 0 || withBid.length === 0) continue;

      const cheapest = withAsk.reduce((a, b) => (a.best_ask < b.best_ask ? a : b));
      const richest = withBid.reduce((a, b) => (a.best_bid > b.best_bid ? a : b));

      if (cheapest.empire === richest.empire) continue;

      const profitPerUnit = richest.best_bid - cheapest.best_ask;
      const marginPct = (profitPerUnit / cheapest.best_ask) * 100;

      if (marginPct < MIN_MARGIN_PCT) continue;

      const estimatedVolume = Math.min(cheapest.ask_quantity, richest.bid_quantity);
      if (estimatedVolume <= 0) continue;

      opportunities.push({
        item_id: cheapest.item_id,
        item_name: cheapest.item_name,
        buy_empire: cheapest.empire || "Unknown",
        sell_empire: richest.empire || "Unknown",
        buy_price: cheapest.best_ask,
        sell_price: richest.best_bid,
        profit_per_unit: profitPerUnit,
        profit_margin_pct: Math.round(marginPct * 10) / 10,
        estimated_volume: estimatedVolume,
      });
    }

    opportunities.sort(
      (a, b) => b.profit_per_unit * b.estimated_volume - a.profit_per_unit * a.estimated_volume,
    );
    return opportunities.slice(0, MAX_OPPORTUNITIES);
  }

  /**
   * Get cached opportunities, re-analyzing if cache is stale.
   * Returns stale data if MarketCache has no data yet.
   */
  getOpportunities(marketCache: MarketCache): ArbitrageOpportunity[] {
    const age = Date.now() - this.lastAnalyzedAt;
    if (this.lastAnalyzedAt > 0 && age < this.ttlMs) {
      return this.cachedOpportunities;
    }
    const { data } = marketCache.get();
    if (!data) return this.cachedOpportunities;
    this.cachedOpportunities = this.analyze(data);
    this.lastAnalyzedAt = Date.now();
    return this.cachedOpportunities;
  }
}
