/**
 * sell_cycle routine — Travel to a station and sell all cargo with demand.
 *
 * State machine:
 *   INIT → TRAVEL_STATION → DOCK → ANALYZE_MARKET → MULTI_SELL → DONE
 *
 * Inputs:
 *   - station: POI ID or name of the station to sell at
 *   - items?: specific items to sell (default: all cargo with demand)
 *
 * Handoff triggers:
 *   - 0 credits earned (no demand at station)
 *   - Travel fails after retries
 *
 * Implemented — Phase 1B
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase, extractDemandItems, travelAndDock, parseCargoItems } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface SellCycleParams {
  station: string;
  items?: Array<{ item_id: string; quantity: number }>;
}

function parseParams(raw: unknown): SellCycleParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { station: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.station !== "string" || !obj.station) {
    throw new Error("station is required (string)");
  }
  const params: SellCycleParams = { station: obj.station };
  if (Array.isArray(obj.items)) {
    params.items = obj.items.map((item: unknown) => {
      const i = item as Record<string, unknown>;
      if (typeof i.item_id !== "string" || typeof i.quantity !== "number") {
        throw new Error("items must be [{item_id: string, quantity: number}]");
      }
      return { item_id: i.item_id, quantity: i.quantity };
    });
  }
  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: SellCycleParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Check current location ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;
  const creditsBefore = typeof player?.credits === "number" ? player.credits : undefined;

  const alreadyAtStation = currentPoi?.includes(params.station) ?? false;
  const alreadyDocked = !!dockedAt && alreadyAtStation;
  phases.push(completePhase(initPhase, { currentPoi, alreadyAtStation, alreadyDocked }));

  ctx.log("info", `sell_cycle: starting at ${currentPoi ?? "unknown"}, target=${params.station}`);

  // --- Phase 2-3: Travel + Dock ---
  const td = await travelAndDock(ctx, params.station, { alreadyAtStation, alreadyDocked, label: "sell_cycle" });
  phases.push(...td.phases);
  if (td.failed) return handoff(td.failed, { station: params.station }, phases);

  // --- Phase 4: Analyze market ---
  const marketPhase = phase("analyze_market");
  const marketResp = await ctx.client.execute("analyze_market");
  if (marketResp.error) {
    phases.push(completePhase(marketPhase, { error: marketResp.error }));
    return handoff(
      `analyze_market failed at ${params.station}: ${JSON.stringify(marketResp.error)}`,
      { station: params.station },
      phases,
    );
  }
  phases.push(completePhase(marketPhase, marketResp.result));
  ctx.log("info", "sell_cycle: market analyzed");

  // --- Phase 4: Determine what to sell ---
  let itemsToSell = params.items;

  if (!itemsToSell) {
    const cargoResp = await ctx.client.execute("get_cargo");
    const allCargo = parseCargoItems(cargoResp.result);
    if (allCargo.length > 0) {
      const demandItems = extractDemandItems(marketResp.result);
      itemsToSell = demandItems.size === 0 ? allCargo : allCargo.filter((c) => demandItems.has(c.item_id));
    }
  }

  if (!itemsToSell || itemsToSell.length === 0) {
    phases.push(completePhase(phase("multi_sell"), { skipped: "no_items" }));
    return done("No items to sell (empty cargo or no demand)", { station: params.station, items_sold: 0 }, phases);
  }

  // --- Phase 5: Multi-sell ---
  const sellPhase = phase("multi_sell");
  const sellResp = await ctx.client.execute("multi_sell", { items: itemsToSell });
  phases.push(completePhase(sellPhase, sellResp.result));

  if (sellResp.error) {
    return handoff(
      `multi_sell failed: ${JSON.stringify(sellResp.error)}`,
      { station: params.station },
      phases,
    );
  }

  // --- Phase 6: Check result ---
  const sellResult = sellResp.result as Record<string, unknown> | undefined;
  const creditsAfter = sellResult?.credits_after as number | undefined;
  const creditsDelta = (typeof creditsAfter === "number" && typeof creditsBefore === "number")
    ? creditsAfter - creditsBefore
    : undefined;
  const itemsSold = sellResult?.items_sold ?? itemsToSell.length;

  // Check for 0-credit warning (no demand)
  const warning = sellResult?.warning as string | undefined;
  if (warning && warning.includes("0 credits earned")) {
    return handoff(
      `0 credits earned at ${params.station} — no demand for your items`,
      { station: params.station, warning, credits_after: creditsAfter },
      phases,
    );
  }

  const summary = creditsDelta !== undefined
    ? `Sold ${itemsSold} items for +${creditsDelta.toLocaleString()} credits at ${params.station}`
    : `Sold ${itemsSold} items at ${params.station}`;

  ctx.log("info", `sell_cycle: ${summary}`);

  return done(summary, {
    station: params.station,
    items_sold: itemsSold,
    credits_before: creditsBefore,
    credits_after: creditsAfter,
    credits_earned: creditsDelta,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export routine definition
// ---------------------------------------------------------------------------

export const sellCycleRoutine: RoutineDefinition<SellCycleParams> = {
  name: "sell_cycle",
  description: "Travel to a station and sell all cargo with demand. Returns credit summary.",
  parseParams,
  run,
};
