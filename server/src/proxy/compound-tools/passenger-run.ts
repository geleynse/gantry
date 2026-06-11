/**
 * compound-tools/passenger-run.ts
 *
 * Implementation of the passenger_run compound tool (game v0.354.0+ passenger loop).
 *
 * Conservative pickup helper for liner / passenger-cabin ships docked at a station:
 *   1. Verify the ship is docked (passengers can only be loaded at a station).
 *   2. list_station_passengers — who is waiting + where they're bound.
 *   3. Group the waiting list by destination station.
 *   4. load_passenger destination=<station> per destination, in descending
 *      fare order, until no free berths remain or the list is exhausted.
 *   5. list_passengers — confirm who is aboard now.
 *   6. Report the planned delivery route (destinations + the soonest-expiring
 *      timer) so the agent can travel and deliver before fares decay / strand.
 *
 * The agent still drives travel + unload — this tool only handles the
 * load-by-destination fan-out, which is otherwise N manual calls.
 *
 * Game-version notes:
 *   - load_passenger takes `destination=<station>` (loads everyone bound there
 *     into free berths).
 *   - Fares = base fare + speed bonus (bonus ≤ +50%, shrinks as the delivery
 *     guarantee timer runs down). Stranding pays nothing and costs standing.
 *   - v0.356.1: a ship cannot be sold/scrapped/listed while passengers are aboard.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { stripPendingFields } from "./utils.js";

const log = createLogger("compound-tools");

interface WaitingPassenger {
  name?: unknown;
  destination?: unknown;
  destination_system?: unknown;
  fare?: unknown;
  class?: unknown;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Pull a passenger array out of whatever shape the game returns. */
function extractPassengers(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const d = asObject(result);
  const arr =
    (d.passengers as unknown[] | undefined) ??
    (d.waiting as unknown[] | undefined) ??
    (d.loaded as unknown[] | undefined) ??
    (d.list as unknown[] | undefined);
  return Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
}

function destOf(p: WaitingPassenger): string | undefined {
  const d =
    (p as Record<string, unknown>).destination ??
    (p as Record<string, unknown>).destination_station ??
    (p as Record<string, unknown>).dest;
  return typeof d === "string" ? d : undefined;
}

function fareOf(p: WaitingPassenger): number {
  const f =
    (p as Record<string, unknown>).fare ??
    (p as Record<string, unknown>).estimated_fare ??
    (p as Record<string, unknown>).total_fare;
  return typeof f === "number" ? f : 0;
}

function timeOf(p: Record<string, unknown>): number | undefined {
  const t =
    p.time_remaining ?? p.ticks_remaining ?? p.guarantee_remaining ?? p.deadline;
  return typeof t === "number" ? t : undefined;
}

/**
 * Load waiting passengers at the docked station, grouped by destination,
 * into free berths. Reports the resulting delivery route.
 */
