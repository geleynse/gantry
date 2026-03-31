/**
 * supply_run routine — Buy items at one station, deliver to another.
 *
 * State machine:
 *   INIT → TRAVEL_BUY_STATION → DOCK → ACQUIRE_ITEMS (buy/withdraw) →
 *   TRAVEL_SELL_STATION → DOCK → ANALYZE_MARKET → MULTI_SELL →
 *   CREATE_SELL_ORDERS → REFUEL → DONE
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { getCargoUtilization, done, handoff, phase, completePhase, extractDemandItems, travelAndDock } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface SupplyRunParams {
  buy_station: string;
  sell_station: string;
  items: Array<{ item_id: string; quantity: number }>;
  buy_method?: "market" | "storage"; // default: "market"
}

function parseParams(raw: unknown): SupplyRunParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.buy_station !== "string" || !obj.buy_station) {
    throw new Error("buy_station is required (string)");
  }
  if (typeof obj.sell_station !== "string" || !obj.sell_station) {
    throw new Error("sell_station is required (string)");
  }
  if (!Array.isArray(obj.items) || !obj.items.every(
    (i) =>
      typeof i === "object" &&
      i !== null &&
      typeof (i as any).item_id === "string" &&
      typeof (i as any).quantity === "number"
  )) {
    throw new Error("items must be an array of { item_id: string, quantity: number }");
  }

  const params: SupplyRunParams = {
    buy_station: obj.buy_station,
    sell_station: obj.sell_station,
    items: obj.items as Array<{ item_id: string; quantity: number }>,
  };

  if (obj.buy_method !== undefined) {
    if (obj.buy_method !== "market" && obj.buy_method !== "storage") {
      throw new Error("buy_method must be 'market' or 'storage'");
    }
    params.buy_method = obj.buy_method;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: SupplyRunParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const buyMethod = params.buy_method ?? "market";

  // --- Init ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const creditsBefore = typeof player?.credits === "number" ? player.credits : undefined;
  phases.push(completePhase(initPhase, { creditsBefore, buyMethod }));

  ctx.log("info", `supply_run: starting. buy_station=${params.buy_station}, sell_station=${params.sell_station}`);

  // --- Travel to buy_station and Dock ---
  const tdBuy = await travelAndDock(ctx, params.buy_station, { label: "supply_run" });
  phases.push(...tdBuy.phases);
  if (tdBuy.failed) return handoff(tdBuy.failed, {}, phases);

  // --- Acquire items ---
  const acquirePhase = phase("acquire_items");
  const itemsAcquired: { item_id: string; quantity: number; cost: number }[] = [];
  let totalCost = 0;
  
  // Check cargo utilization before starting acquisition
  const cargoBefore = await ctx.client.execute("get_cargo");
  const utilBefore = getCargoUtilization(cargoBefore);
  ctx.log("info", `supply_run: cargo at start: ${utilBefore ? `${utilBefore.used}/${utilBefore.capacity} (${utilBefore.pctFull.toFixed(1)}% full)` : "unknown"}`);

  if (utilBefore && utilBefore.pctFull >= 100) {
    ctx.log("warn", "supply_run: cargo already full, skipping acquisition.");
    phases.push(completePhase(acquirePhase, { items: [], total_cost: 0, stopped: "cargo_full_at_start" }));
  } else {
    for (const item of params.items) {
      const tool = buyMethod === "market" ? "buy" : "storage";
      const args = buyMethod === "market" ? item : { ...item, action: "withdraw" };
      const resp = await ctx.client.execute(tool, args);

      if (resp.error) {
        if (JSON.stringify(resp.error).includes("cargo_full")) {
          ctx.log("warn", "supply_run: Cargo full, stopping acquisition.");
          break;
        }
        continue; // Skip if item cannot be acquired, e.g., not enough credits
      }

      const cost = (resp.result as any)?.cost ?? 0;
      itemsAcquired.push({ ...item, cost });
      totalCost += cost;

      // Check cargo after each buy to handle item sizes
      const cargoAfter = await ctx.client.execute("get_cargo");
      const utilAfter = getCargoUtilization(cargoAfter);
      if (utilAfter && utilAfter.pctFull >= 100) {
        ctx.log("info", "supply_run: cargo reached capacity after buy, stopping acquisition.");
        break;
      }
    }
    phases.push(completePhase(acquirePhase, { items: itemsAcquired, total_cost: totalCost }));
  }

  // --- Travel to sell_station and Dock ---
  const tdSell = await travelAndDock(ctx, params.sell_station, { label: "supply_run" });
  phases.push(...tdSell.phases);
  if (tdSell.failed) return handoff(tdSell.failed, {}, phases);

  // --- Analyze Market & Sell ---
  const marketResp = await ctx.client.execute("analyze_market");
  const demandItems = extractDemandItems(marketResp.result);
  const itemsToSell = itemsAcquired.filter(i => demandItems.has(i.item_id));
  const itemsToOrder = itemsAcquired.filter(i => !demandItems.has(i.item_id));

  let itemsSold = 0;
  if(itemsToSell.length > 0) {
    const sellResp = await ctx.client.execute("multi_sell", { items: itemsToSell });
    if(sellResp.result) itemsSold = (sellResp.result as any).items_sold ?? 0;
    phases.push(completePhase(phase("multi_sell"), sellResp.result ?? sellResp.error));
  }
  
  let sellOrderCount = 0;
  if (itemsToOrder.length > 0) {
    for (const item of itemsToOrder) {
      const orderResp = await ctx.client.execute("create_sell_order", { item_id: item.item_id, quantity: item.quantity, price_mode: "market" });
      if(!orderResp.error) sellOrderCount++;
    }
    phases.push(completePhase(phase("create_sell_orders"), { orders_created: sellOrderCount }));
  }

  // --- Refuel ---
  const refuelResp = await ctx.client.execute("refuel");
  phases.push(completePhase(phase("refuel"), refuelResp.result ?? refuelResp.error));

  // --- Summary ---
  const finalStatus = ctx.statusCache.get(ctx.agentName)?.data?.player as Record<string, unknown> | undefined;
  const creditsAfter = typeof finalStatus?.credits === "number" ? finalStatus.credits : undefined;
  const creditsEarned = (creditsBefore !== undefined && creditsAfter !== undefined) ? creditsAfter - creditsBefore : 0;

  const summary = `Supply run complete. Bought ${itemsAcquired.length} item types for ${totalCost} credits, delivered to ${params.sell_station}. Sold ${itemsSold} items and created ${sellOrderCount} orders. Total profit: ${creditsEarned} credits.`;

  return done(summary, {
    items_bought: itemsAcquired,
    items_delivered_count: itemsSold + sellOrderCount,
    credits_spent: totalCost,
    credits_earned: creditsEarned,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const supplyRunRoutine: RoutineDefinition<SupplyRunParams> = {
  name: "supply_run",
  description: "Buy or withdraw items at one station and deliver/sell them at another.",
  parseParams,
  run,
};
