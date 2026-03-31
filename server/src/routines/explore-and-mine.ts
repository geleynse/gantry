/**
 * explore_and_mine routine — Jump to system, explore, mine at any asteroid belts found,
 * then return to a station to sell.
 *
 * State machine:
 *   INIT → JUMP_TARGET → GET_SYSTEM → [TRAVEL_BELT → MINE] × belts → TRAVEL_STATION → SELL → DONE
 *
 * Handoff triggers:
 *   - Jump fails
 *   - No belts found in system (hands off to agent for decision)
 *   - Combat detected
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, done, handoff, phase, completePhase, checkCombat, getCargoUtilization, travelAndDock } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ExploreAndMineParams {
  system: string;
  returnStation: string;
  cycles?: number;     // mine cycles per belt (default: 3)
  maxBelts?: number;   // max belts to mine (default: 2)
}

function parseParams(raw: unknown): ExploreAndMineParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { system, returnStation }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.system !== "string" || !obj.system) {
    throw new Error("system is required (string)");
  }
  if (typeof obj.returnStation !== "string" || !obj.returnStation) {
    throw new Error("returnStation is required (string)");
  }
  return {
    system: obj.system,
    returnStation: obj.returnStation,
    cycles: typeof obj.cycles === "number" ? obj.cycles : undefined,
    maxBelts: typeof obj.maxBelts === "number" ? obj.maxBelts : undefined,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, rawParams: ExploreAndMineParams): Promise<RoutineResult> {
  const cycles = rawParams.cycles ?? 3;
  const maxBelts = rawParams.maxBelts ?? 2;
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Init ---
  const initPhase = phase("init");
  const statusResp = await ctx.client.execute("get_status");
  const status = statusResp.result as Record<string, unknown> | undefined;
  const player = status?.player as Record<string, unknown> | undefined;
  const currentSystem = player?.current_system as string | undefined;
  const needsJump = currentSystem !== rawParams.system;
  phases.push(completePhase(initPhase, { currentSystem, needsJump }));

  ctx.log("info", `explore_and_mine: at ${currentSystem ?? "unknown"}, target=${rawParams.system}`);

  // --- Phase 2: Jump to target system ---
  if (needsJump) {
    const jumpPhase = phase("jump_route");
    try {
      const jumpResult = await withRetry(async () => {
        const resp = await ctx.client.execute("jump_route", { destination: rawParams.system });
        if (resp.error) throw new Error(`jump_route failed: ${JSON.stringify(resp.error)}`);
        return resp.result;
      }, 2);
      phases.push(completePhase(jumpPhase, jumpResult));
      if (checkCombat(jumpResult)) {
        return handoff("Combat detected during jump", { system: rawParams.system }, phases);
      }
      ctx.log("info", `explore_and_mine: arrived in ${rawParams.system}`);
    } catch (err) {
      phases.push(completePhase(jumpPhase, { error: String(err) }));
      return handoff(
        `Jump to ${rawParams.system} failed: ${err instanceof Error ? err.message : String(err)}`,
        { system: rawParams.system },
        phases,
      );
    }
  }

  // --- Phase 3: Get system info to find belts ---
  const getSystemPhase = phase("get_system");
  const systemResp = await ctx.client.execute("get_system", { system_id: rawParams.system });
  if (systemResp.error) {
    phases.push(completePhase(getSystemPhase, { error: systemResp.error }));
    return handoff(`Could not get system info: ${JSON.stringify(systemResp.error)}`, {}, phases);
  }
  const systemData = systemResp.result as Record<string, unknown>;
  phases.push(completePhase(getSystemPhase, systemData));

  // Find asteroid belts from POIs
  const pois = (systemData?.pois || systemData?.points_of_interest || []) as Array<Record<string, unknown>>;
  const belts = pois.filter(p => {
    const name = String(p.name || p.id || "").toLowerCase();
    const type = String(p.type || "").toLowerCase();
    return type.includes("belt") || type.includes("asteroid") || name.includes("belt") || name.includes("asteroid");
  }).slice(0, maxBelts);

  ctx.log("info", `explore_and_mine: found ${belts.length} belts in ${rawParams.system}`);

  if (belts.length === 0) {
    return handoff(
      `No asteroid belts found in ${rawParams.system} (${pois.length} POIs found)`,
      { system: rawParams.system, pois: pois.map(p => p.name || p.id) },
      phases,
    );
  }

  // --- Phase 4: Mine at each belt ---
  let totalOre = 0;
  let totalCycles = 0;
  const beltsMined: string[] = [];

  for (const belt of belts) {
    const beltId = String(belt.id || belt.name);
    const beltPhase = phase(`mine_belt_${beltId}`);

    // Travel to belt
    const travelResp = await ctx.client.execute("travel_to", { destination: beltId });
    if (travelResp.error) {
      ctx.log("warn", `explore_and_mine: travel to ${beltId} failed`, { error: travelResp.error });
      phases.push(completePhase(beltPhase, { error: travelResp.error, skipped: true }));
      continue;
    }
    if (checkCombat(travelResp)) {
      phases.push(completePhase(beltPhase, { aborted: "combat" }));
      return handoff("Combat detected during travel to belt", { belt: beltId }, phases);
    }

    // Mine
    const mineResp = await ctx.client.execute("batch_mine", { cycles });
    if (mineResp.error) {
      ctx.log("warn", `explore_and_mine: mining at ${beltId} failed`, { error: mineResp.error });
      phases.push(completePhase(beltPhase, { error: mineResp.error }));
      continue;
    }

    const mineResult = mineResp.result as Record<string, unknown> | undefined;
    const oresCompleted = typeof mineResult?.mines_completed === "number" ? mineResult.mines_completed : 0;
    totalOre += oresCompleted;
    totalCycles += cycles;
    beltsMined.push(beltId);
    phases.push(completePhase(beltPhase, mineResult));
    ctx.log("info", `explore_and_mine: mined ${oresCompleted} at ${beltId}`);

    // Check cargo — stop mining if near full
    const cargoResp = await ctx.client.execute("get_cargo");
    const cargo = getCargoUtilization(cargoResp);
    if (cargo && cargo.pctFull > 90) {
      ctx.log("info", "explore_and_mine: cargo near full, stopping mining");
      break;
    }
  }

  // --- Phase 5: Return to station and sell ---
  const td = await travelAndDock(ctx, rawParams.returnStation, { label: "explore_and_mine" });
  phases.push(...td.phases);
  if (td.failed) {
    return handoff(
      `Mined ${totalOre} ore at ${beltsMined.length} belts but could not return to ${rawParams.returnStation}`,
      { belts_mined: beltsMined, total_ore: totalOre },
      phases,
    );
  }

  // Sell
  let itemsSold = 0;
  const cargoCheck = await ctx.client.execute("get_cargo");
  const cargo = getCargoUtilization(cargoCheck);
  if (cargo && cargo.used > 0) {
    await ctx.client.execute("analyze_market");
    const sellPhase = phase("sell");
    const sellResp = await ctx.client.execute("multi_sell");
    if (!sellResp.error) {
      const sellResult = sellResp.result as Record<string, unknown> | undefined;
      itemsSold = typeof sellResult?.items_sold === "number" ? sellResult.items_sold : 0;
    }
    phases.push(completePhase(sellPhase, sellResp.result ?? sellResp.error));
  }

  const summary = `Explored ${rawParams.system}: mined ${totalOre} ore at ${beltsMined.length} belt(s), sold ${itemsSold} items at ${rawParams.returnStation}`;
  ctx.log("info", `explore_and_mine: ${summary}`);

  return done(summary, {
    system: rawParams.system,
    belts_mined: beltsMined,
    total_ore: totalOre,
    items_sold: itemsSold,
    return_station: rawParams.returnStation,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const exploreAndMineRoutine: RoutineDefinition<ExploreAndMineParams> = {
  name: "explore_and_mine",
  description: "Jump to system, find asteroid belts, mine at them, return to station to sell.",
  parseParams,
  run,
};