export async function passengerRun(deps: CompoundToolDeps): Promise<CompoundResult> {
  const { client, agentName, statusCache } = deps;
  const isV2 = typeof client.isV2 === "function" && client.isV2();

  // Prerequisite: must be docked. Passengers can only be picked up at a station.
  const cachedStatus = statusCache.get(agentName);
  const playerData = (cachedStatus?.data?.player ?? cachedStatus?.data) as
    | Record<string, unknown>
    | undefined;
  if (playerData && !playerData.docked_at_base) {
    log.warn("passenger_run blocked: not docked", { agent: agentName });
    return {
      error:
        "You must be docked at a station to pick up passengers. " +
        "Use travel_to(destination, should_dock=true) first.",
    };
  }

  const exec = (action: string, args?: Record<string, unknown>) =>
    isV2
      ? client.execute("spacemolt", { action, ...(args ?? {}) })
      : client.execute(action, args);

  // 1. Who is waiting here?
  const waitingResp = await exec("list_station_passengers");
  if (waitingResp.error) {
    log.warn("passenger_run: list_station_passengers failed", { agent: agentName });
    return { error: waitingResp.error };
  }
  stripPendingFields(waitingResp.result);

  const waiting = extractPassengers(waitingResp.result) as WaitingPassenger[];
  if (waiting.length === 0) {
    return {
      status: "no_passengers",
      message: "No passengers waiting at this station.",
      station: (asObject(waitingResp.result).station as unknown) ?? playerData?.current_poi,
    };
  }

  // 2. Group by destination, then order destinations by best fare available
  //    (load the most lucrative routes first so they win the berth race).
  const byDest = new Map<string, WaitingPassenger[]>();
  let skippedNoDest = 0;
  for (const p of waiting) {
    const dest = destOf(p);
    if (!dest) {
      skippedNoDest++;
      continue;
    }
    const list = byDest.get(dest) ?? [];
    list.push(p);
    byDest.set(dest, list);
  }

  const destinations = [...byDest.entries()]
    .map(([dest, pax]) => ({
      dest,
      pax,
      bestFare: Math.max(...pax.map(fareOf), 0),
    }))
    .sort((a, b) => b.bestFare - a.bestFare);

  // 3. load_passenger per destination, highest-fare destination first.
  const loads: Array<{ destination: string; loaded: number; result: unknown; error?: unknown }> = [];
  let totalLoaded = 0;

  for (const { dest } of destinations) {
    const resp = await exec("load_passenger", { destination: dest });
    if (resp.error) {
      const errObj = asObject(resp.error);
      const code = String(errObj.code ?? "");
      const msg = String(errObj.message ?? "");
      loads.push({ destination: dest, loaded: 0, result: null, error: resp.error });
      // Out of berths — stop trying further destinations.
      if (/berth|cabin|full|capacity/i.test(code + " " + msg)) {
        log.info("passenger_run: berths full, stopping load loop", { agent: agentName });
        break;
      }
      continue;
    }
    stripPendingFields(resp.result);
    const loadedHere = extractPassengers(resp.result).length;
    totalLoaded += loadedHere;
    loads.push({ destination: dest, loaded: loadedHere, result: resp.result });
  }

  // 4. Confirm who is aboard now and build the delivery route.
  const aboardResp = await exec("list_passengers");
  let aboard: Record<string, unknown>[] = [];
  if (!aboardResp.error) {
    stripPendingFields(aboardResp.result);
    aboard = extractPassengers(aboardResp.result);
  }

  // Planned route: distinct destinations among aboard passengers, with the
  // soonest-expiring guarantee timer per destination (deliver these first).
  const routeMap = new Map<string, { destination: string; passengers: number; soonest_timer?: number }>();
  for (const p of aboard) {
    const dest = destOf(p as WaitingPassenger);
    if (!dest) continue;
    const entry = routeMap.get(dest) ?? { destination: dest, passengers: 0 };
    entry.passengers++;
    const t = timeOf(p);
    if (t !== undefined && (entry.soonest_timer === undefined || t < entry.soonest_timer)) {
      entry.soonest_timer = t;
    }
    routeMap.set(dest, entry);
  }
  const route = [...routeMap.values()].sort((a, b) => {
    const at = a.soonest_timer ?? Infinity;
    const bt = b.soonest_timer ?? Infinity;
    return at - bt;
  });

  const result: CompoundResult = {
    status: "completed",
    loaded_count: totalLoaded,
    aboard_count: aboard.length,
    loads,
    route,
    next_action:
      route.length > 0
        ? `travel_to("${route[0].destination}", should_dock=true) then unload_passenger(name="all") to deliver. ` +
          `Deliver soonest-expiring destinations first to keep the speed bonus.`
        : "No passengers boarded — check free berths (liner berths or a passenger cabin module) and timers.",
    reminder:
      "A ship cannot be sold, scrapped, or listed while passengers are aboard (v0.356.1). " +
      "Stranding a passenger (unloading anywhere but their destination) pays nothing and costs standing.",
  };
  if (skippedNoDest > 0) result.skipped_no_destination = skippedNoDest;

  log.info("passenger_run DONE", {
    agent: agentName,
    loaded: totalLoaded,
    aboard: aboard.length,
    route_stops: route.length,
  });

  return result;
}
