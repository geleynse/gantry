/**
 * salvage_loop routine — Loot wrecks at current location, then travel to station and sell cargo.
 *
 * State machine:
 *   INIT → GET_WRECKS → LOOT_WRECKS → TRAVEL_STATION → DOCK → ANALYZE_MARKET → MULTI_SELL → REFUEL → DONE
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase, checkCombat, extractDemandItems, getCargoUtilization, travelAndDock, parseCargoItems } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface SalvageLoopParams {
  station: string;
  max_wrecks?: number; // default: 5
}

function parseParams(raw: unknown): SalvageLoopParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { station: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.station !== "string" || !obj.station) {
    throw new Error("station is required (string)");
  }
  const params: SalvageLoopParams = { station: obj.station };
  if (obj.max_wrecks !== undefined) {
    if (typeof obj.max_wrecks !== "number" || obj.max_wrecks < 1) {
      throw new Error("max_wrecks must be a positive number");
    }
    params.max_wrecks = obj.max_wrecks;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: SalvageLoopParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const maxWrecks = params.max_wrecks ?? 5;

  // --- Phase 1: Init ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const creditsBefore = typeof player?.credits === "number" ? player.credits : undefined;
  phases.push(completePhase(initPhase, { creditsBefore }));

  ctx.log("info", `salvage_loop: starting, target station=${params.station}, max_wrecks=${maxWrecks}`);

  // --- Phase 2: Get wrecks ---
  const getWrecksPhase = phase("get_wrecks");
  const wrecksResp = await ctx.client.execute("get_wrecks");
  if (wrecksResp.error) {
    phases.push(completePhase(getWrecksPhase, { error: wrecksResp.error }));
    return handoff("Could not get wrecks", { error: wrecksResp.error }, phases);
  }
  const allWrecks = (wrecksResp.result as unknown[] | undefined) ?? [];
  phases.push(completePhase(getWrecksPhase, allWrecks));
  ctx.log("info", `salvage_loop: found ${allWrecks.length} wrecks`);

  if (allWrecks.length === 0) {
    // Check if we have cargo to sell — if not, nothing to do
    const earlyCargoResp = await ctx.client.execute("get_cargo");
    const earlyUtil = getCargoUtilization(earlyCargoResp);
    if (!earlyUtil || earlyUtil.used === 0) {
      ctx.log("info", "salvage_loop: no wrecks found and cargo empty — nothing to do");
      return done("No wrecks found and cargo empty", { looted_count: 0, items_sold: 0, station: params.station }, phases);
    }
    ctx.log("info", "salvage_loop: no wrecks found, but have cargo — proceeding to station to sell");
  }

  // --- Phase 3: Loot wrecks ---
  const lootPhase = phase("loot_wrecks");
  const lootedWrecks: string[] = [];
  let cargoFull = false;
  const wrecksToLoot = allWrecks.slice(0, maxWrecks);

  for (const wreck of wrecksToLoot) {
    const w = wreck as Record<string, unknown>;
    const wreckId = String(w.id || w.wreck_id || "");
    const lootResp = await ctx.client.execute("loot_wreck", { wreck_id: wreckId });
    
    if (lootResp.error) {
        const errStr = JSON.stringify(lootResp.error);
        if (errStr.includes("cargo_full")) {
            cargoFull = true;
            ctx.log("info", "salvage_loop: cargo full during loot");
            break;
        }
        ctx.log("warn", `salvage_loop: failed to loot wreck ${wreckId}`, { error: lootResp.error });
        continue;
    }
    
    lootedWrecks.push(wreckId);
    if (checkCombat(lootResp)) {
        phases.push(completePhase(lootPhase, { looted: lootedWrecks, aborted: "combat" }));
        return handoff("Combat detected during looting", { looted: lootedWrecks }, phases);
    }

    // Check cargo capacity after looting
    const cargoResp = await ctx.client.execute("get_cargo");
    const util = getCargoUtilization(cargoResp);
    if (util && util.pctFull > 90) {
        cargoFull = true;
        ctx.log("info", `salvage_loop: cargo > 90% full (${util.used}/${util.capacity})`);
        break;
    }

    await ctx.client.waitForTick();
  }
  phases.push(completePhase(lootPhase, { looted: lootedWrecks, cargoFull }));

  // --- Phase 4-5: Travel + Dock ---
  const td = await travelAndDock(ctx, params.station, { label: "salvage_loop" });
  phases.push(...td.phases);
  if (td.failed) return handoff(td.failed, { station: params.station, looted: lootedWrecks }, phases);

  // --- Phase 6: Analyze market ---
  const marketPhase = phase("analyze_market");
  const marketResp = await ctx.client.execute("analyze_market");
  if (marketResp.error) {
    phases.push(completePhase(marketPhase, { error: marketResp.error }));
    return handoff("analyze_market failed", { station: params.station, looted: lootedWrecks }, phases);
  }
  const marketData = marketResp.result;
  phases.push(completePhase(marketPhase, marketData));

  // --- Phase 7: Multi-sell ---
  const sellPhase = phase("multi_sell");
  const cargoResp = await ctx.client.execute("get_cargo");
  const allCargo = parseCargoItems(cargoResp.result);
  const demandItems = extractDemandItems(marketData);
  const itemsToSell = demandItems.size === 0 ? allCargo : allCargo.filter(c => demandItems.has(c.item_id));

  let itemsSold = 0;
  let creditsEarned = 0;

  if (itemsToSell.length > 0) {
    const sellResp = await ctx.client.execute("multi_sell", { items: itemsToSell });
    phases.push(completePhase(sellPhase, sellResp.result));
    if (!sellResp.error) {
        const sellResult = sellResp.result as Record<string, unknown> | undefined;
        itemsSold = typeof sellResult?.items_sold === "number" ? sellResult.items_sold : itemsToSell.length;
        const creditsAfter = sellResult?.credits_after;
        if (typeof creditsAfter === "number" && typeof creditsBefore === "number") {
            creditsEarned = creditsAfter - creditsBefore;
        }
    }
  } else {
    phases.push(completePhase(sellPhase, { skipped: "no_demand" }));
  }

  // --- Phase 8: Refuel ---
  const refuelPhase = phase("refuel");
  const refuelResp = await ctx.client.execute("refuel");
  phases.push(completePhase(refuelPhase, refuelResp.result ?? refuelResp.error));

  const summary = `Looted ${lootedWrecks.length} wrecks, sold ${itemsSold} items for +${creditsEarned.toLocaleString()} credits at ${params.station}`;
  ctx.log("info", `salvage_loop: ${summary}`);

  return done(summary, {
    looted_count: lootedWrecks.length,
    looted_ids: lootedWrecks,
    items_sold: itemsSold,
    credits_earned: creditsEarned,
    station: params.station
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const salvageLoopRoutine: RoutineDefinition<SalvageLoopParams> = {
  name: "salvage_loop",
  description: "Loot wrecks and sell cargo at a station.",
  parseParams,
  run,
};
