import { getDb, queryOne, queryRun } from './database.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('market-history');

export interface MarketSnapshot {
  item_id: string;
  poi_id: string;
  price: number;
  type: 'buy' | 'sell';
  timestamp?: string;
}

/**
 * MarketHistoryService — Persistent price tracking for items across the galaxy.
 */
export function recordPrice(snapshot: MarketSnapshot): void {
  try {
    queryRun(`
      INSERT INTO market_history (item_id, poi_id, price, type, timestamp)
      VALUES (?, ?, ?, ?, datetime('now'))
    `,
      snapshot.item_id,
      snapshot.poi_id,
      snapshot.price,
      snapshot.type
    );
  } catch (e) {
    log.error(`Failed to record price for ${snapshot.item_id}`, { error: e });
  }
}

export function recordMarketData(poi_id: string, data: any): void {
  if (!data || typeof data !== 'object') return;

  const buyPrices = data.buy_prices || {};
  const sellPrices = data.sell_prices || {};

  const db = getDb();
  db.transaction(() => {
    for (const type of ['buy', 'sell'] as const) {
      const prices = type === 'buy' ? buyPrices : sellPrices;
      for (const [item_id, price] of Object.entries(prices)) {
        recordPrice({ item_id, poi_id, price: Number(price), type });
      }
    }
  })();
}

export interface PriceTrend {
  item_id: string;
  min_price: number;
  max_price: number;
  avg_price: number;
  sample_count: number;
}

export function getPriceTrends(item_id: string, days: number = 7): PriceTrend | null {
  try {
    const row = queryOne<PriceTrend>(`
      SELECT 
        item_id,
        MIN(price) as min_price,
        MAX(price) as max_price,
        AVG(price) as avg_price,
        COUNT(*) as sample_count
      FROM market_history
      WHERE item_id = ? AND timestamp >= datetime('now', ?)
      GROUP BY item_id
    `, item_id, `-${days} days`);
    
    if (!row || row.sample_count === 0) return null;
    return row;
  } catch (e) {
    return null;
  }
}
