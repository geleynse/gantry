/**
 * fleet_refuel routine — Coordinate fleet-wide refueling.
 *
 * State machine:
 *   INIT → CHECK_FLEET → [TRAVEL_STATION → DOCK] → CHECK_FACTION_BUNKER →
 *   REFUEL_SELF → DEPOSIT_BUNKER (opportunistic) → HANDOFF (for fleet members)
 *
 * The routine checks fleet(action="status") for all members' fuel, travels to the nearest
 * station (or a specified one), docks, refuels the current agent (preferring the free
 * faction fuel bunker when available), tops up the faction bunker opportunistically when
 * the agent has spare fuel, then hands off to the LLM with a fleet refuel plan for
 * coordinating other members.
 *
 * Faction fuel bunker (v0.334.0, #6):
 *   When the faction has a fuel bunker at this station, fleetmates refuel from it for
 *   FREE. The game surfaces a hint in view_faction_storage when the bunker has room.
 *   This routine attempts a free faction-bunker refuel first; it falls back to the paid
 *   `refuel` call only if the bunker refuel action fails. After refueling, if the agent's
 *   tank is full and the bunker is not, it deposits spare fuel opportunistically.
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

/**
 * How many fuel units we leave in-tank as a "spare" buffer when considering
 * whether to deposit excess fuel into the faction bunker. We never deposit below
 * this threshold so the agent always has a comfortable cushion after topping up
 * the bunker.
 */
