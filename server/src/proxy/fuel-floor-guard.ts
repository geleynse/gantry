/**
 * fuel-floor-guard.ts — structural proxy guards that stop agents from stranding
 * themselves outside a refuel-capable station.
 *
 * Two guards live here, both pure functions that decide BLOCK vs ALLOW from the
 * agent's cached status. handlePassthrough wires them in as early returns, the
 * same way the refuel-target and dock guards work.
 *
 * 1. FUEL-FLOOR GUARD (checkFuelFloorGuard)
 *    Blocks an outbound `jump` / `jump_route` when the ship is undocked, in
 *    space, and so low on fuel that completing the move would leave it unable to
 *    make even one more jump — i.e. it would land at the destination with no way
 *    to continue to a station. That is the exact failure that stranded cinder-wake
 *    at delta_major_star with 0/160 fuel on 2026-06-01.
 *
 *    Fuel cost model (IMPORTANT — flagged as an estimate):
 *      The live game does NOT expose a fixed fuel-per-jump value to the proxy.
 *      Per-jump cost is variable per system pair and is only revealed by the
 *      game's find_route response (fuel_per_jump / per-step fuel_cost) or the
 *      jump response's own fuel_cost. The proxy has no reliable a-priori number.
 *      The mock client charges a flat 10/jump. We therefore use a conservative
 *      FUEL_PER_JUMP_ESTIMATE constant as the floor unit. The guard only fires
 *      when current fuel is at or below one jump's worth — meaning the move would
 *      leave zero buffer for a follow-on hop. This is the minimal rule that
 *      catches the stranding footgun while staying resistant to false positives:
 *      we do NOT attempt to route to a specific station (the galaxy graph carries
 *      no per-system station/refuel data), which would manufacture false blocks.
 *
 * 2. CARGO-FULL DOCK-GUARD (checkCargoFullDockGuard)
 *    Refuses outbound jumps when the cargo hold is effectively full
 *    (cargo_used / cargo_capacity >= CARGO_FULL_THRESHOLD). A full-cargo ship that
 *    keeps jumping burns fuel it can't replace by selling, compounding the
 *    stranding risk. The override-system already emits a SOFT advisory at 90%;
 *    this is the HARD block at 95% the advisory references ("at 95% you will be
 *    blocked"). It points the agent at dock+sell.
 *
 * False-positive guards (both checks):
 *   - Never block a ship that is AT a station / docked (it can just refuel/sell).
 *   - Never block a ship with a Pathfinder Drive (onboard fuel generation) — it
 *     makes its own fuel and the floor does not apply.
 *   - Never block when we lack the cached numbers to decide (fuel/cargo unknown).
 *   - Never block a move that keeps the ship above the floor.
 *   When in doubt, ALLOW and log — a false block strands the agent just as surely
 *   as a missing guard.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("fuel-floor-guard");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Estimated fuel consumed by a single jump. The live game charges a variable,
 * per-system-pair cost that the proxy cannot know up front; this is a
 * conservative flat estimate (matches the mock client's 10/jump). Used purely
 * to size the fuel floor — see module header for the full rationale.
 */
export const FUEL_PER_JUMP_ESTIMATE = 10;

/**
 * Cargo fullness ratio at which the dock-guard hard-blocks outbound movement.
 * The override-system fires a soft advisory at 0.90; this is the 0.95 hard stop.
 */
export const CARGO_FULL_THRESHOLD = 0.95;

/**
 * Both guards block from the cached status. If that cache is older than this,
 * the numbers may be a frozen full-hold / low-fuel reading the ship no longer
 * has, and blocking would prevent the very jump that resyncs it (the #1 field
 * footgun). A structural anti-strand block only fires on fresh data.
 */
export const GUARD_STALE_CEILING_MS = 300_000; // 5 min

/** True when a cached status entry is older than the staleness ceiling. */
function isCacheStale(cached: CachedStatus): boolean {
  return !cached || Date.now() - cached.fetchedAt > GUARD_STALE_CEILING_MS;
}

