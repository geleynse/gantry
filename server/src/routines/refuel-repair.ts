/**
 * refuel_repair routine — Travel to station, dock, refuel if fuel < 80%, repair if hull < 90%.
 *
 * State machine:
 *   INIT → [TRAVEL_STATION → DOCK] → REFUEL → REPAIR → DONE
 *
 * Implemented — Phase 2
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase, travelAndDock } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface RefuelRepairParams {
  station: string;
}

function parseParams(raw: unknown): RefuelRepairParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { station: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.station !== "string" || !obj.station) {
    throw new Error("station is required (string)");
  }
  return { station: obj.station };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: RefuelRepairParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Init — check current location and docked status ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;
  const alreadyAtStation = currentPoi?.includes(params.station) ?? false;
  const alreadyDocked = !!dockedAt && alreadyAtStation;
  phases.push(completePhase(initPhase, { currentPoi, alreadyAtStation, alreadyDocked }));

  ctx.log("info", `refuel_repair: starting at ${currentPoi ?? "unknown"}, target=${params.station}`);

  // --- Phases 2-3: Travel + Dock ---
  const td = await travelAndDock(ctx, params.station, { alreadyAtStation, alreadyDocked, label: "refuel_repair" });
  phases.push(...td.phases);
  if (td.failed) return handoff(td.failed, { station: params.station }, phases);

  // --- Phase 4: Check fuel and hull ---
  const statusResp = await ctx.client.execute("get_status");
  const status = statusResp.result as Record<string, unknown> | undefined;
  const ship = status?.ship as Record<string, unknown> | undefined;

  let fuelCurrent = typeof ship?.fuel === "number" ? ship.fuel : undefined;
  let fuelMax = typeof ship?.fuel_max === "number" ? ship.fuel_max : undefined;
  let hullCurrent = typeof ship?.hull === "number" ? ship.hull : undefined;
  let hullMax = typeof ship?.hull_max === "number" ? ship.hull_max : undefined;

  const fuelPct = (fuelCurrent !== undefined && fuelMax !== undefined && fuelMax > 0)
    ? (fuelCurrent / fuelMax) * 100 : null;
  const hullPct = (hullCurrent !== undefined && hullMax !== undefined && hullMax > 0)
    ? (hullCurrent / hullMax) * 100 : null;

  if (fuelPct === null || hullPct === null) {
    return handoff(
      "Fuel or hull data unavailable from get_status — cannot determine refuel/repair needs",
      { station: params.station, ship_data: ship ?? null, fuel_pct: fuelPct, hull_pct: hullPct },
      phases,
    );
  }

  let didRefuel = false;
  let didRepair = false;

  // --- Phase 5: Refuel if fuel < 80% ---
  if (fuelPct < 80) {
    const refuelPhase = phase("refuel");
    const refuelResp = await ctx.client.execute("refuel");
    if (refuelResp.error) {
      ctx.log("warn", `refuel_repair: refuel error: ${JSON.stringify(refuelResp.error)}`);
      phases.push(completePhase(refuelPhase, { error: refuelResp.error }));
    } else {
      const refuelResult = refuelResp.result as Record<string, unknown> | undefined;
      fuelCurrent = typeof refuelResult?.fuel_after === "number" ? refuelResult.fuel_after : fuelMax;
      didRefuel = true;
      phases.push(completePhase(refuelPhase, refuelResult));
      ctx.log("info", `refuel_repair: refueled to ${fuelCurrent}/${fuelMax}`);
    }
  }

  // --- Phase 6: Repair if hull < 90% ---
  if (hullPct < 90) {
    const repairPhase = phase("repair");
    const repairResp = await ctx.client.execute("repair");
    if (repairResp.error) {
      ctx.log("warn", `refuel_repair: repair error: ${JSON.stringify(repairResp.error)}`);
      phases.push(completePhase(repairPhase, { error: repairResp.error }));
    } else {
      const repairResult = repairResp.result as Record<string, unknown> | undefined;
      hullCurrent = typeof repairResult?.hull_after === "number" ? repairResult.hull_after : hullMax;
      didRepair = true;
      phases.push(completePhase(repairPhase, repairResult));
      ctx.log("info", `refuel_repair: repaired to ${hullCurrent}/${hullMax}`);
    }
  }

  // --- Build summary ---
  const parts: string[] = [];
  if (didRefuel) parts.push(`Refueled to ${fuelCurrent ?? "?"}/${fuelMax ?? "?"}`);
  if (didRepair) parts.push(`repaired to ${hullCurrent ?? "?"}/${hullMax ?? "?"}`);
  if (parts.length === 0) parts.push("No refuel or repair needed");

  const summary = `${parts.join(", ")} at ${params.station}`;
  ctx.log("info", `refuel_repair: ${summary}`);

  return done(summary, {
    station: params.station,
    fuel_before_pct: Math.round(fuelPct),
    hull_before_pct: Math.round(hullPct),
    did_refuel: didRefuel,
    did_repair: didRepair,
    fuel_after: fuelCurrent,
    fuel_max: fuelMax,
    hull_after: hullCurrent,
    hull_max: hullMax,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const refuelRepairRoutine: RoutineDefinition<RefuelRepairParams> = {
  name: "refuel_repair",
  description: "Travel to station, dock, refuel if fuel < 80%, repair if hull < 90%.",
  parseParams,
  run,
};