const BUNKER_DEPOSIT_KEEP_PCT = 0.90; // keep 90% of max tank; deposit only if above this

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: FleetRefuelParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Check fleet status ---
  const fleetPhase = phase("check_fleet");
  const fleetResp = await ctx.client.execute("spacemolt_fleet", { action: "status" });

  if (fleetResp.error) {
    phases.push(completePhase(fleetPhase, { error: fleetResp.error }));
    return handoff(
      `spacemolt_fleet(status) failed: ${JSON.stringify(fleetResp.error)}. You may not be in a fleet — use spacemolt_fleet(action="create") or spacemolt_fleet(action="invite", id=<player>) first.`,
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
  const selfFuelMax = typeof ship?.max_fuel === "number" ? ship.max_fuel
                    : typeof ship?.fuel_max === "number" ? ship.fuel_max
                    : undefined;
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

  // --- Phase 5: Refuel self (prefer free faction bunker when available) ---
  let didRefuel = false;
  let usedFactionBunker = false;
  if (selfFuelPct < 80) {
    const refuelPhase = phase("refuel_self");

    // v0.334.0: Try the free faction-bunker refuel first.
    // spacemolt_storage(action="withdraw", target="faction", item_id="fuel") draws fuel from
    // the faction bunker into the ship's tank — the reverse of deposit. If the bunker is
    // absent, empty, or the station has no QTCG presence, the game returns an error and we
    // fall back to the standard paid `refuel` call. This keeps the guard safe regardless of
    // whether the bunker facility exists.
    const factionRefuelResp = await ctx.client.execute("spacemolt_storage", {
      action: "withdraw",
      target: "faction",
      item_id: "fuel",
    });

    if (!factionRefuelResp.error) {
      didRefuel = true;
      usedFactionBunker = true;
      phases.push(completePhase(refuelPhase, { ...factionRefuelResp.result, source: "faction_bunker" }));
      ctx.log("info", "fleet_refuel: refueled from faction bunker (free)");
    } else {
      // Faction bunker not available — fall back to paid refuel.
      ctx.log("info", `fleet_refuel: faction bunker unavailable (${JSON.stringify(factionRefuelResp.error)}), falling back to paid refuel`);
      const refuelResp = await ctx.client.execute("refuel");
      if (refuelResp.error) {
        ctx.log("warn", `fleet_refuel: refuel error: ${JSON.stringify(refuelResp.error)}`);
        phases.push(completePhase(refuelPhase, { error: refuelResp.error }));
      } else {
        didRefuel = true;
        phases.push(completePhase(refuelPhase, { ...refuelResp.result, source: "paid" }));
        ctx.log("info", "fleet_refuel: self refueled (paid)");
      }
    }
  }

  // --- Phase 5b: Opportunistic faction-bunker top-up ---
  // v0.334.0: If we are now above the keep threshold, deposit spare fuel into the faction
  // bunker so fleetmates can refuel for free. We only do this when the ship is well-topped
  // (above BUNKER_DEPOSIT_KEEP_PCT of max) to avoid leaving ourselves short.
  const postRefuelFuel = selfFuelMax !== undefined
    ? (didRefuel ? selfFuelMax : selfFuel)  // assume full after refuel if max known
    : selfFuel;
  const postRefuelPct = (postRefuelFuel !== undefined && selfFuelMax !== undefined && selfFuelMax > 0)
    ? (postRefuelFuel / selfFuelMax) * 100 : selfFuelPct;

  if (postRefuelPct !== undefined && postRefuelPct >= BUNKER_DEPOSIT_KEEP_PCT * 100) {
    const depositPhase = phase("deposit_faction_bunker");
    // Ask view_faction_storage to see if the bunker has room (hint from game v0.334.0).
    // If it errors or shows no bunker, skip silently — deposit is purely opportunistic.
    const storageCheckResp = await ctx.client.execute("view_faction_storage", {});
    const storageData = storageCheckResp.result as Record<string, unknown> | undefined;
    const bunkerHasRoom = storageData?.fuel_bunker_has_room === true
      || storageData?.fuel_bunker_capacity_remaining !== undefined;

    if (!storageCheckResp.error && bunkerHasRoom) {
      const depositResp = await ctx.client.execute("spacemolt_storage", {
        action: "deposit",
        target: "faction",
        item_id: "fuel",
      });
      if (!depositResp.error) {
        phases.push(completePhase(depositPhase, { ...depositResp.result, action: "bunker_top_up" }));
        ctx.log("info", "fleet_refuel: deposited spare fuel into faction bunker");
      } else {
        // Not an error — bunker deposit is best-effort only
        ctx.log("debug", `fleet_refuel: bunker deposit skipped: ${JSON.stringify(depositResp.error)}`);
        phases.push(completePhase(depositPhase, { skipped: true, reason: depositResp.error }));
      }
    } else {
      ctx.log("debug", "fleet_refuel: faction bunker not present or no room, skipping deposit");
    }
  }

  // --- Phase 6: If other members need fuel, handoff to LLM ---
  const othersNeedFuel = needsFuel.filter((m) => m.name !== ctx.agentName);
  if (othersNeedFuel.length > 0) {
    const memberList = othersNeedFuel.map((m) =>
      `${m.name}: ${m.fuel_pct ?? "?"}% fuel at ${m.location ?? "unknown"}`
    ).join("; ");

    const refuelNote = usedFactionBunker ? " (used free faction bunker)" : "";
    return handoff(
      `Self refueled at ${targetStation}${refuelNote}. ${othersNeedFuel.length} fleet members still need fuel: ${memberList}. Coordinate their travel to the station and refueling. If faction has a fuel bunker here, they can refuel FREE via spacemolt_storage(action="withdraw", target="faction", item_id="fuel").`,
      {
        station: targetStation,
        self_refueled: didRefuel,
        used_faction_bunker: usedFactionBunker,
        members_needing_fuel: othersNeedFuel,
        all_members: members,
      },
      phases,
    );
  }

  // --- All members have sufficient fuel ---
  const refuelNote = usedFactionBunker ? " (free faction bunker)" : "";
  const summary = didRefuel
    ? `Refueled at ${targetStation}${refuelNote}. All ${members.length} fleet members have sufficient fuel.`
    : `All ${members.length} fleet members already have sufficient fuel (>80%).`;

  return done(summary, {
    station: targetStation,
    self_refueled: didRefuel,
    used_faction_bunker: usedFactionBunker,
    member_count: members.length,
    members,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const fleetRefuelRoutine: RoutineDefinition<FleetRefuelParams> = {
  name: "fleet_refuel",
  description: "Coordinate fleet-wide refueling. Check all fleet members' fuel, travel to station, refuel self (prefers free faction bunker when available), deposit spare fuel into faction bunker opportunistically, handoff for others.",
  parseParams,
  run,
};
