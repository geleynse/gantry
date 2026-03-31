/**
 * navigate_and_mine routine — Jump to a target system, mine at a belt, then return.
 *
 * State machine:
 *   INIT → JUMP_ROUTE (if needed) → TRAVEL_BELT → MINE_CYCLES → TRAVEL_RETURN_STATION → REFUEL → DONE
 *
 * Handoff triggers:
 *   - jump_route fails (blocked, no fuel)
 *   - travel_to belt fails after 2 retries
 *   - All mine cycles yield zero ore (belt depleted)
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, done, handoff, phase, completePhase } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface NavigateAndMineParams {
  system: string;
  belt: string;
  returnStation: string;
  cycles?: number; // default: 3
}

function parseParams(raw: unknown): NavigateAndMineParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { system, belt, returnStation }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.system !== "string" || !obj.system) {
    throw new Error("system is required (string)");
  }
  if (typeof obj.belt !== "string" || !obj.belt) {
    throw new Error("belt is required (string)");
  }
  if (typeof obj.returnStation !== "string" || !obj.returnStation) {
    throw new Error("returnStation is required (string)");
  }
  const params: NavigateAndMineParams = {
    system: obj.system,
    belt: obj.belt,
    returnStation: obj.returnStation,
  };
  if (obj.cycles !== undefined) {
    if (typeof obj.cycles !== "number" || obj.cycles < 1) {
      throw new Error("cycles must be a positive number");
    }
    params.cycles = obj.cycles;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: NavigateAndMineParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const maxCycles = params.cycles ?? 3;

  // --- Phase 1: Init — check current system ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentSystem = player?.current_system as string | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const alreadyInSystem = currentSystem?.includes(params.system) ?? false;
  phases.push(completePhase(initPhase, { currentSystem, currentPoi, alreadyInSystem }));

  ctx.log("info", `navigate_and_mine: starting in ${currentSystem ?? "unknown"}, target system=${params.system}, belt=${params.belt}, cycles=${maxCycles}`);

  // --- Phase 2: Jump to target system (if needed) ---
  if (!alreadyInSystem) {
    const jumpPhase = phase("jump_route");
    const jumpResp = await ctx.client.execute("jump_route", { destination: params.system });
    if (jumpResp.error) {
      phases.push(completePhase(jumpPhase, { error: jumpResp.error }));
      return handoff(
        `jump_route to ${params.system} failed: ${JSON.stringify(jumpResp.error)}`,
        { system: params.system },
        phases,
      );
    }
    phases.push(completePhase(jumpPhase, jumpResp.result));
    ctx.log("info", `navigate_and_mine: jumped to ${params.system}`);
    await ctx.client.waitForTick();
  }

  // --- Phase 3: Travel to belt ---
  const travelBeltPhase = phase("travel_belt");
  try {
    const travelResult = await withRetry(async () => {
      const resp = await ctx.client.execute("travel_to", { destination: params.belt });
      if (resp.error) throw new Error(`travel_to failed: ${JSON.stringify(resp.error)}`);
      return resp.result;
    }, 2);
    phases.push(completePhase(travelBeltPhase, travelResult));
    ctx.log("info", "navigate_and_mine: arrived at belt");
  } catch (err) {
    phases.push(completePhase(travelBeltPhase, { error: String(err) }));
    return handoff(
      `Travel to ${params.belt} failed after retries: ${err instanceof Error ? err.message : String(err)}`,
      { belt: params.belt },
      phases,
    );
  }

  // --- Phase 4: Mine cycles ---
  let cyclesDone = 0;
  let cargoFull = false;
  let allZeroOre = true;
  let lastCargoUsed: number | undefined;
  let lastCargoMax: number | undefined;

  for (let i = 0; i < maxCycles; i++) {
    const minePhase = phase(`mine_cycle_${i + 1}`);
    const mineResp = await ctx.client.execute("batch_mine", { count: 20 });

    if (mineResp.error) {
      const errStr = JSON.stringify(mineResp.error);
      if (errStr.includes("cargo_full")) {
        phases.push(completePhase(minePhase, { stopped: "cargo_full" }));
        cargoFull = true;
        cyclesDone++;
        allZeroOre = false;
        ctx.log("info", `navigate_and_mine: cargo full on cycle ${i + 1}`);
        break;
      }
      phases.push(completePhase(minePhase, { error: mineResp.error }));
      ctx.log("warn", `navigate_and_mine: mine error on cycle ${i + 1}: ${errStr}`);
      continue;
    }

    const mineResult = mineResp.result as Record<string, unknown> | undefined;
    const stoppedReason = mineResult?.stopped_reason as string | undefined;
    const minesCompleted = mineResult?.mines_completed as number | undefined;
    const cargoAfter = mineResult?.cargo_after as Record<string, unknown> | undefined;
    lastCargoUsed = typeof cargoAfter?.used === "number" ? cargoAfter.used : lastCargoUsed;
    lastCargoMax = typeof cargoAfter?.max === "number" ? cargoAfter.max : lastCargoMax;

    cyclesDone++;
    phases.push(completePhase(minePhase, mineResult));

    if (typeof minesCompleted === "number" && minesCompleted > 0) {
      allZeroOre = false;
    }

    if (stoppedReason === "cargo_full") {
      cargoFull = true;
      allZeroOre = false;
      ctx.log("info", `navigate_and_mine: cargo full after cycle ${i + 1}`);
      break;
    }

    ctx.log("info", `navigate_and_mine: cycle ${i + 1}/${maxCycles} complete`);

    if (i < maxCycles - 1) {
      await ctx.client.waitForTick();
    }
  }

  // Handoff if all completed cycles yielded zero ore (belt depleted)
  if (cyclesDone > 0 && allZeroOre) {
    return handoff(
      `Belt ${params.belt} appears depleted — all ${cyclesDone} cycles yielded zero ore`,
      { belt: params.belt, cycles_done: cyclesDone },
      phases,
    );
  }

  // --- Phase 5: Travel to return station ---
  const travelReturnPhase = phase("travel_return_station");
  try {
    const returnResult = await withRetry(async () => {
      const resp = await ctx.client.execute("travel_to", { destination: params.returnStation });
      if (resp.error) throw new Error(`travel_to failed: ${JSON.stringify(resp.error)}`);
      return resp.result;
    }, 2);
    phases.push(completePhase(travelReturnPhase, returnResult));
    ctx.log("info", "navigate_and_mine: returned to station");
  } catch (err) {
    // Non-fatal: we still mined successfully
    phases.push(completePhase(travelReturnPhase, { error: String(err) }));
    ctx.log("warn", `navigate_and_mine: travel to return station failed: ${String(err)}`);
  }

  // --- Phase 6: Refuel ---
  const refuelPhase = phase("refuel");
  const refuelResp = await ctx.client.execute("refuel");
  phases.push(completePhase(refuelPhase, refuelResp.result ?? refuelResp.error));
  if (refuelResp.error) {
    ctx.log("warn", `navigate_and_mine: refuel failed: ${JSON.stringify(refuelResp.error)}`);
  } else {
    ctx.log("info", "navigate_and_mine: refueled");
  }

  // --- Build summary ---
  const cargoStr = (lastCargoUsed !== undefined && lastCargoMax !== undefined)
    ? `, cargo ${lastCargoUsed}/${lastCargoMax}`
    : "";
  const fullStr = cargoFull ? " (cargo full)" : "";
  const summary = `Mined ${cyclesDone} cycles at ${params.belt} in ${params.system}${cargoStr}${fullStr}, returned to ${params.returnStation}`;

  ctx.log("info", `navigate_and_mine: ${summary}`);

  return done(summary, {
    system: params.system,
    belt: params.belt,
    return_station: params.returnStation,
    cycles_done: cyclesDone,
    cycles_requested: maxCycles,
    cargo_full: cargoFull,
    cargo_used: lastCargoUsed,
    cargo_max: lastCargoMax,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const navigateAndMineRoutine: RoutineDefinition<NavigateAndMineParams> = {
  name: "navigate_and_mine",
  description: "Jump to a target system, mine at a belt, then return to a station and refuel.",
  parseParams,
  run,
};
