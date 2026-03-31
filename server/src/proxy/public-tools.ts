/**
 * Public API tools — served from cached public data.
 * No game server interaction. No auth required (but agent must be logged in to proxy).
 */
import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MarketCache } from "./market-cache.js";
import type { ArbitrageAnalyzer } from "./arbitrage-analyzer.js";
import type { GalaxyGraph } from "./pathfinder.js";
import { getRecipe, getRecipesByOutput } from "../services/recipe-registry.js";
import { getPriceTrends } from "../services/market-history.js";
import { findPoisByService } from "../services/galaxy-poi-registry.js";
import { getItem } from "../services/game-item-registry.js";
import { textResult } from "./passthrough-handler.js";

export interface PublicToolDeps {
  mcpServer: McpServer;
  registeredTools: string[];
  marketCache: MarketCache;
  arbitrageAnalyzer: ArbitrageAnalyzer;
  galaxyGraph: GalaxyGraph;
  getAgentForSession: (sessionId?: string) => string | undefined;
}

/** Get global market data, optionally filtered by item name. */
export function handleGetGlobalMarket(marketCache: MarketCache, itemName?: string): Record<string, unknown> {
  const { data, stale, age_seconds } = marketCache.get(itemName);
  if (!data) return { error: "global market data not yet available — try again in a moment" };
  return { items: data.items, item_count: data.items.length, categories: data.categories, _cache: { age_seconds, stale } };
}

/** Find shortest jump route between two systems. */
export function handleFindLocalRoute(galaxyGraph: GalaxyGraph, fromStr: string, toStr: string): Record<string, unknown> {
  if (galaxyGraph.systemCount === 0) return { error: "galaxy map not yet loaded — try again in a moment" };
  const fromId = galaxyGraph.resolveSystemId(fromStr);
  const toId = galaxyGraph.resolveSystemId(toStr);
  if (!fromId) return { error: `unknown system: ${fromStr}` };
  if (!toId) return { error: `unknown system: ${toStr}` };
  const result = galaxyGraph.findRoute(fromId, toId);
  if (!result) return { error: `no route found from ${fromStr} to ${toStr} — systems may be disconnected` };
  return { route: result.route, names: result.names, jumps: result.jumps };
}

/** Get crafting recipe and input availability. */
export function handleGetRecipe(marketCache: MarketCache, itemId: string): Record<string, unknown> {
  const recipes = getRecipesByOutput(itemId);
  if (recipes.length === 0) return { error: `no recipes found for item: ${itemId}` };

  const item = getItem(itemId);
  const result: any = {
    item: item || { id: itemId, name: "Unknown" },
    recipes: []
  };

  for (const recipe of recipes) {
    const inputsWithPrices = recipe.inputs.map(input => {
      const inputItem = getItem(input.item_id);
      const market = marketCache.get(input.item_id);
      let bestPrice = null;
      let location = null;

      if (market.data && market.data.items.length > 0) {
        const match = market.data.items.find(i => i.item_id === input.item_id);
        if (match) {
          bestPrice = match.best_ask; // Price to buy
          location = match.empire;
        }
      }

      return {
        ...input,
        name: inputItem?.name || "Unknown",
        best_market_price: bestPrice,
        location: location
      };
    });

    result.recipes.push({
      ...recipe,
      inputs: inputsWithPrices
    });
  }

  return result;
}

