/**
 * compound-tools/multi-sell.ts
 *
 * Implementation of the multi_sell compound tool.
 * Sells multiple items with market prerequisite enforcement and fleet deconfliction.
 */

import { createLogger } from "../../lib/logger.js";
import type { SellEntry } from "../sell-log.js";
import type { CompoundToolDeps, CompoundResult, MultiSellItem } from "./types.js";
import { stripPendingFields } from "./utils.js";

const log = createLogger("compound-tools");

/**
 * Check that analyze_market was called before selling. This enforces the prerequisite
 * at the compound tool level; callers must pass the set of called tools.
 */
export async function multiSell(
  deps: CompoundToolDeps,
  items: MultiSellItem[],
  calledTools: Set<string>,
): Promise<CompoundResult> {
  const { client, agentName, statusCache, sellLog } = deps;

  // Fetch fresh status to avoid stale cache (e.g. agent just docked but cache hasn't updated)
  let cachedStatus = statusCache.get(agentName);
  let playerData = cachedStatus?.data?.player as
    | Record<string, unknown>
    | undefined;

  // Prerequisite 1: Must be docked — if cache says not docked, refresh before blocking
  if (!playerData?.docked_at_base) {
    log.debug("multi_sell: cache says not docked, fetching fresh status", { agent: agentName });
    const freshStatus = await client.execute("get_status", {});
    if (!freshStatus.error && freshStatus.result) {
      // Re-read from cache (get_status triggers onStateUpdate which populates statusCache)
      await client.waitForTick();
      cachedStatus = statusCache.get(agentName);
      playerData = cachedStatus?.data?.player as Record<string, unknown> | undefined;
    }
  }

  if (!playerData?.docked_at_base) {
    log.warn("multi_sell blocked: not docked (confirmed after refresh)", { agent: agentName });
    return {
      error: "You must be docked at a station to use multi_sell. (Verified with fresh get_status — you are not docked.)",
    };
  }

  // Prerequisite 2: Enforce analyze_market — check session calls OR recent cache timestamp
  // Agents must check demand before selling. Session calls are reset on login,
  // so we also check a 20-minute lookback in the status cache.
  const lastMarketAt = (cachedStatus?.data as any)?._last_market_analysis_at as number | undefined;
  const recentMarket = lastMarketAt && (Date.now() - lastMarketAt < 20 * 60_000);

  // Advisory: warn if no recent market check, but don't block the sell
  const hasMarketCheck = calledTools.has("analyze_market") || calledTools.has("view_market");
  let marketWarning: string | undefined;
  if (!hasMarketCheck && !recentMarket) {
    log.info("multi_sell proceeding without recent market check", {
      agent: agentName,
      cache_age_ms: lastMarketAt ? Date.now() - lastMarketAt : "none"
    });
    marketWarning = "⚠️ No recent analyze_market — selling without checking demand may earn 0 credits. Call analyze_market() before selling next time.";
  }

  // Check for recent fleet sells at this station
  const currentStation = playerData.current_poi as string | undefined;
  let fleetSellWarning: string | undefined;

  if (currentStation) {
    const itemIds = items.map((i) => i.item_id);
    const overlaps = sellLog.findOverlaps(currentStation, itemIds, agentName);
    if (overlaps.length > 0) {
      const warnings = overlaps.map((o: SellEntry) => {
        const agoMin = Math.round((Date.now() - o.timestamp) / 60_000);
        return `${o.agent} sold ${o.item_id} (×${o.quantity}) here ${agoMin} min ago`;
      });
      fleetSellWarning = `Recent fleet activity at this station: ${warnings.join("; ")}. Demand may be reduced.`;
      log.debug("multi_sell fleet overlap detected", {
        agent: agentName,
        overlaps: overlaps.length,
      });
    }
  }

  // Capture credits and cargo before selling for delta tracking
  const creditsBefore = playerData?.credits as number | undefined;
  const cargoUsedBefore = (cachedStatus?.data?.ship as any)?.cargo_used as number | undefined;

  log.info("multi_sell START", {
    agent: agentName,
    items_count: items.length,
    credits_before: creditsBefore ?? "unknown",
  });

  const results: { item_id: string; quantity: number; result: unknown }[] = [];

  // Execute sells sequentially. Tick waits are minimized to prevent HTTP response
  // timeouts — the MCP transport holds the connection open with enableJsonResponse:true,
  // so long-running multi_sell causes the client to time out and receive "".
  // Only a single final tick wait is used to let credits settle in cache.

  // Resolve "ALL" quantities from cargo cache before selling
  const cargo = (cachedStatus?.data?.ship as any)?.cargo as Array<{ item_id: string; quantity: number }> | undefined;
  const cargoMap = new Map(cargo?.map(c => [c.item_id, c.quantity]) ?? []);

  for (let i = 0; i < items.length; i++) {
    const { item_id } = items[i];
    let { quantity } = items[i];
    // Resolve "ALL" or non-numeric quantities to actual cargo amount
    if (quantity === ("ALL" as any) || typeof quantity !== "number" || quantity <= 0) {
      const cargoQty = cargoMap.get(item_id);
      if (cargoQty && cargoQty > 0) {
        quantity = cargoQty;
        log.debug("multi_sell resolved ALL quantity", { agent: agentName, item_id, quantity });
      } else {
        results.push({ item_id, quantity: 0, result: { error: `No ${item_id} in cargo to sell` } });
        continue;
      }
    }
    const resp = await client.execute("sell", { item_id, quantity }, { noRetry: true });

    if (resp.error) {
      results.push({ item_id, quantity, result: resp.error });
      log.warn("multi_sell item failed", {
        agent: agentName,
        item_index: i,
        item_id,
        quantity,
      });
    } else {
      results.push({ item_id, quantity, result: resp.result });
      const isPending =
        resp.result &&
        typeof resp.result === "object" &&
        "pending" in (resp.result as Record<string, unknown>);
      log.debug("multi_sell item completed", {
        agent: agentName,
        item_index: i,
        item_id,
        quantity,
        pending: isPending,
      });

      if (isPending) {
        stripPendingFields(resp.result);
      }
    }
  }

  // Single tick wait after all sells — lets the game resolve pending sells
  // and update credits in cache. Avoids multiple tick waits that caused
  // HTTP response timeouts (multi_sell returned "" to agents).
  await client.waitForTick();

  // Get final credits from cache
  const cached = statusCache.get(agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const credits = player?.credits ?? "unknown";

  const creditDelta =
    typeof credits === "number" && typeof creditsBefore === "number"
      ? credits - creditsBefore
      : "unknown";
  log.info("multi_sell DONE", {
    agent: agentName,
    credits_after: credits,
    credits_delta: creditDelta,
  });

  const sellResult: Record<string, unknown> = {
    status: "completed",
    sells: results,
    items_sold: results.length,
    credits_after: credits,
  };

  // Verify cargo actually changed — catches silent no-ops where the game accepts the call
  // but doesn't actually remove items (e.g. session desync, station state issues).
  const cargoUsedAfter = (statusCache.get(agentName)?.data?.ship as any)?.cargo_used as number | undefined;
  const cargoReduced =
    cargoUsedAfter !== undefined && cargoUsedBefore !== undefined && cargoUsedAfter < cargoUsedBefore;
  const cargoDataAvailable = cargoUsedAfter !== undefined && cargoUsedBefore !== undefined;

  if (cargoDataAvailable && !cargoReduced && results.length > 0) {
    log.warn("multi_sell cargo unchanged after sells", {
      agent: agentName,
      cargo_used_before: cargoUsedBefore,
      cargo_used_after: cargoUsedAfter,
    });
    sellResult.cargo_warning =
      "WARNING: Cargo hold unchanged after sells — items may not have been removed. " +
      "This can happen when the game is desynced or items have already been sold/listed. " +
      "Call get_status to verify actual cargo, then retry if needed.";
  }

  // Inject market check advisory if no recent analyze_market
  if (marketWarning) {
    sellResult._market_advisory = marketWarning;
  }

  // Warn agent if sells earned nothing — likely no station demand
  if (typeof creditDelta === "number" && creditDelta === 0 && results.length > 0) {
    sellResult.warning =
      "0 credits earned — this station has no demand for your items. " +
      "Items remain in your cargo (not auto-listed). " +
      "Travel to a different station with demand, or use analyze_market() to find buyers.";
  }

  // Record sells for fleet deconfliction
  if (currentStation) {
    for (const r of results) {
      if (
        !r.result ||
        (typeof r.result === "object" &&
          "error" in (r.result as Record<string, unknown>))
      )
        continue;
      sellLog.record(currentStation, {
        agent: agentName,
        item_id: r.item_id,
        quantity: r.quantity,
        timestamp: Date.now(),
      });
    }
  }

  if (fleetSellWarning) {
    sellResult.fleet_sell_warning = fleetSellWarning;
  }

  return sellResult;
}
