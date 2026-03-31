/**
 * fleet_jump routine — Coordinate fleet jump to a system.
 *
 * State machine:
 *   INIT → CHECK_FLEET → VERIFY_SAME_SYSTEM → JUMP → VERIFY_ARRIVAL → DONE/HANDOFF
 *
 * The routine checks fleet(action="status") to ensure all members are in the same system,
 * then issues a jump for the current agent and verifies arrival. If fleet members
 * are scattered across systems, it hands off to the LLM to coordinate gathering.
 *
 * Limitation: RoutineToolClient only executes tools for the current agent.
 * We jump our own ship, then verify via fleet(action="status") that we arrived.
 * If other members need to jump too, we handoff with instructions.
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, done, handoff, phase, completePhase, checkCombat } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface FleetJumpParams {
  destination: string;
}

function parseParams(raw: unknown): FleetJumpParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { destination: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.destination !== "string" || !obj.destination) {
    throw new Error("destination is required (string — target system name)");
  }
  return { destination: obj.destination };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FleetMember {
  name: string;
  system?: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMembers(rawMembers: Array<Record<string, unknown>>, fleetData?: Record<string, unknown>): FleetMember[] {
  // Fleet-level location (all members share same POI/system)
  const fleetSystem = fleetData?.system_id as string | undefined;
  const fleetPoi = fleetData?.poi_id as string | undefined;
  return rawMembers.map((m) => ({
    name: String(m.username ?? m.name ?? m.player_name ?? "unknown"),
    system: fleetSystem ?? (m.current_system ?? m.system) as string | undefined,
    location: fleetPoi ?? (m.current_poi ?? m.location) as string | undefined,
  }));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: FleetJumpParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Check fleet status ---
  const fleetPhase = phase("check_fleet");
  const fleetResp = await ctx.client.execute("fleet", { action: "status" });

  if (fleetResp.error) {
    phases.push(completePhase(fleetPhase, { error: fleetResp.error }));
    return handoff(
      `fleet(status) failed: ${JSON.stringify(fleetResp.error)}. You may not be in a fleet — use fleet(action="create") or fleet(action="invite") first.`,
      { error: fleetResp.error, destination: params.destination },
      phases,
    );
  }

  const fleetData = fleetResp.result as Record<string, unknown> | undefined;
  const rawMembers = (fleetData?.members ?? []) as Array<Record<string, unknown>>;
  const members = parseMembers(rawMembers, fleetData);

  phases.push(completePhase(fleetPhase, { member_count: members.length, members }));
  ctx.log("info", `fleet_jump: ${members.length} fleet members, destination=${params.destination}`);

  // --- Phase 2: Check if already at destination ---
  const statusResp = await ctx.client.execute("get_status");
  const status = statusResp.result as Record<string, unknown> | undefined;
  const player = status?.player as Record<string, unknown> | undefined;
  const currentSystem = player?.current_system as string | undefined;

  if (currentSystem === params.destination) {
    // Check if all members are also here
    const membersNotHere = members.filter((m) => m.system && m.system !== params.destination);
    if (membersNotHere.length > 0) {
      const scattered = membersNotHere.map((m) => `${m.name} at ${m.system ?? "unknown"}`).join("; ");
      return handoff(
        `Already at ${params.destination}, but ${membersNotHere.length} fleet members are elsewhere: ${scattered}. Coordinate their jump.`,
        { destination: params.destination, members, members_not_here: membersNotHere },
        phases,
      );
    }
    return done(
      `All ${members.length} fleet members are already at ${params.destination}.`,
      { destination: params.destination, member_count: members.length, members },
      phases,
    );
  }

  // --- Phase 3: Verify fleet members are in same system (for coordinated jump) ---
  const sameSystemPhase = phase("verify_same_system");
  const systems = new Set(members.map((m) => m.system).filter(Boolean));
  const allInSameSystem = systems.size <= 1;

  if (!allInSameSystem) {
    const systemList = Array.from(systems).join(", ");
    phases.push(completePhase(sameSystemPhase, { scattered: true, systems: Array.from(systems) }));
    return handoff(
      `Fleet members are scattered across systems (${systemList}). Gather all members to the same system before jumping to ${params.destination}.`,
      { destination: params.destination, members, systems: Array.from(systems) },
      phases,
    );
  }
  phases.push(completePhase(sameSystemPhase, { all_in_same: true, current_system: currentSystem }));

  // --- Phase 4: Jump to destination ---
  const jumpPhase = phase("jump");
  try {
    const jumpResult = await withRetry(async () => {
      const resp = await ctx.client.execute("jump_route", { destination: params.destination });
      if (resp.error) throw new Error(`jump_route failed: ${JSON.stringify(resp.error)}`);
      return resp.result;
    }, 2);

    phases.push(completePhase(jumpPhase, jumpResult));
    ctx.log("info", `fleet_jump: jumped to ${params.destination}`);

    // Check for combat during jump
    if (checkCombat(jumpResult)) {
      return handoff(
        `Combat detected during jump to ${params.destination}. Handle combat first.`,
        { destination: params.destination, combat: true },
        phases,
      );
    }
  } catch (err) {
    phases.push(completePhase(jumpPhase, { error: String(err) }));
    return handoff(
      `Jump to ${params.destination} failed: ${err instanceof Error ? err.message : String(err)}`,
      { destination: params.destination },
      phases,
    );
  }

  // --- Phase 5: Verify arrival ---
  const verifyPhase = phase("verify_arrival");
  await ctx.client.waitForTick();

  const postJumpResp = await ctx.client.execute("get_status");
  const postStatus = postJumpResp.result as Record<string, unknown> | undefined;
  const postPlayer = postStatus?.player as Record<string, unknown> | undefined;
  const arrivedSystem = postPlayer?.current_system as string | undefined;

  const arrived = arrivedSystem === params.destination;
  phases.push(completePhase(verifyPhase, { arrived, current_system: arrivedSystem }));

  if (!arrived) {
    return handoff(
      `Jump issued but currently at ${arrivedSystem ?? "unknown"} instead of ${params.destination}. May still be in transit — wait and check again.`,
      { destination: params.destination, current_system: arrivedSystem },
      phases,
    );
  }

  // --- Phase 6: Check if other members also need to jump ---
  const postFleetResp = await ctx.client.execute("fleet", { action: "status" });
  const postFleetData = postFleetResp.result as Record<string, unknown> | undefined;
  const postRawMembers = (postFleetData?.members ?? []) as Array<Record<string, unknown>>;
  const postMembers = parseMembers(postRawMembers, postFleetData);

  const membersNotArrived = postMembers.filter((m) => m.system && m.system !== params.destination);

  if (membersNotArrived.length > 0) {
    const laggards = membersNotArrived.map((m) => `${m.name} at ${m.system ?? "unknown"}`).join("; ");
    return handoff(
      `Arrived at ${params.destination}. ${membersNotArrived.length} fleet members haven't arrived yet: ${laggards}. They may still be in transit or need to jump separately.`,
      {
        destination: params.destination,
        arrived: true,
        members_not_arrived: membersNotArrived,
        all_members: postMembers,
      },
      phases,
    );
  }

  return done(
    `Fleet jump to ${params.destination} complete. All ${postMembers.length} members arrived.`,
    {
      destination: params.destination,
      member_count: postMembers.length,
      members: postMembers,
    },
    phases,
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const fleetJumpRoutine: RoutineDefinition<FleetJumpParams> = {
  name: "fleet_jump",
  description: "Coordinate fleet jump to a system. Check fleet status, verify members are together, jump, verify arrival.",
  parseParams,
  run,
};