export function registerPublicTools(deps: PublicToolDeps): void {
  const { mcpServer, registeredTools, marketCache, arbitrageAnalyzer, galaxyGraph, getAgentForSession } = deps;

  /** Wrap a public tool handler with the standard login check. */
  function requireLogin<P extends object>(
    handler: (params: P) => ReturnType<typeof textResult>,
  ): (params: P, extra: { sessionId?: string }) => Promise<ReturnType<typeof textResult>> {
    return async (params, extra) => {
      if (!getAgentForSession(extra.sessionId)) return textResult({ error: "not logged in" });
      return handler(params);
    };
  }

  mcpServer.registerTool("get_global_market", {
    description: "Get global market prices across all empires. FREE — no game action cost. Optional item_name filter.",
    inputSchema: {
      item_name: z.string().optional().describe("Filter by item name or ID (case-insensitive substring match)"),
    },
  }, requireLogin(({ item_name }) => textResult(handleGetGlobalMarket(marketCache, item_name))));
  registeredTools.push("get_global_market");

  mcpServer.registerTool("find_local_route", {
    description: "Find shortest jump route between two systems. FREE — no game action cost. Uses public galaxy map.",
    inputSchema: {
      from_system: z.string().describe("Source system ID or name"),
      to_system: z.string().describe("Destination system ID or name"),
    },
  }, requireLogin(({ from_system, to_system }) => textResult(handleFindLocalRoute(galaxyGraph, from_system, to_system))));
  registeredTools.push("find_local_route");

  mcpServer.registerTool("get_recipe", {
    description: "Get crafting recipe for an item, including the best prices for inputs. FREE — no game action cost.",
    inputSchema: {
      item_id: z.string().describe("The ID of the item to look up recipes for"),
    },
  }, requireLogin(({ item_id }) => textResult(handleGetRecipe(marketCache, item_id))));
  registeredTools.push("get_recipe");

  mcpServer.registerTool("get_market_trends", {
    description: "Get 7-day market trends (min/max/avg price) for an item. FREE — no game action cost.",
    inputSchema: {
      item_id: z.string().describe("The ID of the item to look up trends for"),
      days: z.number().optional().default(7).describe("Number of days of history to include"),
    },
  }, requireLogin(({ item_id, days }) => {
    const trends = getPriceTrends(item_id, days);
    if (!trends) return textResult({ error: `no market history found for item: ${item_id}` });
    return textResult(trends);
  }));
  registeredTools.push("get_market_trends");

  mcpServer.registerTool("find_service", {
    description: "Find the nearest POIs offering a specific service (e.g., 'shipyard', 'refuel', 'repair'). FREE — no game action cost.",
    inputSchema: {
      service_type: z.string().describe("The type of service to look for"),
    },
  }, requireLogin(({ service_type }) => {
    const pois = findPoisByService(service_type);
    return textResult({ service_type, poi_count: pois.length, pois });
  }));
  registeredTools.push("find_service");

  mcpServer.registerTool("get_arbitrage", {
    description: "Get top cross-empire arbitrage opportunities. FREE — no game action cost. Shows items where buying in one empire and selling in another is profitable.",
    inputSchema: {},
  }, requireLogin((_) => {
    const opportunities = arbitrageAnalyzer.getOpportunities(marketCache);
    if (opportunities.length === 0) {
      return textResult({ summary: "No arbitrage opportunities found.", opportunities: [] });
    }

    const top10 = opportunities.slice(0, 10);
    const best = top10[0];
    const summary = `Found ${opportunities.length} arbitrage opportunities. Best: buy ${best.item_name} in ${best.buy_empire} at ${best.buy_price}, sell in ${best.sell_empire} at ${best.sell_price} for ${best.profit_margin_pct}% profit.`;

    const header = "Item                 | Buy Empire   | Buy Price | Sell Empire  | Sell Price | Margin% | Est. Volume";
    const separator = "---------------------|--------------|-----------|--------------|------------|---------|------------";
    const rows = top10.map((o) => {
      const item = o.item_name.padEnd(20).slice(0, 20);
      const buyEmp = o.buy_empire.padEnd(12).slice(0, 12);
      const sellEmp = o.sell_empire.padEnd(12).slice(0, 12);
      return `${item} | ${buyEmp} | ${String(o.buy_price).padStart(9)} | ${sellEmp} | ${String(o.sell_price).padStart(10)} | ${String(o.profit_margin_pct).padStart(7)} | ${o.estimated_volume}`;
    });
    const table = [header, separator, ...rows].join("\n");

    return textResult({ summary, table, opportunities: top10 });
  }));
  registeredTools.push("get_arbitrage");
}
