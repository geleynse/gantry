import { createOrder, getAllPendingOrders } from "./comms-db.js";
import { ArbitrageAnalyzer } from "../proxy/arbitrage-analyzer.js";
import type { MarketData } from "../proxy/market-cache.js";

export type { MarketData } from "../proxy/market-cache.js";

const _analyzer = new ArbitrageAnalyzer();

export async function runMarketScan(): Promise<{ opportunities: number; orders_created: number }> {
  const resp = await fetch("https://game.spacemolt.com/api/market", { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`Market API returned ${resp.status}`);
  const data = await resp.json() as MarketData;

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
