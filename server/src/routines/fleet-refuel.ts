/**
 * fleet_refuel routine — Coordinate fleet-wide refueling.
 *
 * State machine:
 *   INIT → CHECK_FLEET → [TRAVEL_STATION → DOCK] → REFUEL_SELF → HANDOFF (for fleet members)
 *
 * The routine checks fleet(action="status") for all members' fuel, travels to the nearest
 * station (or a specified one), docks, refuels the current agent, then hands off
 * to the LLM with a fleet refuel plan for coordinating other members.
 *
 * Limitation: RoutineToolClient only executes tools for the current agent.
 * Fleet coordination (inviting others, issuing refuel to fleet members) requires
 * LLM decision-making, so we handoff with a clear instruction.
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, done, handoff, phase, completePhase, travelAndDock } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface FleetRefuelParams {
  station?: string;
}

function parseParams(raw: unknown): FleetRefuelParams {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  return {
    station: typeof obj.station === "string" && obj.station ? obj.station : undefined,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FleetMember {
  name: string;
  fuel?: number;
  fuel_max?: number;
  fuel_pct?: number;
  location?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: FleetRefuelParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Check fleet status ---
  const fleetPhase = phase("check_fleet");
  const fleetResp = await ctx.client.execute("fleet", { action: "status" });

  if (fleetResp.error) {
    phases.push(completePhase(fleetPhase, { error: fleetResp.error }));
    return handoff(
      `fleet(status) failed: ${JSON.stringify(fleetResp.error)}. You may not be in a fleet — use fleet(action="create") or fleet(action="invite") first.`,
      { error: fleetResp.error },
      phases,
    );
  }

  const fleetData = fleetResp.result as Record<string, unknown> | undefined;
  const rawMembers = (fleetData?.members ?? []) as Array<Record<string, unknown>>;
  // Fleet-level location (all members share the same POI/system)
  const fleetPoi = fleetData?.poi_id as string | undefined;
  const fleetSystem = fleetData?.system_id as string | undefined;

  const members: FleetMember[] = rawMembers.map((m) => {
    // Fuel is nested under ship in the game API
    const ship = m.ship as Record<string, unknown> | undefined;
    const fuel = typeof ship?.fuel === "number" ? ship.fuel : (typeof m.fuel === "number" ? m.fuel : undefined);
    const fuelMax = typeof ship?.max_fuel === "number" ? ship.max_fuel : (typeof m.fuel_max === "number" ? m.fuel_max : undefined);
    const fuelPct = (fuel !== undefined && fuelMax !== undefined && fuelMax > 0)
      ? Math.round((fuel / fuelMax) * 100) : undefined;
    return {
      name: String(m.username ?? m.name ?? m.player_name ?? "unknown"),
      fuel,
      fuel_max: fuelMax,
      fuel_pct: fuelPct,
      location: fleetPoi ?? fleetSystem ?? (m.current_poi ?? m.location) as string | undefined,
    };
  });

  const needsFuel = members.filter((m) => m.fuel_pct !== undefined && m.fuel_pct < 80);
  phases.push(completePhase(fleetPhase, { member_count: members.length, needs_fuel: needsFuel.length, members }));
  ctx.log("info", `fleet_refuel: ${members.length} members, ${needsFuel.length} need fuel`);

  // --- Phase 2: Get own status ---
  const initPhase = phase("init");
  const statusResp = await ctx.client.execute("get_status");
  const status = statusResp.result as Record<string, unknown> | undefined;
  const player = status?.player as Record<string, unknown> | undefined;
  const ship = status?.ship as Record<string, unknown> | undefined;
  const currentPoi = player?.current_poi as string | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;

  const selfFuel = typeof ship?.fuel === "number" ? ship.fuel : undefined;
  const selfFuelMax = typeof ship?.fuel_max === "number" ? ship.fuel_max : undefined;
  const selfFuelPct = (selfFuel !== undefined && selfFuelMax !== undefined && selfFuelMax > 0)
    ? (selfFuel / selfFuelMax) * 100 : 100;

  phases.push(completePhase(initPhase, { currentPoi, selfFuelPct: Math.round(selfFuelPct) }));

  // --- Phase 3: Determine target station ---
  const targetStation = params.station ?? dockedAt ?? currentPoi;
  if (!targetStation) {
    return handoff(
      "No station specified and cannot determine current station. Specify a station parameter or navigate to one.",
      { members },
      phases,
    );
  }

  ctx.log("info", `fleet_refuel: target station=${targetStation}`);

  // --- Phase 4: Travel + Dock ---
  const alreadyAtStation = currentPoi?.includes(targetStation) ?? false;
  const alreadyDocked = !!dockedAt && alreadyAtStation;

  const td = await travelAndDock(ctx, targetStation, { alreadyAtStation, alreadyDocked, label: "fleet_refuel" });
  phases.push(...td.phases);
  if (td.failed) return handoff(td.failed, { station: targetStation, members }, phases);

  // --- Phase 5: Refuel self ---
  let didRefuel = false;
  if (selfFuelPct < 80) {
    const refuelPhase = phase("refuel_self");
    const refuelResp = await ctx.client.execute("refuel");
    if (refuelResp.error) {
      ctx.log("warn", `fleet_refuel: refuel error: ${JSON.stringify(refuelResp.error)}`);
      phases.push(completePhase(refuelPhase, { error: refuelResp.error }));
    } else {
      didRefuel = true;
      phases.push(completePhase(refuelPhase, refuelResp.result));
      ctx.log("info", "fleet_refuel: self refueled");
    }
  }

  // --- Phase 6: If other members need fuel, handoff to LLM ---
  const othersNeedFuel = needsFuel.filter((m) => m.name !== ctx.agentName);
  if (othersNeedFuel.length > 0) {
    const memberList = othersNeedFuel.map((m) =>
      `${m.name}: ${m.fuel_pct ?? "?"}% fuel at ${m.location ?? "unknown"}`
    ).join("; ");

    return handoff(
      `Self refueled at ${targetStation}. ${othersNeedFuel.length} fleet members still need fuel: ${memberList}. Coordinate their travel to the station and refueling.`,
      {
        station: targetStation,
        self_refueled: didRefuel,
        members_needing_fuel: othersNeedFuel,
        all_members: members,
      },
      phases,
    );
  }

  // --- All members have sufficient fuel ---
  const summary = didRefuel
    ? `Refueled at ${targetStation}. All ${members.length} fleet members have sufficient fuel.`
    : `All ${members.length} fleet members already have sufficient fuel (>80%).`;

  return done(summary, {
    station: targetStation,
    self_refueled: didRefuel,
    member_count: members.length,
    members,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const fleetRefuelRoutine: RoutineDefinition<FleetRefuelParams> = {
  name: "fleet_refuel",
  description: "Coordinate fleet-wide refueling. Check all fleet members' fuel, travel to station, refuel self, handoff for others.",
  parseParams,
  run,
};
