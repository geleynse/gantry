/**
 * Resource Knowledge: persisted SQLite table tracking which resources exist
 * at which locations. Populated from analyze_market / view_market responses.
 * Queryable by agents via MCP tool and by dashboard via REST API.
 */

import { queryAll, queryOne, queryRun } from "./database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("resource-knowledge");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResourceRecord {
  system: string;
  station: string | null;
  resource: string;
  quantity_seen: number | null;
  price_seen: number | null;
  last_seen: string;
  source_agent: string;
}

export interface ResourceLocation {
  system: string;
  station: string | null;
  quantity_seen: number | null;
  price_seen: number | null;
  last_seen: string;
  source_agent: string;
}

export interface BestPrice {
  system: string;
  station: string | null;
  price: number;
  last_seen: string;
  source_agent: string;
}

// ---------------------------------------------------------------------------
// ResourceKnowledge
// ---------------------------------------------------------------------------

export class ResourceKnowledge {
  /**
   * Record a resource sighting at a location. Uses INSERT OR REPLACE
   * to upsert on the (system, station, resource) primary key.
   */
  record(
    system: string,
    station: string | null,
    resource: string,
    quantity: number | null,
    price: number | null,
    agent: string,
  ): void {
    try {
      queryRun(
        `INSERT OR REPLACE INTO resource_knowledge
         (system, station, resource, quantity_seen, price_seen, last_seen, source_agent)
         VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
        system,
        station ?? "",
        resource,
        quantity ?? null as any,
        price ?? null as any,
        agent,
      );
    } catch (err) {
      log.warn("failed to record resource", {
        system, station, resource, agent,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Query all known locations for a specific resource.
   * Returns locations sorted by most recently seen.
   */
  query(resource: string): ResourceLocation[] {
    return queryAll<ResourceLocation>(
      `SELECT system, station, quantity_seen, price_seen, last_seen, source_agent
       FROM resource_knowledge
       WHERE resource = ?
       ORDER BY last_seen DESC`,
      resource,
    );
  }

  /**
   * Query all known resources at a specific system.
   * Returns resources sorted by name.
   */
  querySystem(system: string): ResourceRecord[] {
    return queryAll<ResourceRecord>(
      `SELECT system, station, resource, quantity_seen, price_seen, last_seen, source_agent
       FROM resource_knowledge
       WHERE system = ?
       ORDER BY resource ASC`,
      system,
    );
  }

  /**
   * Get the best (lowest) known price for a resource across all locations.
   * Returns null if no price data is available.
   */
  getBestPrice(resource: string): BestPrice | null {
    const row = queryOne<{ system: string; station: string | null; price_seen: number; last_seen: string; source_agent: string }>(
      `SELECT system, station, price_seen, last_seen, source_agent
       FROM resource_knowledge
       WHERE resource = ? AND price_seen IS NOT NULL
       ORDER BY price_seen ASC
       LIMIT 1`,
      resource,
    );
    if (!row) return null;
    return {
      system: row.system,
      station: row.station,
      price: row.price_seen,
      last_seen: row.last_seen,
      source_agent: row.source_agent,
    };
  }

  /**
   * Get the best (highest) sell price for a resource across all locations.
   */
  getBestSellPrice(resource: string): BestPrice | null {
    const row = queryOne<{ system: string; station: string | null; price_seen: number; last_seen: string; source_agent: string }>(
      `SELECT system, station, price_seen, last_seen, source_agent
       FROM resource_knowledge
       WHERE resource = ? AND price_seen IS NOT NULL
       ORDER BY price_seen DESC
       LIMIT 1`,
      resource,
    );
    if (!row) return null;
    return {
      system: row.system,
      station: row.station,
      price: row.price_seen,
      last_seen: row.last_seen,
      source_agent: row.source_agent,
    };
  }

  /**
   * Get all unique known resources.
   */
  listResources(): string[] {
    const rows = queryAll<{ resource: string }>(
      `SELECT DISTINCT resource FROM resource_knowledge ORDER BY resource ASC`,
    );
    return rows.map((r) => r.resource);
  }

  /**
   * Prune records older than the given date string.
   * Returns number of records deleted.
   */
  prune(olderThan: string): number {
    return queryRun(
      `DELETE FROM resource_knowledge WHERE last_seen < ?`,
      olderThan,
    );
  }

  /**
   * Get total record count.
   */
  count(): number {
    const row = queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM resource_knowledge`,
    );
    return row?.cnt ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Market response parser — extract resources from analyze_market / view_market
// ---------------------------------------------------------------------------

/**
 * Parse resource data from a market tool response and record it in the
 * resource knowledge DB.
 *
 * Handles both analyze_market and view_market response shapes:
 * - analyze_market: { recommendations: [{ item_id, quantity, bid_price }] }
 * - view_market: { items: [{ id/item_id, quantity, price }] } or { sell_orders, buy_orders }
 */
export function recordMarketResources(
  knowledge: ResourceKnowledge,
  system: string,
  station: string | null,
  result: unknown,
  agent: string,
): number {
  if (!result || typeof result !== "object") return 0;
  const obj = result as Record<string, unknown>;
  let recorded = 0;

  // analyze_market shape: recommendations array
  if (Array.isArray(obj.recommendations)) {
    for (const rec of obj.recommendations) {
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      const itemId = (r.item_id ?? r.id) as string | undefined;
      if (!itemId) continue;
      const quantity = typeof r.quantity === "number" ? r.quantity : null;
      const price = typeof r.bid_price === "number" ? r.bid_price : (typeof r.price === "number" ? r.price : null);
      knowledge.record(system, station, itemId, quantity, price, agent);
      recorded++;
    }
  }

  // view_market shape: items array
  if (Array.isArray(obj.items)) {
    for (const item of obj.items) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const itemId = (r.item_id ?? r.id) as string | undefined;
      if (!itemId) continue;
      const quantity = typeof r.quantity === "number" ? r.quantity : null;
      const price = typeof r.price === "number" ? r.price : null;
      knowledge.record(system, station, itemId, quantity, price, agent);
      recorded++;
    }
  }

  // view_market shape: sell_orders / buy_orders arrays
  for (const key of ["sell_orders", "buy_orders"] as const) {
    if (Array.isArray(obj[key])) {
      for (const order of obj[key] as unknown[]) {
        if (!order || typeof order !== "object") continue;
        const r = order as Record<string, unknown>;
        const itemId = (r.item_id ?? r.id) as string | undefined;
        if (!itemId) continue;
        const quantity = typeof r.quantity === "number" ? r.quantity : null;
        const price = typeof r.price_each === "number" ? r.price_each : (typeof r.price === "number" ? r.price : null);
        knowledge.record(system, station, itemId, quantity, price, agent);
        recorded++;
      }
    }
  }

  if (recorded > 0) {
    log.debug("recorded market resources", { system, station, agent, count: recorded });
  }
  return recorded;
}
