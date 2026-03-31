/**
 * craft_and_sell routine — Craft available recipes and sell cargo at a docked station.
 *
 * State machine:
 *   INIT → DOCK (if needed) → CRAFT_PHASE → ANALYZE_MARKET → GET_CARGO →
 *   MULTI_SELL (demand items) → CREATE_SELL_ORDER (remaining) → REFUEL → DONE
 *
 * Handoff triggers:
 *   - Not docked and no station param provided
 *   - multi_sell returns 0 items sold AND create_sell_order also fails
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase, extractDemandItems, travelAndDock, parseCargoItems } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface CraftAndSellParams {
  station?: string;
  recipes?: string[];
  refuel?: boolean; // default: true
  deliver_to?: "cargo" | "storage"; // default: "cargo"
}

const DEFAULT_RECIPES = ["refine_steel", "refine_copper"];

function parseParams(raw: unknown): CraftAndSellParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const params: CraftAndSellParams = {};

  if (obj.station !== undefined) {
    if (typeof obj.station !== "string" || !obj.station) {
      throw new Error("station must be a non-empty string");
    }
    params.station = obj.station;
  }

  if (obj.recipes !== undefined) {
    if (!Array.isArray(obj.recipes) || !obj.recipes.every((r) => typeof r === "string")) {
      throw new Error("recipes must be an array of strings");
    }
    params.recipes = obj.recipes as string[];
  }

  if (obj.refuel !== undefined) {
    if (typeof obj.refuel !== "boolean") {
      throw new Error("refuel must be a boolean");
    }
    params.refuel = obj.refuel;
  }

  if (obj.deliver_to !== undefined) {
    if (obj.deliver_to !== "cargo" && obj.deliver_to !== "storage") {
      throw new Error('deliver_to must be "cargo" or "storage"');
    }
    params.deliver_to = obj.deliver_to;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: CraftAndSellParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const recipes = params.recipes ?? DEFAULT_RECIPES;
  const shouldRefuel = params.refuel ?? true;

  // --- Phase 1: Init — check current dock status ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const creditsBefore = typeof player?.credits === "number" ? player.credits : undefined;
  const isDocked = !!dockedAt;
  phases.push(completePhase(initPhase, { currentPoi, isDocked, dockedAt }));

  ctx.log("info", `craft_and_sell: starting at ${currentPoi ?? "unknown"}, docked=${isDocked}`);

  // --- Phase 2: Dock if not docked ---
  if (!isDocked) {
    if (!params.station) {
      return handoff(
        "Not docked and no station param provided — need a station to dock at",
        { currentPoi },
        phases,
      );
    }

    const alreadyAtStation = currentPoi?.includes(params.station) ?? false;
    const td = await travelAndDock(ctx, params.station, { alreadyAtStation, label: "craft_and_sell" });
    phases.push(...td.phases);
    if (td.failed) return handoff(td.failed, { station: params.station }, phases);
  }

  // --- Phase 3: Craft all available recipes ---
  const itemsCrafted: string[] = [];
  for (const recipe of recipes) {
    const craftPhase = phase(`craft_${recipe}`);
    const craftArgs: Record<string, unknown> = { recipe, count: "ALL" };
    if (params.deliver_to === "storage") craftArgs.deliver_to = "storage";
    const craftResp = await ctx.client.execute("craft", craftArgs);
    if (craftResp.error) {
      // Ignore craft errors — agent may not have materials
      ctx.log("debug", `craft_and_sell: craft ${recipe} skipped (no materials?): ${JSON.stringify(craftResp.error)}`);
      phases.push(completePhase(craftPhase, { error: craftResp.error, skipped: true }));
    } else {
      itemsCrafted.push(recipe);
      phases.push(completePhase(craftPhase, craftResp.result));
      ctx.log("info", `craft_and_sell: crafted ${recipe}`);
    }
  }

  // --- Phase 4: Analyze market ---
  const marketPhase = phase("analyze_market");
  const marketResp = await ctx.client.execute("analyze_market");
  if (marketResp.error) {
    // Non-fatal: proceed without demand filtering
    ctx.log("warn", `craft_and_sell: analyze_market failed: ${JSON.stringify(marketResp.error)}`);
    phases.push(completePhase(marketPhase, { error: marketResp.error }));
  } else {
    phases.push(completePhase(marketPhase, marketResp.result));
    ctx.log("info", "craft_and_sell: market analyzed");
  }

  // --- Phase 5: Get cargo ---
  const cargoResp = await ctx.client.execute("get_cargo");
  const allCargoItems = parseCargoItems(cargoResp.result);

  const demandItems = extractDemandItems(marketResp.result);
  // If market data was available, filter strictly by demand.
  // If market failed, attempt to sell everything (no demand data to filter on).
  let itemsWithDemand: typeof allCargoItems;
  let itemsWithoutDemand: typeof allCargoItems;
  if (!marketResp.error) {
    itemsWithDemand = demandItems.size > 0
      ? allCargoItems.filter((c) => demandItems.has(c.item_id))
      : [];
    itemsWithoutDemand = demandItems.size > 0
      ? allCargoItems.filter((c) => !demandItems.has(c.item_id))
      : allCargoItems;
  } else {
    itemsWithDemand = allCargoItems;
    itemsWithoutDemand = [];
  }

  let itemsSold = 0;
  let creditsAfter: number | undefined;
  let sellOrderCreated = false;
  let sellOrdersFailed = 0;

  // --- Phase 6: Multi-sell items with demand ---
  if (itemsWithDemand.length > 0) {
    const sellPhase = phase("multi_sell");
    const sellResp = await ctx.client.execute("multi_sell", { items: itemsWithDemand });
    phases.push(completePhase(sellPhase, sellResp.result ?? sellResp.error));
    if (!sellResp.error) {
      const sellResult = sellResp.result as Record<string, unknown> | undefined;
      itemsSold = typeof sellResult?.items_sold === "number" ? sellResult.items_sold : itemsWithDemand.length;
      creditsAfter = sellResult?.credits_after as number | undefined;
      ctx.log("info", `craft_and_sell: sold ${itemsSold} items`);
    } else {
      ctx.log("warn", `craft_and_sell: multi_sell failed: ${JSON.stringify(sellResp.error)}`);
    }
  }

  // --- Phase 7: Create sell orders for remaining items ---
  for (const item of itemsWithoutDemand) {
    const orderPhase = phase(`create_sell_order_${item.item_id}`);
    const orderResp = await ctx.client.execute("create_sell_order", {
      item_id: item.item_id,
      quantity: item.quantity,
      price_mode: "market",
    });
    if (orderResp.error) {
      sellOrdersFailed++;
      ctx.log("warn", `craft_and_sell: create_sell_order for ${item.item_id} failed: ${JSON.stringify(orderResp.error)}`);
      phases.push(completePhase(orderPhase, { error: orderResp.error }));
    } else {
      sellOrderCreated = true;
      phases.push(completePhase(orderPhase, orderResp.result));
      ctx.log("info", `craft_and_sell: created sell order for ${item.item_id}`);
    }
  }

  // Handoff if nothing sold and sell orders also failed (when there was cargo to sell)
  if (itemsSold === 0 && !sellOrderCreated && allCargoItems.length > 0 && sellOrdersFailed > 0) {
    return handoff(
      "multi_sell returned 0 items sold and all create_sell_order calls failed",
      { items_crafted: itemsCrafted, items_sold: 0 },
      phases,
    );
  }

  // --- Phase 8: Refuel ---
  if (shouldRefuel) {
    const refuelPhase = phase("refuel");
    const refuelResp = await ctx.client.execute("refuel");
    phases.push(completePhase(refuelPhase, refuelResp.result ?? refuelResp.error));
    if (refuelResp.error) {
      ctx.log("warn", `craft_and_sell: refuel failed: ${JSON.stringify(refuelResp.error)}`);
    } else {
      ctx.log("info", "craft_and_sell: refueled");
    }
  }

  // --- Build summary ---
  const creditsEarned = (typeof creditsAfter === "number" && typeof creditsBefore === "number")
    ? creditsAfter - creditsBefore
    : undefined;
  const craftStr = itemsCrafted.length > 0 ? `, crafted: ${itemsCrafted.join(", ")}` : "";
  const ordersStr = sellOrderCreated ? ", sell orders created" : "";
  const creditsStr = creditsEarned !== undefined ? ` for +${creditsEarned.toLocaleString()} credits` : "";
  const summary = `Sold ${itemsSold} items${creditsStr}${craftStr}${ordersStr}`;

  ctx.log("info", `craft_and_sell: ${summary}`);

  return done(summary, {
    items_crafted: itemsCrafted,
    items_sold: itemsSold,
    credits_before: creditsBefore,
    credits_after: creditsAfter,
    credits_earned: creditsEarned,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const craftAndSellRoutine: RoutineDefinition<CraftAndSellParams> = {
  name: "craft_and_sell",
  description: "Craft available recipes and sell cargo at a docked station. Creates sell orders for items with no buyers.",
  parseParams,
  run,
};
