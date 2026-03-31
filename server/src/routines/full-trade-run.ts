/**
 * full_trade_run routine — The "one routine" economic cycle.
 * Chains mining → crafting → selling in one call.
 *
 * State machine:
 *   INIT → JUMP (optional) → TRAVEL_BELT → MINE → TRAVEL_STATION → DOCK →
 *   ANALYZE_MARKET → CRAFT → MULTI_SELL → CREATE_SELL_ORDERS → REFUEL → DONE
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, getCargoUtilization, done, handoff, phase, completePhase, checkCombat, extractDemandItems, parseCargoItems } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface FullTradeRunParams {
  target_system?: string;
  belt: string;
  station: string;
  cycles?: number; // default: 3
}

function parseParams(raw: unknown): FullTradeRunParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.belt !== "string" || !obj.belt) {
    throw new Error("belt is required (string)");
  }
  if (typeof obj.station !== "string" || !obj.station) {
    throw new Error("station is required (string)");
  }

  const params: FullTradeRunParams = {
    belt: obj.belt,
    station: obj.station,
  };

  if (obj.target_system !== undefined) {
    if (typeof obj.target_system !== "string") {
      throw new Error("target_system must be a string");
    }
    params.target_system = obj.target_system;
  }

  if (obj.cycles !== undefined) {
    if (typeof obj.cycles !== "number" || obj.cycles < 1) {
      throw new Error("cycles must be a positive number");
    }
    params.cycles = obj.cycles;
  }
  return params;
}

// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: FullTradeRunParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const maxCycles = params.cycles ?? 3;
  let oresMined = 0;
  let itemsCrafted: string[] = [];
  let itemsSold = 0;
  let sellOrderCount = 0;
  
  // --- Init ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const creditsBefore = typeof player?.credits === "number" ? player.credits : undefined;
  const currentSystem = player?.current_system as string | undefined;
  phases.push(completePhase(initPhase, { currentSystem, creditsBefore }));

  ctx.log("info", `full_trade_run: starting. target_system=${params.target_system}, belt=${params.belt}, station=${params.station}, cycles=${maxCycles}`);

  // --- Jump (if needed) ---
  if (params.target_system && currentSystem?.toLowerCase() !== params.target_system.toLowerCase()) {
    const jumpPhase = phase("jump_route");
    const jumpResp = await ctx.client.execute("jump_route", { destination: params.target_system });
    if (checkCombat(jumpResp)) return handoff("Combat detected during jump", {}, phases);
    if (jumpResp.error) {
      phases.push(completePhase(jumpPhase, { error: jumpResp.error }));
      return handoff(`Jump to ${params.target_system} failed: ${JSON.stringify(jumpResp.error)}`, {}, phases);
    }
    phases.push(completePhase(jumpPhase, jumpResp.result));
    await ctx.client.waitForTick();
  }

  // --- Travel to belt ---
  const travelBeltPhase = phase("travel_belt");
  try {
    const travelResult = await withRetry(() => ctx.client.execute("travel_to", { destination: params.belt }));
    if (checkCombat(travelResult)) return handoff("Combat detected while traveling to belt", {}, phases);
    phases.push(completePhase(travelBeltPhase, travelResult.result));
  } catch (err) {
    phases.push(completePhase(travelBeltPhase, { error: String(err) }));
    return handoff(`Travel to ${params.belt} failed: ${String(err)}`, {}, phases);
  }

  // --- Mine ---
  const minePhase = phase("batch_mine");
  let miningStopped = "cycles_done";
  let cargoUtil: any = null;
  
  // Refactor to loop of smaller batches to check cargo utilization
  // Total count = maxCycles * 10. Each batch = 10 units.
  for (let i = 0; i < maxCycles; i++) {
    // Check utilization BEFORE each batch
    const cargoCheck = await ctx.client.execute("get_cargo");
    const util = getCargoUtilization(cargoCheck);
    if (util) {
      cargoUtil = util;
      if (util.pctFull >= 90) {
        miningStopped = "cargo_threshold";
        ctx.log("info", `full_trade_run: cargo threshold reached (${util.pctFull.toFixed(1)}%), stopping mining.`);
        break;
      }
    }

    const mineResp = await ctx.client.execute("batch_mine", { count: 10 });
    if (checkCombat(mineResp)) return handoff("Combat detected during mining", {}, phases);
    
    if (mineResp.error) {
        const errStr = JSON.stringify(mineResp.error);
        if (errStr.includes("cargo_full")) {
            miningStopped = "cargo_full";
            break;
        }
        ctx.log("warn", `full_trade_run: mine batch ${i+1} failed: ${errStr}`);
        break; 
    }

    const mineResult = mineResp.result as Record<string, unknown> | undefined;
    oresMined += (mineResult?.mines_completed as number) ?? (mineResult?.ores_mined as number) ?? 0;
    
    if (mineResult?.stopped_reason === "cargo_full") {
        miningStopped = "cargo_full";
        break;
    }
    
    if (i < maxCycles - 1) {
        await ctx.client.waitForTick();
    }
  }
  phases.push(completePhase(minePhase, { ores_mined: oresMined, stopped_reason: miningStopped, utilization: cargoUtil }));
  
  // --- Travel to station ---
  const travelStationPhase = phase("travel_station");
  try {
    const travelResult = await withRetry(() => ctx.client.execute("travel_to", { destination: params.station }));
    if (checkCombat(travelResult)) return handoff("Combat detected while traveling to station", {}, phases);
    phases.push(completePhase(travelStationPhase, travelResult.result));
  } catch (err) {
    phases.push(completePhase(travelStationPhase, { error: String(err) }));
    return handoff(`Travel to ${params.station} failed: ${String(err)}`, {}, phases);
  }

  // --- Dock ---
  const dockPhase = phase("dock");
  const dockResp = await ctx.client.execute("dock");
  if (dockResp.error && !JSON.stringify(dockResp.error).includes("already docked")) {
    phases.push(completePhase(dockPhase, { error: dockResp.error }));
    return handoff(`Docking at ${params.station} failed: ${JSON.stringify(dockResp.error)}`, {}, phases);
  }
  phases.push(completePhase(dockPhase, dockResp.result));
  await ctx.client.waitForTick();
  
  // --- Analyze Market ---
  const marketPhase = phase("analyze_market");
  const marketResp = await ctx.client.execute("analyze_market");
  phases.push(completePhase(marketPhase, marketResp.result ?? marketResp.error));
  const demandItems = extractDemandItems(marketResp.result);

  // --- Craft ---
  const craftPhase = phase("craft");
  const craftResp = await ctx.client.execute("craft", { count: "ALL" });
  if(craftResp.result) {
    const crafted = (craftResp.result as any).items_crafted as any[];
    if(crafted) itemsCrafted = crafted.map(c => c.item_id || c.id);
  }
  phases.push(completePhase(craftPhase, craftResp.result ?? craftResp.error));

  // --- Multi-sell ---
  const cargoResp = await ctx.client.execute("get_cargo");
  const cargoItems = parseCargoItems(cargoResp.result);
  const itemsToSell = cargoItems.filter(c => demandItems.has(c.item_id));
  if (itemsToSell.length > 0) {
    const sellPhase = phase("multi_sell");
    const sellResp = await ctx.client.execute("multi_sell", { items: itemsToSell });
    if(sellResp.result) itemsSold = (sellResp.result as any).items_sold ?? 0;
    phases.push(completePhase(sellPhase, sellResp.result ?? sellResp.error));
  }
  
  // --- Create sell orders ---
  const itemsToOrder = cargoItems.filter(c => !demandItems.has(c.item_id));
  if (itemsToOrder.length > 0) {
    const orderPhase = phase("create_sell_orders");
    let ordersCreated = 0;
    for (const item of itemsToOrder) {
      const orderResp = await ctx.client.execute("create_sell_order", { item_id: item.item_id, quantity: item.quantity, price_mode: "market" });
      if(!orderResp.error) ordersCreated++;
    }
    sellOrderCount = ordersCreated;
    phases.push(completePhase(orderPhase, { orders_created: ordersCreated, items: itemsToOrder.map(i => i.item_id) }));
  }

  // --- Refuel ---
  const refuelPhase = phase("refuel");
  const refuelResp = await ctx.client.execute("refuel");
  phases.push(completePhase(refuelPhase, refuelResp.result ?? refuelResp.error));
  const fuelStatus = (refuelResp.result as any)?.fuel;

  // --- Summary ---
  const finalStatus = ctx.statusCache.get(ctx.agentName)?.data?.player as Record<string, unknown> | undefined;
  const creditsAfter = typeof finalStatus?.credits === "number" ? finalStatus.credits : undefined;
  const creditsEarned = (creditsBefore !== undefined && creditsAfter !== undefined) ? creditsAfter - creditsBefore : 0;
  
  const summary = `Full trade run complete. Mined ${oresMined} ore, crafted ${itemsCrafted.length} types of items, sold ${itemsSold} items, and created ${sellOrderCount} sell orders. Earned ${creditsEarned} credits. Fuel: ${fuelStatus ?? 'unknown'}.`;

  return done(summary, {
    ores_mined: oresMined,
    items_crafted: itemsCrafted,
    items_sold: itemsSold,
    sell_orders_created: sellOrderCount,
    credits_earned: creditsEarned,
    fuel_status: fuelStatus
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const fullTradeRunRoutine: RoutineDefinition<FullTradeRunParams> = {
  name: "full_trade_run",
  description: "Performs a full economic cycle: jump, mine, travel, dock, craft, sell, and refuel.",
  parseParams,
  run,
};
