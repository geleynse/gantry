/**
 * navigate_home routine — Return to home station: travel, dock, refuel, repair, sell.
 *
 * State machine:
 *   INIT → JUMP_ROUTE (if different system) → TRAVEL_STATION → DOCK → REFUEL → REPAIR → SELL → DONE
 *
 * Handoff triggers:
 *   - jump_route fails (blocked, no fuel)
 *   - travel_to station fails after 2 retries
 *   - Combat detected mid-travel
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, done, handoff, phase, completePhase, checkCombat, getCargoUtilization, travelAndDock } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface NavigateHomeParams {
  station: string;
  system?: string;   // target system if cross-system travel needed
  sell?: boolean;     // sell cargo at station (default: true)
  refuel?: boolean;   // refuel at station (default: true)
  repair?: boolean;   // repair at station (default: true)
}

function parseParams(raw: unknown): NavigateHomeParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { station: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.station !== "string" || !obj.station) {
    throw new Error("station is required (string)");
  }
  return {
    station: obj.station,
    system: typeof obj.system === "string" ? obj.system : undefined,
    sell: obj.sell !== false,     // default true
    refuel: obj.refuel !== false, // default true
    repair: obj.repair !== false, // default true
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, rawParams: NavigateHomeParams): Promise<RoutineResult> {
  const params = { ...rawParams, sell: rawParams.sell !== false, refuel: rawParams.refuel !== false, repair: rawParams.repair !== false };
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Init — check current location ---
  const initPhase = phase("init");
  const statusResp = await ctx.client.execute("get_status");
  const status = statusResp.result as Record<string, unknown> | undefined;
  const player = status?.player as Record<string, unknown> | undefined;
  const currentSystem = player?.current_system as string | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;

  const alreadyAtStation = currentPoi?.includes(params.station) ?? false;
  const alreadyDocked = !!dockedAt && alreadyAtStation;
  const needsJump = params.system && currentSystem !== params.system;

  phases.push(completePhase(initPhase, { currentSystem, currentPoi, alreadyAtStation, alreadyDocked, needsJump }));
  ctx.log("info", `navigate_home: at ${currentPoi ?? "unknown"} in ${currentSystem ?? "unknown"}, target=${params.station}`);

  // --- Phase 2: Jump to target system (if cross-system) ---
  if (needsJump) {
    const jumpPhase = phase("jump_route");
    try {
      const jumpResult = await withRetry(async () => {
        const resp = await ctx.client.execute("jump_route", { destination: params.system });
        if (resp.error) throw new Error(`jump_route failed: ${JSON.stringify(resp.error)}`);
        return resp.result;
      }, 2);
      phases.push(completePhase(jumpPhase, jumpResult));
      ctx.log("info", `navigate_home: arrived in ${params.system}`);

      if (checkCombat(jumpResult)) {
        return handoff("Combat detected during jump", { system: params.system }, phases);
      }
    } catch (err) {
      phases.push(completePhase(jumpPhase, { error: String(err) }));
      return handoff(
        `Jump to ${params.system} failed: ${err instanceof Error ? err.message : String(err)}`,
        { system: params.system },
        phases,
      );
    }
  }

  // --- Phase 3-4: Travel + Dock ---
  const td = await travelAndDock(ctx, params.station, { alreadyAtStation, alreadyDocked, label: "navigate_home" });
  phases.push(...td.phases);
  if (td.failed) return handoff(td.failed, { station: params.station }, phases);

  // --- Phase 5: Refuel ---
  // Re-fetch status after docking for accurate fuel/hull readings
  const freshStatusResp = await ctx.client.execute("get_status");
  const freshStatus = freshStatusResp.result as Record<string, unknown> | undefined;
  const ship = freshStatus?.ship as Record<string, unknown> | undefined;
  let didRefuel = false;
  if (params.refuel) {
    const fuelCurrent = typeof ship?.fuel === "number" ? ship.fuel : undefined;
    const fuelMax = typeof ship?.fuel_max === "number" ? ship.fuel_max : undefined;
    const fuelPct = (fuelCurrent !== undefined && fuelMax !== undefined && fuelMax > 0)
      ? (fuelCurrent / fuelMax) * 100 : 100;
    if (fuelPct < 80) {
      const refuelPhase = phase("refuel");
      const refuelResp = await ctx.client.execute("refuel");
      if (refuelResp.error) {
        ctx.log("warn", `navigate_home: refuel error: ${JSON.stringify(refuelResp.error)}`);
        phases.push(completePhase(refuelPhase, { error: refuelResp.error }));
      } else {
        didRefuel = true;
        phases.push(completePhase(refuelPhase, refuelResp.result));
        ctx.log("info", "navigate_home: refueled");
      }
    }
  }

  // --- Phase 6: Repair ---
  let didRepair = false;
  if (params.repair) {
    const hullCurrent = typeof ship?.hull === "number" ? ship.hull : undefined;
    const hullMax = typeof ship?.hull_max === "number" ? ship.hull_max : undefined;
    const hullPct = (hullCurrent !== undefined && hullMax !== undefined && hullMax > 0)
      ? (hullCurrent / hullMax) * 100 : 100;

    if (hullPct < 90) {
      const repairPhase = phase("repair");
      const repairResp = await ctx.client.execute("repair");
      if (repairResp.error) {
        ctx.log("warn", `navigate_home: repair error: ${JSON.stringify(repairResp.error)}`);
        phases.push(completePhase(repairPhase, { error: repairResp.error }));
      } else {
        didRepair = true;
        phases.push(completePhase(repairPhase, repairResp.result));
        ctx.log("info", "navigate_home: repaired");
      }
    }
  }

  // --- Phase 7: Sell cargo ---
  let soldCount = 0;
  let creditsBefore = 0;
  let creditsAfter = 0;
  if (params.sell) {
    // Check cargo first
    const cargoResp = await ctx.client.execute("get_cargo");
    const cargo = getCargoUtilization(cargoResp);

    if (cargo && cargo.used > 0) {
      // Analyze market first (required per common-rules)
      const analyzePhase = phase("analyze_market");
      const analyzeResp = await ctx.client.execute("analyze_market");
      phases.push(completePhase(analyzePhase, analyzeResp.result));

      // Get credits before sell
      const preSellStatus = await ctx.client.execute("get_status");
      creditsBefore = ((preSellStatus.result as any)?.player?.credits as number) ?? 0;

      const sellPhase = phase("sell_cargo");
      const sellResp = await ctx.client.execute("multi_sell");
      if (sellResp.error) {
        ctx.log("warn", `navigate_home: sell error: ${JSON.stringify(sellResp.error)}`);
        phases.push(completePhase(sellPhase, { error: sellResp.error }));
      } else {
        const sellResult = sellResp.result as Record<string, unknown> | undefined;
        soldCount = typeof sellResult?.items_sold === "number" ? sellResult.items_sold : 0;
        phases.push(completePhase(sellPhase, sellResult));

        // Get credits after sell
        const postSellStatus = await ctx.client.execute("get_status");
        creditsAfter = ((postSellStatus.result as any)?.player?.credits as number) ?? 0;
        ctx.log("info", `navigate_home: sold ${soldCount} items, +${creditsAfter - creditsBefore} credits`);
      }
    } else {
      ctx.log("info", "navigate_home: no cargo to sell");
    }
  }

  // --- Build summary ---
  const parts: string[] = [`Returned to ${params.station}`];
  if (didRefuel) parts.push("refueled");
  if (didRepair) parts.push("repaired");
  if (soldCount > 0) parts.push(`sold ${soldCount} items (+${creditsAfter - creditsBefore} cr)`);

  const summary = parts.join(", ");
  ctx.log("info", `navigate_home: ${summary}`);

  return done(summary, {
    station: params.station,
    system: params.system,
    did_refuel: didRefuel,
    did_repair: didRepair,
    items_sold: soldCount,
    credits_earned: creditsAfter - creditsBefore,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const navigateHomeRoutine: RoutineDefinition<NavigateHomeParams> = {
  name: "navigate_home",
  description: "Navigate to home station: jump (if needed), travel, dock, refuel, repair, sell cargo.",
  parseParams,
  run,
};
