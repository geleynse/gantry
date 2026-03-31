/**
 * mission_run routine — Travel to station, complete ready missions, accept new ones.
 *
 * State machine:
 *   INIT → TRAVEL_STATION → DOCK → COMPLETE_MISSIONS → ACCEPT_MISSIONS → DONE
 *
 * Inputs:
 *   - station: POI ID or name of the station
 *
 * Handoff triggers:
 *   - Travel fails after retries
 *   - Dock fails
 *
 * Implemented — Phase 3
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase, extractMissionList, travelAndDock, getTradeMissionCost } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface MissionRunParams {
  station: string;
}

function parseParams(raw: unknown): MissionRunParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { station: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.station !== "string" || !obj.station) {
    throw new Error("station is required (string)");
  }
  return { station: obj.station };
}

// Mission types we auto-accept
const ACCEPTABLE_MISSION_TYPES = new Set(["mining", "trading", "delivery", "trade", "deliver", "mine", "haul", "transport"]);

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: MissionRunParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Init — check current location ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;
  const alreadyAtStation = currentPoi?.includes(params.station) ?? false;
  const alreadyDocked = !!dockedAt && alreadyAtStation;
  phases.push(completePhase(initPhase, { currentPoi, alreadyAtStation, alreadyDocked }));

  ctx.log("info", `mission_run: starting at ${currentPoi ?? "unknown"}, target=${params.station}`);

  // --- Phase 2+3: Travel to station and dock (if needed) ---
  if (!alreadyAtStation || !alreadyDocked) {
    const tdResult = await travelAndDock(ctx, params.station, {
      alreadyAtStation,
      alreadyDocked,
      label: "mission_run",
    });
    phases.push(...tdResult.phases);
    if (tdResult.failed) {
      return handoff(tdResult.failed, { station: params.station }, phases);
    }
  }

  // --- Phase 4: Complete active missions at 100% ---
  let missionsCompleted = 0;
  let creditsEarned = 0;

  const completePhaseObj = phase("complete_missions");
  const activeResp = await ctx.client.execute("get_active_missions");
  const activeMissions = extractMissionList(activeResp.result);

  const readyMissions = activeMissions.filter((m) => {
    const progress = typeof m.progress === "number" ? m.progress : (typeof m.completion === "number" ? m.completion : 0);
    // Handle both 100-based (100%) and fraction-based (0.0–1.0) progress formats
    return progress >= 100 || (progress > 0 && progress <= 1);
  });

  for (const mission of readyMissions) {
    const missionId = String(mission.id ?? mission.mission_id ?? "");
    if (!missionId) continue;

    const completeResp = await ctx.client.execute("complete_mission", { mission_id: missionId });
    if (completeResp.error) {
      ctx.log("warn", `mission_run: complete_mission failed for ${missionId}: ${JSON.stringify(completeResp.error)}`);
      continue;
    }

    missionsCompleted++;
    const reward = completeResp.result as Record<string, unknown> | undefined;
    const credits = typeof reward?.credits === "number" ? reward.credits :
      (typeof reward?.reward_credits === "number" ? reward.reward_credits : 0);
    creditsEarned += credits;
    ctx.log("info", `mission_run: completed mission ${missionId} (+${credits}cr)`);
  }

  phases.push(completePhase(completePhaseObj, { ready: readyMissions.length, completed: missionsCompleted, credits_earned: creditsEarned }));

  // --- Phase 5: Accept new missions ---
  let missionsAccepted = 0;
  let missionsSkippedCost = 0;
  const costWarnings: string[] = [];

  // Read credits from statusCache — re-fetch after phase 4 in case a mission rewarded credits
  const cachedAfterComplete = ctx.statusCache.get(ctx.agentName);
  const playerAfter = cachedAfterComplete?.data?.player as Record<string, unknown> | undefined;
  const availableCredits: number | undefined =
    typeof playerAfter?.credits === "number" ? playerAfter.credits : undefined;

  const acceptPhaseObj = phase("accept_missions");
  const availResp = await ctx.client.execute("get_missions");
  const availMissions = extractMissionList(availResp.result);

  // Filter to acceptable types
  const acceptable = availMissions.filter((m) => {
    const mType = String(m.type ?? m.mission_type ?? m.category ?? "").toLowerCase();
    return ACCEPTABLE_MISSION_TYPES.has(mType);
  });

  for (const mission of acceptable) {
    const missionId = String(mission.id ?? mission.mission_id ?? "");
    if (!missionId) continue;

    // Pre-flight cost check for trade missions: skip if agent can't afford the buy-in.
    // Mining/delivery missions have no upfront cost so we only gate trade types.
    const mType = String(mission.type ?? mission.mission_type ?? mission.category ?? "").toLowerCase();
    const isTradeType = mType === "trading" || mType === "trade";
    if (isTradeType && availableCredits !== undefined) {
      const missionCost = getTradeMissionCost(mission);
      if (missionCost !== null && missionCost > availableCredits) {
        const missionLabel = String(mission.name ?? mission.title ?? missionId);
        const warning = `Mission "${missionLabel}" requires ~${missionCost.toLocaleString()}cr to buy items but only ${availableCredits.toLocaleString()}cr available — skipped`;
        ctx.log("warn", `mission_run: ${warning}`);
        costWarnings.push(`_cost_warning: ${warning}`);
        missionsSkippedCost++;
        continue;
      }
    }

    const acceptResp = await ctx.client.execute("accept_mission", { mission_id: missionId });
    if (acceptResp.error) {
      const errStr = JSON.stringify(acceptResp.error);
      ctx.log("warn", `mission_run: accept_mission failed for ${missionId}: ${errStr}`);
      // Stop accepting if we hit a blocker that applies to all missions (e.g., max active missions)
      if (errStr.includes("max_missions") || errStr.includes("limit")) break;
      continue;
    }

    missionsAccepted++;
    ctx.log("info", `mission_run: accepted mission ${missionId}`);
  }

  phases.push(completePhase(acceptPhaseObj, {
    available: availMissions.length,
    acceptable: acceptable.length,
    accepted: missionsAccepted,
    skipped_insufficient_credits: missionsSkippedCost,
    ...(costWarnings.length > 0 && { cost_warnings: costWarnings }),
  }));

  // --- Build summary ---
  const parts: string[] = [];
  if (missionsCompleted > 0) {
    parts.push(`Completed ${missionsCompleted} mission${missionsCompleted !== 1 ? "s" : ""} (+${creditsEarned.toLocaleString()}cr)`);
  }
  if (missionsAccepted > 0) {
    parts.push(`accepted ${missionsAccepted} new mission${missionsAccepted !== 1 ? "s" : ""}`);
  }
  if (missionsSkippedCost > 0) {
    parts.push(`skipped ${missionsSkippedCost} trade mission${missionsSkippedCost !== 1 ? "s" : ""} (insufficient credits)`);
  }
  if (parts.length === 0) {
    parts.push("No missions to complete or accept");
  }

  const summary = `${parts.join(", ")} at ${params.station}`;
  ctx.log("info", `mission_run: ${summary}`);

  return done(summary, {
    station: params.station,
    missions_completed: missionsCompleted,
    credits_earned: creditsEarned,
    missions_accepted: missionsAccepted,
    missions_skipped_cost: missionsSkippedCost,
    ...(costWarnings.length > 0 && { cost_warnings: costWarnings }),
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const missionRunRoutine: RoutineDefinition<MissionRunParams> = {
  name: "mission_run",
  description: "Travel to station, complete ready missions, accept new mining/trading/delivery missions.",
  parseParams,
  run,
};