/** Outbound, fuel-burning navigation actions the fuel floor applies to. */
const FUEL_BURNING_NAV = new Set(["jump", "jump_route"]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export interface GuardError {
  status: "error";
  error: string;
  message: string;
  /** Diagnostic context echoed back so agents (and logs) see the numbers. */
  [key: string]: unknown;
}

type CachedStatus = { data: Record<string, unknown>; fetchedAt: number } | undefined;

/** Pull the ship and player sub-objects from a cached status entry. */
function extractShipPlayer(cached: CachedStatus): {
  ship: Record<string, unknown> | undefined;
  player: Record<string, unknown> | undefined;
} {
  const data = cached?.data;
  if (!data || typeof data !== "object") return { ship: undefined, player: undefined };
  const player = (data.player ?? data) as Record<string, unknown> | undefined;
  // Prefer the nested ship object; fall back to player.ship, then to the flat
  // root (some cached entries store fuel/cargo fields at data root). Mirrors the
  // `data.ship ?? data` convention used in jump-route.ts.
  const ship = (data.ship ?? player?.ship ?? data) as Record<string, unknown> | undefined;
  return { ship, player };
}

/** True when the ship is currently docked at a base (can refuel in place). */
function isDocked(player: Record<string, unknown> | undefined): boolean {
  const docked = player?.docked_at_base;
  // docked_at_base may be a boolean, a station id string, or null/undefined.
  return docked === true || (typeof docked === "string" && docked.trim() !== "");
}

/**
 * True when the ship has a Pathfinder Drive (or equivalent onboard fuel
 * generation) installed. Such ships make their own fuel and must never be
 * blocked by the fuel floor. Checks both v1 (ship.weapons-style) and v2
 * (ship.modules[]) loadout shapes, plus a flat boolean flag if the game ever
 * surfaces one. Matching is name-substring based and case-insensitive.
 */
export function hasPathfinderDrive(ship: Record<string, unknown> | undefined): boolean {
  if (!ship) return false;

  // Explicit flag, if the game/status parser ever provides one.
  if (ship.has_pathfinder_drive === true || ship.pathfinder_drive === true) return true;

  const looksLikePathfinder = (s: unknown): boolean => {
    const str = String(s ?? "").toLowerCase();
    return str.includes("pathfinder");
  };

  const modules = ship.modules as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(modules)) {
    for (const m of modules) {
      if (!m || typeof m !== "object") continue;
      if (
        looksLikePathfinder(m.name) ||
        looksLikePathfinder(m.id) ||
        looksLikePathfinder(m.module_id) ||
        looksLikePathfinder(m.mod_type) ||
        looksLikePathfinder(m.type) ||
        looksLikePathfinder(m.slot)
      ) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Fuel-floor guard
// ---------------------------------------------------------------------------

/**
 * Decide whether to block an outbound jump because the ship is too low on fuel
 * to avoid stranding itself.
 *
 * Returns a structured GuardError to BLOCK, or null to ALLOW.
 *
 * Block condition (all must hold):
 *   - action is jump / jump_route
 *   - ship is NOT docked (a docked ship can just refuel)
 *   - ship has NO Pathfinder Drive (those make their own fuel)
 *   - current fuel is known AND <= FUEL_PER_JUMP_ESTIMATE
 *     (the move would land the ship with no fuel left to continue to a station)
 *
 * Everything else ALLOWs. Unknown fuel ALLOWs (and logs) — we never block blind.
 */
export function checkFuelFloorGuard(
  v1ToolName: string,
  cached: CachedStatus,
  opts?: { fuelPerJump?: number },
): GuardError | null {
  if (!FUEL_BURNING_NAV.has(v1ToolName)) return null;

  // Stale cache → the fuel number may be frozen; never block on it.
  if (isCacheStale(cached)) {
    log.debug("fuel floor: skipped — cache stale", { action: v1ToolName });
    return null;
  }

  const { ship, player } = extractShipPlayer(cached);

  // Docked ships can refuel where they are — never block.
  if (isDocked(player)) return null;

  // Pathfinder Drive ships generate their own fuel — never block.
  if (hasPathfinderDrive(ship)) {
    log.debug("fuel floor: skipped — Pathfinder Drive present", {
      action: v1ToolName,
    });
    return null;
  }

  const fuel = typeof ship?.fuel === "number" ? ship.fuel : undefined;
  if (fuel === undefined) {
    // We don't know the fuel level — allow rather than block blind.
    log.debug("fuel floor: skipped — fuel unknown", { action: v1ToolName });
    return null;
  }

  const fuelPerJump = opts?.fuelPerJump ?? FUEL_PER_JUMP_ESTIMATE;

  // Floor: the ship must keep at least one jump's worth of fuel AFTER this move,
  // so it can reach a station. If current fuel is at/below a single jump's cost,
  // the move would leave it unable to jump again → block.
  if (fuel > fuelPerJump) return null;

  const maxFuel = typeof ship?.max_fuel === "number" ? ship.max_fuel : undefined;
  const currentSystem = (player?.current_system as string | undefined) ?? "unknown";

  log.warn("fuel floor guard BLOCKED outbound jump", {
    action: v1ToolName,
    system: currentSystem,
    fuel,
    max_fuel: maxFuel ?? "?",
    fuel_per_jump_estimate: fuelPerJump,
  });

  const fuelStr = maxFuel !== undefined ? `${fuel}/${maxFuel}` : `${fuel}`;
  return {
    status: "error",
    error: "fuel_floor_guard",
    message:
      `BLOCKED: jumping now would strand you. You have ${fuelStr} fuel and each jump costs ~${fuelPerJump}. ` +
      `Completing this jump would leave you below the fuel needed to reach a station, ` +
      `and you are NOT docked. ` +
      `Do this instead: dock at a station in "${currentSystem}" and refuel BEFORE jumping. ` +
      `If there is no station here, you are already at the edge of your range — call get_system to find the nearest dockable station and travel_to it, then refuel.`,
    current_fuel: fuel,
    max_fuel: maxFuel,
    fuel_per_jump_estimate: fuelPerJump,
    current_system: currentSystem,
  };
}

// ---------------------------------------------------------------------------
// Cargo-full dock-guard
// ---------------------------------------------------------------------------

/**
 * Decide whether to block an outbound jump because the cargo hold is full.
 *
 * Returns a structured GuardError to BLOCK, or null to ALLOW.
 *
 * Block condition (all must hold):
 *   - action is jump / jump_route
 *   - ship is NOT docked (a docked ship can just sell)
 *   - cargo_used / cargo_capacity is known AND >= CARGO_FULL_THRESHOLD
 *
 * A full-cargo ship that keeps jumping burns fuel it cannot replace (it must
 * dock and sell to earn refuel credits), compounding the stranding risk. Send
 * it to dock+sell. Unknown cargo numbers ALLOW (and log).
 */
export function checkCargoFullDockGuard(
  v1ToolName: string,
  cached: CachedStatus,
  opts?: { threshold?: number },
): GuardError | null {
  if (!FUEL_BURNING_NAV.has(v1ToolName)) return null;

  // Stale cache → the cargo number may be frozen; never block on it.
  if (isCacheStale(cached)) {
    log.debug("cargo dock-guard: skipped — cache stale", { action: v1ToolName });
    return null;
  }

  const { ship, player } = extractShipPlayer(cached);

  // Docked ships can sell where they are — never block.
  if (isDocked(player)) return null;

  const cargoUsed = typeof ship?.cargo_used === "number" ? ship.cargo_used : undefined;
  const cargoCapacity =
    typeof ship?.cargo_capacity === "number" ? ship.cargo_capacity : undefined;

  if (cargoUsed === undefined || cargoCapacity === undefined || cargoCapacity <= 0) {
    log.debug("cargo dock-guard: skipped — cargo numbers unknown", {
      action: v1ToolName,
    });
    return null;
  }

  const threshold = opts?.threshold ?? CARGO_FULL_THRESHOLD;
  const ratio = cargoUsed / cargoCapacity;
  if (ratio < threshold) return null;

  const pct = Math.round(ratio * 100);
  const currentSystem = (player?.current_system as string | undefined) ?? "unknown";

  log.warn("cargo-full dock-guard BLOCKED outbound jump", {
    action: v1ToolName,
    system: currentSystem,
    cargo_used: cargoUsed,
    cargo_capacity: cargoCapacity,
    pct,
  });

  return {
    status: "error",
    error: "cargo_full_dock_guard",
    message:
      `BLOCKED: cargo hold is ${pct}% full (${cargoUsed}/${cargoCapacity}) and you are NOT docked. ` +
      `Jumping with a full hold burns fuel you cannot replace until you sell. ` +
      `Do this instead: dock at a station in "${currentSystem}", then analyze_market and multi_sell your cargo. ` +
      `Sell first, refuel, THEN jump.`,
    cargo_used: cargoUsed,
    cargo_capacity: cargoCapacity,
    cargo_pct: pct,
    current_system: currentSystem,
  };
}
