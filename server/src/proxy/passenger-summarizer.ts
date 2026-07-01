/**
 * passenger-summarizer.ts
 *
 * Per-tool summarizers for the passenger-transport loop (game v0.354.0+):
 *   - list_station_passengers — citizens waiting to be picked up at the docked station
 *   - load_passenger          — result of boarding everyone bound for a destination
 *   - list_passengers         — citizens currently aboard, with fare breakdown + timers
 *   - unload_passenger        — result of dropping a passenger (or "all")
 *
 * These render the verbose game JSON compactly, matching the style of the
 * existing summarizers in summarizers.ts (discoverPick → known-key projection,
 * array clamping). They are exported as a plain `Record<string, Summarizer>`
 * so summarizers.ts can spread them into its SUMMARIZERS table:
 *
 *     import { PASSENGER_SUMMARIZERS } from "./passenger-summarizer.js";
 *     const SUMMARIZERS = { ...PASSENGER_SUMMARIZERS, get_status: ... };
 *
 * NOTE: the wiring line in summarizers.ts is NOT added by this module's owner —
 * see the handoff note. Until wired, these summarizers are unit-tested in
 * isolation and the raw passenger tools still pass through (just unsummarized).
 */

export type Summarizer = (result: unknown) => unknown;

const MAX_PASSENGERS = 30;

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Pick a stable, useful subset of fields from a single passenger record.
 *  Tolerant of field-name variation across game versions (dest vs destination,
 *  fare vs base_fare, etc.) so we surface something useful even if the API drifts. */
function pickPassenger(p: unknown): Record<string, unknown> {
  const o = asObject(p);
  const out: Record<string, unknown> = {};

  const name = o.name ?? o.passenger ?? o.id;
  if (name !== undefined) out.name = name;

  const klass = o.class ?? o.cabin_class ?? o.fare_class;
  if (klass !== undefined) out.class = klass;

  // Destination: station + system (v0.368.0 added destination system).
  const destStation = o.destination ?? o.destination_station ?? o.dest ?? o.dest_station;
  const destSystem = o.destination_system ?? o.dest_system;
  if (destStation !== undefined) out.destination = destStation;
  if (destSystem !== undefined) out.destination_system = destSystem;

  // Fare: total + breakdown (base fare + speed bonus). Bonus ≤ +50%, shrinks
  // as the delivery-guarantee timer runs down (v0.368.0 breakdown).
  const fare = o.fare ?? o.estimated_fare ?? o.total_fare;
  if (fare !== undefined) out.fare = fare;
  const baseFare = o.base_fare ?? o.base;
  if (baseFare !== undefined) out.base_fare = baseFare;
  const speedBonus = o.speed_bonus ?? o.bonus;
  if (speedBonus !== undefined) out.speed_bonus = speedBonus;

  // Time remaining on the speed-bonus / delivery guarantee.
  const timeRemaining =
    o.time_remaining ?? o.ticks_remaining ?? o.guarantee_remaining ?? o.deadline;
  if (timeRemaining !== undefined) out.time_remaining = timeRemaining;

  return out;
}

/** Extract a passenger array from any of the shapes the game might return. */
function extractList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const d = asObject(result);
  const arr =
    (d.passengers as unknown[] | undefined) ??
    (d.waiting as unknown[] | undefined) ??
    (d.list as unknown[] | undefined);
  return Array.isArray(arr) ? arr : [];
}

/** Shared list summarizer for list_station_passengers / list_passengers. */
function summarizeList(result: unknown): unknown {
  const d = asObject(result);
  const passengers = extractList(result).slice(0, MAX_PASSENGERS).map(pickPassenger);

  const out: Record<string, unknown> = { passengers, count: passengers.length };

  // Carry through useful top-level context the game may include.
  if (d.station !== undefined) out.station = d.station;
  if (d.system !== undefined) out.system = d.system;
  if (d.berths_free !== undefined) out.berths_free = d.berths_free;
  if (d.berths_total !== undefined) out.berths_total = d.berths_total;
  if (d.message !== undefined && passengers.length === 0) out.message = d.message;

  return out;
}

export const PASSENGER_SUMMARIZERS: Record<string, Summarizer> = {
  list_station_passengers: summarizeList,
  list_passengers: summarizeList,

  load_passenger: (result: unknown) => {
    const d = asObject(result);
    const loaded = extractList(d.loaded ?? result).map(pickPassenger);
    const out: Record<string, unknown> = {
      loaded,
      loaded_count: loaded.length,
    };
    if (d.destination !== undefined) out.destination = d.destination;
    if (d.berths_free !== undefined) out.berths_free = d.berths_free;
    if (d.message !== undefined) out.message = d.message;
    return out;
  },

  unload_passenger: (result: unknown) => {
    const d = asObject(result);
    const out: Record<string, unknown> = {};
    // Delivered (paid) vs stranded (unpaid, costs standing) breakdown.
    if (d.delivered !== undefined) out.delivered = d.delivered;
    if (d.stranded !== undefined) out.stranded = d.stranded;
    // v0.441.9 renamed the delivered-fare field to fare_collected (was fare_paid);
    // keep fare_earned for older shapes so we surface the amount regardless.
    const fareEarned = d.fare_earned ?? d.fare_collected ?? d.fare_paid;
    if (fareEarned !== undefined) out.fare_earned = fareEarned;
    if (d.standing_change !== undefined) out.standing_change = d.standing_change;
    if (d.name !== undefined) out.name = d.name;
    if (d.message !== undefined) out.message = d.message;
    // Fall back: if the game returns a bare object, surface it rather than {}.
    return Object.keys(out).length > 0 ? out : d;
  },
};
