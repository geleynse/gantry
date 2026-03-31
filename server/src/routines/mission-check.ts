/**
 * mission_check routine — Check and manage missions at a station.
 *
 * State machine:
 *   INIT → [TRAVEL_STATION → DOCK] → COMPLETE_ACTIVE → ACCEPT_NEW → DONE
 *
 * Implemented — Phase 2
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase, extractMissionList, travelAndDock } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface MissionCheckParams {
  station?: string;
  role_filter?: string[];
  max_accept?: number;
}

function parseParams(raw: unknown): MissionCheckParams {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const params: MissionCheckParams = {};

  if (obj.station !== undefined) {
    if (typeof obj.station !== "string" || !obj.station) {
      throw new Error("station must be a non-empty string if provided");
    }
    params.station = obj.station;
  }

  if (obj.role_filter !== undefined) {
    if (!Array.isArray(obj.role_filter)) {
      throw new Error("role_filter must be an array if provided");
    }
    params.role_filter = obj.role_filter;
  }

  if (obj.max_accept !== undefined) {
    if (typeof obj.max_accept !== "number" || obj.max_accept < 0) {
      throw new Error("max_accept must be a non-negative number if provided");
    }
    params.max_accept = obj.max_accept;
  }

  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: MissionCheckParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const maxAccept = params.max_accept ?? 3;
  const roleFilter = params.role_filter ?? [];

  // --- Phase 1: Init — check current location and docked status ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;
  const alreadyAtStation = params.station ? (currentPoi?.includes(params.station) ?? false) : true;
  const alreadyDocked = !!dockedAt && alreadyAtStation;
  phases.push(completePhase(initPhase, { currentPoi, alreadyAtStation, alreadyDocked }));

  ctx.log("info", `mission_check: starting at ${currentPoi ?? "unknown"}`);

  // --- Phase 2+3: Travel to station and dock (if needed) ---
  if (params.station && (!alreadyAtStation || !alreadyDocked)) {
    const tdResult = await travelAndDock(ctx, params.station, {
      alreadyAtStation,
      alreadyDocked,
      label: "mission_check",
    });
    phases.push(...tdResult.phases);
    if (tdResult.failed) {
      return handoff(tdResult.failed, { station: params.station }, phases);
    }
  }

  // --- Phase 4: Get and complete active missions ---
  const activePhase = phase("get_active_missions");
  const activeResp = await ctx.client.execute("get_active_missions");
  const activeMissions = extractMissionList(activeResp.result);
  const activeMissionIds = activeMissions.filter((m) => m.progress === 100).map((m) => m.id as string);
  phases.push(completePhase(activePhase, { count: activeMissions.length, completable: activeMissionIds.length }));

  const missionsCompleted: string[] = [];
  let creditsEarned = 0;

  for (const missionId of activeMissionIds) {
    const completeMissionPhase = phase("complete_mission");
    const completeResp = await ctx.client.execute("complete_mission", { mission_id: missionId });
    if (completeResp.error) {
      ctx.log("warn", `mission_check: failed to complete ${missionId}: ${JSON.stringify(completeResp.error)}`);
      phases.push(completePhase(completeMissionPhase, { error: completeResp.error }));
    } else {
      const result = completeResp.result as Record<string, unknown> | undefined;
      const reward = typeof result?.credits_earned === "number" ? result.credits_earned : 0;
      creditsEarned += reward;
      missionsCompleted.push(missionId);
      ctx.log("info", `mission_check: completed mission ${missionId}, earned ${reward} credits`);
      phases.push(completePhase(completeMissionPhase, result));
    }
  }

  // --- Phase 5: Get and accept available missions ---
  const listPhase = phase("get_missions");
  const listResp = await ctx.client.execute("get_missions");
  const availableMissions = extractMissionList(listResp.result);
  phases.push(completePhase(listPhase, { count: availableMissions.length }));

  const missionsAccepted: string[] = [];

  if (availableMissions) {
    for (const mission of availableMissions) {
      if (missionsAccepted.length >= maxAccept) break;

      const missionId = mission.id as string | undefined;
      if (!missionId) continue;

      // Check role filter if provided
      if (roleFilter.length > 0) {
        const missionType = String(mission.type ?? "").toLowerCase();
        const matches = roleFilter.some((role) => missionType.includes(role.toLowerCase()));
        if (!matches) {
          ctx.log("debug", `mission_check: skipping ${missionId} (type=${missionType} not in filter)`);
          continue;
        }
      }

      const acceptMissionPhase = phase("accept_mission");
      const acceptResp = await ctx.client.execute("accept_mission", { mission_id: missionId });
      if (acceptResp.error) {
        ctx.log("warn", `mission_check: failed to accept ${missionId}: ${JSON.stringify(acceptResp.error)}`);
        phases.push(completePhase(acceptMissionPhase, { error: acceptResp.error }));
      } else {
        missionsAccepted.push(missionId);
        ctx.log("info", `mission_check: accepted mission ${missionId}`);
        phases.push(completePhase(acceptMissionPhase, acceptResp.result));
      }
    }
  }

  // --- Build summary ---
  const parts: string[] = [];
  if (missionsCompleted.length > 0) parts.push(`Completed ${missionsCompleted.length} mission(s) (+${creditsEarned}cr)`);
  if (missionsAccepted.length > 0) parts.push(`Accepted ${missionsAccepted.length} mission(s)`);
  if (parts.length === 0) parts.push("No missions completed or accepted");

  const summary = parts.join(", ");
  ctx.log("info", `mission_check: ${summary}`);

  return done(summary, {
    station: params.station ?? "current",
    missions_completed: missionsCompleted,
    missions_completed_count: missionsCompleted.length,
    missions_accepted: missionsAccepted,
    missions_accepted_count: missionsAccepted.length,
    credits_earned: creditsEarned,
    role_filter: roleFilter,
    max_accept: maxAccept,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const missionCheckRoutine: RoutineDefinition<MissionCheckParams> = {
  name: "mission_check",
  description: "Check and manage missions at a station. Complete active missions, accept new ones.",
  parseParams,
  run,
};
