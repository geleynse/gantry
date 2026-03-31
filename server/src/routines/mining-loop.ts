/**
 * mining_loop routine — Travel to a belt, mine until cargo full or cycles exhausted.
 *
 * State machine:
 *   INIT → TRAVEL_BELT → MINE_CYCLE(repeat) → DONE
 *
 * Implemented — Phase 2
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, getCargoUtilization, done, handoff, phase, completePhase } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface MiningLoopParams {
  belt: string;
  cycles?: number; // default: 3
}

function parseParams(raw: unknown): MiningLoopParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { belt: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.belt !== "string" || !obj.belt) {
    throw new Error("belt is required (string)");
  }
  const params: MiningLoopParams = { belt: obj.belt };
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

async function run(ctx: RoutineContext, params: MiningLoopParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const maxCycles = params.cycles ?? 3;

  // --- Phase 1: Init — check current location ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const alreadyAtBelt = currentPoi?.includes(params.belt) ?? false;
  phases.push(completePhase(initPhase, { currentPoi, alreadyAtBelt }));

  ctx.log("info", `mining_loop: starting at ${currentPoi ?? "unknown"}, target belt=${params.belt}, cycles=${maxCycles}`);

  // --- Phase 2: Travel to belt (if needed) ---
  if (!alreadyAtBelt) {
    const travelPhase = phase("travel_belt");
    try {
      const travelResult = await withRetry(async () => {
        const resp = await ctx.client.execute("travel_to", { destination: params.belt });
        if (resp.error) throw new Error(`travel_to failed: ${JSON.stringify(resp.error)}`);
        return resp.result;
      }, 2);
      phases.push(completePhase(travelPhase, travelResult));
      ctx.log("info", "mining_loop: arrived at belt");
    } catch (err) {
      phases.push(completePhase(travelPhase, { error: String(err) }));
      return handoff(
        `Travel to ${params.belt} failed after retries: ${err instanceof Error ? err.message : String(err)}`,
        { belt: params.belt },
        phases,
      );
    }
  }

  // --- Phase 3: Mine cycles ---
  let cyclesDone = 0;
  let cargoFull = false;
  let lastCargoUsed: number | undefined;
  let lastCargoMax: number | undefined;

  for (let i = 0; i < maxCycles; i++) {
    const minePhase = phase(`mine_cycle_${i + 1}`);

    // BEFORE EACH CYCLE: Check utilization
    const cargoCheck = await ctx.client.execute("get_cargo");
    const util = getCargoUtilization(cargoCheck);
    if (util) {
      lastCargoUsed = util.used;
      lastCargoMax = util.capacity;
      if (util.pctFull >= 90) {
        phases.push(completePhase(minePhase, { stopped: "cargo_threshold", utilization: util }));
        cargoFull = true;
        ctx.log("info", `mining_loop: cargo threshold reached (${util.pctFull.toFixed(1)}%) on cycle ${i + 1}`);
        break;
      }
    }

    const mineResp = await ctx.client.execute("batch_mine", { count: 20 });

    if (mineResp.error) {
      const errStr = JSON.stringify(mineResp.error);
      // cargo_full is not an error — it means we're done mining
      if (errStr.includes("cargo_full")) {
        phases.push(completePhase(minePhase, { stopped: "cargo_full" }));
        cargoFull = true;
        cyclesDone++;
        ctx.log("info", `mining_loop: cargo full on cycle ${i + 1}`);
        break;
      }
      phases.push(completePhase(minePhase, { error: mineResp.error }));
      ctx.log("warn", `mining_loop: mine error on cycle ${i + 1}: ${errStr}`);
      // Continue to next cycle on non-fatal errors
      continue;
    }

    const mineResult = mineResp.result as Record<string, unknown> | undefined;
    const stoppedReason = mineResult?.stopped_reason as string | undefined;

    // Extract cargo info
    const cargoAfter = mineResult?.cargo_after as Record<string, unknown> | undefined;
    lastCargoUsed = typeof cargoAfter?.used === "number" ? cargoAfter.used : lastCargoUsed;
    lastCargoMax = typeof cargoAfter?.max === "number" ? cargoAfter.max : lastCargoMax;

    cyclesDone++;
    phases.push(completePhase(minePhase, mineResult));

    if (stoppedReason === "cargo_full") {
      cargoFull = true;
      ctx.log("info", `mining_loop: cargo full after cycle ${i + 1}`);
      break;
    }

    if (stoppedReason === "depleted") {
      ctx.log("info", `mining_loop: belt depleted after cycle ${i + 1}, stopping`);
      break;
    }

    ctx.log("info", `mining_loop: cycle ${i + 1}/${maxCycles} complete`);

    // Wait a tick between cycles
    if (i < maxCycles - 1) {
      await ctx.client.waitForTick();
    }
  }

  // --- Build summary ---
  const cargoStr = (lastCargoUsed !== undefined && lastCargoMax !== undefined)
    ? `, cargo ${lastCargoUsed}/${lastCargoMax}`
    : "";
  const fullStr = cargoFull ? " (cargo full)" : "";
  const summary = `Mined ${cyclesDone} cycles at ${params.belt}${cargoStr}${fullStr}`;

  ctx.log("info", `mining_loop: ${summary}`);

  return done(summary, {
    belt: params.belt,
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

export const miningLoopRoutine: RoutineDefinition<MiningLoopParams> = {
  name: "mining_loop",
  description: "Travel to a belt and mine until cargo is full or cycles exhausted.",
  parseParams,
  run,
};
