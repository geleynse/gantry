import { createOrder, getAllPendingOrders } from "./comms-db.js";
import { ArbitrageAnalyzer } from "../proxy/arbitrage-analyzer.js";
import { getActiveMarketCache, type MarketCache, type MarketData } from "../proxy/market-cache.js";

export type { MarketData } from "../proxy/market-cache.js";

const _analyzer = new ArbitrageAnalyzer();

/** Don't act on cache data older than this — if the shared cache hasn't
 * refreshed in 3 cycles, its circuit breaker is likely backing off and we
 * should not create orders from (or re-fetch) a struggling API. */
const MAX_CACHE_AGE_SECONDS = 15 * 60;

export async function runMarketScan(
  cache: MarketCache | null = getActiveMarketCache(),
): Promise<{ opportunities: number; orders_created: number }> {
  let data: MarketData;
  if (cache) {
    // Consume the shared MarketCache (refreshed on its own MARKET_SCAN_INTERVAL_MS
    // timer with retry/backoff + circuit breaker) instead of issuing a second,
    // unguarded fetch of the same rate-limited endpoint every cycle. If the
    // cache has no fresh data, skip this scan rather than hammering the API
    // the breaker is backing off from.
    const { data: cached, age_seconds } = cache.get();
    if (!cached || age_seconds < 0 || age_seconds > MAX_CACHE_AGE_SECONDS) {
      return { opportunities: 0, orders_created: 0 };
    }
    data = cached;
  } else {
    // No shared cache running (standalone/test usage) — fetch directly.
    const resp = await fetch("https://game.spacemolt.com/api/market", { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) throw new Error(`Market API returned ${resp.status}`);
    data = await resp.json() as MarketData;
  }

  const opportunities = _analyzer.analyze(data);
  if (opportunities.length === 0) {
    return { opportunities: 0, orders_created: 0 };
  }

  let ordersCreated = 0;
  const existing = getAllPendingOrders();
  for (const opp of opportunities) {
    // Dedup: check existing fleet-wide orders for this item+empire
    const isDuplicate = existing.some((o) =>
      o.message.includes(opp.item_id) && o.message.includes(opp.sell_empire)
    );
    if (isDuplicate) continue;

    const message = `Trade opportunity: ${opp.item_name} (${opp.item_id}) — `
      + `buy in ${opp.buy_empire} (ask ${opp.buy_price}), `
      + `sell in ${opp.sell_empire} (bid ${opp.sell_price}, volume ${opp.estimated_volume}). `
      + `Profit: ${opp.profit_per_unit}/unit (${opp.profit_margin_pct}% margin).`;

    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    createOrder({ message, priority: "normal", expires_at: expiresAt });
    ordersCreated++;
  }

  return { opportunities: opportunities.length, orders_created: ordersCreated };
}
