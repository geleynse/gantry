/**
 * Transit check throttle — rate-limits location-checking tools during hyperspace.
 *
 * Agents (especially Haiku) spam get_location, get_system, and get_poi during
 * hyperspace transit, burning 40-70% of tool calls on status checks that return
 * unchanged data. Prompt-level rules reduce this ~50% but aren't reliable.
 *
 * This module enforces a proxy-level cooldown: when an agent is detected as
 * in-transit (null/empty current_poi in statusCache), throttled tools are
 * limited to 1 call per THROTTLE_INTERVAL_MS. Throttled calls get a synthetic
 * response instead of hitting the game server.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("transit-throttle");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum interval between transit-check tool calls (ms). */
export const THROTTLE_INTERVAL_MS = 60_000; // 60 seconds

/** Tools that are throttled during transit (same names used in both v1 and v2). */
export const TRANSIT_THROTTLED_TOOLS = new Set([
  "get_location",
  "get_system",
  "get_poi",
]);

/** @deprecated Use TRANSIT_THROTTLED_TOOLS — v1 and v2 action names are identical. */
export const TRANSIT_THROTTLED_V2_ACTIONS = TRANSIT_THROTTLED_TOOLS;

// ---------------------------------------------------------------------------
// Transit detection
// ---------------------------------------------------------------------------

export interface StatusCacheEntry {
  data: Record<string, unknown>;
  fetchedAt: number;
}

/**
 * Detect whether an agent is currently in hyperspace transit.
 *
 * Transit indicators from the game state:
 *  - current_poi is null/empty (not at any point of interest)
 *  - current_system may be null (between systems) or set (in-system travel)
 *
 * We consider the agent "in transit" when current_poi is null/empty.
 * This covers both hyperspace jumps (system-to-system) and in-system travel.
 *
 * Returns transit info if in transit, or null if not.
 */
export function detectTransitState(
  cached: StatusCacheEntry | undefined,
): { destination?: string; ticksRemaining?: number } | null {
  if (!cached?.data) return null;

  const player = (cached.data.player ?? cached.data) as Record<string, unknown>;
  const currentPoi = player.current_poi;
  const currentSystem = player.current_system;

  // If the agent has a POI, they're not in transit
  if (currentPoi && typeof currentPoi === "string" && currentPoi.trim() !== "") {
    return null;
  }

  // No POI — agent is in transit (between systems or between POIs in a system).
  // Check for transit destination / ticks remaining if available in the state.
  const transitDest = player.transit_destination as string | undefined;
  const ticksRemaining = player.ticks_remaining as number | undefined;

  // Also check if current_system is null (full hyperspace, between systems)
  // vs non-null (in-system travel to a POI)
  const destination = transitDest ?? (currentSystem ? `somewhere in ${currentSystem}` : "unknown destination");

  return {
    destination,
    ticksRemaining: typeof ticksRemaining === "number" ? ticksRemaining : undefined,
  };
}

// ---------------------------------------------------------------------------
// TransitThrottle
// ---------------------------------------------------------------------------

/**
 * Per-agent transit check throttle.
 *
 * Tracks the last time each agent was allowed to call a transit-check tool.
 * When an agent is in transit and tries to call a throttled tool before the
 * cooldown expires, returns a synthetic "still in transit" message.
 */
export class TransitThrottle {
  /** Map of agentName → last allowed call timestamp (ms). */
  private lastAllowed = new Map<string, number>();

  /** Configurable throttle interval (for testing). */
  private intervalMs: number;

  constructor(intervalMs = THROTTLE_INTERVAL_MS) {
    this.intervalMs = intervalMs;
  }

  /**
   * Check if a tool call should be throttled for transit.
   *
   * @param agentName    Agent making the call
   * @param toolName     Tool being called (v1 name or v2 action)
   * @param statusCache  Shared status cache to check transit state
   * @returns Throttle message if blocked, or null if allowed through
   */
  check(
    agentName: string,
    toolName: string,
    statusCache: Map<string, StatusCacheEntry>,
  ): string | null {
    // Only throttle specific tools
    if (!TRANSIT_THROTTLED_TOOLS.has(toolName)) {
      return null;
    }

    // Check if agent is in transit
    const cached = statusCache.get(agentName);
    const transitState = detectTransitState(cached);
    if (!transitState) {
      // Not in transit — allow the call and clear any stale throttle state
      this.lastAllowed.delete(agentName);
      return null;
    }

    // Agent is in transit — check cooldown
    const now = Date.now();
    const lastCall = this.lastAllowed.get(agentName);

    if (lastCall === undefined || (now - lastCall) >= this.intervalMs) {
      // Cooldown expired (or first call) — allow through and record timestamp
      this.lastAllowed.set(agentName, now);
      return null;
    }

    // Throttled — return a calm, data-like response that looks like a normal
    // location query result. Agents interpret "THROTTLED" as an error and retry;
    // a consistent transit status response lets them move on to productive work.
    const remainingMs = this.intervalMs - (now - lastCall);
    const remainingSec = Math.ceil(remainingMs / 1000);
    const cachedEntry = statusCache.get(agentName);
    const player = ((cachedEntry?.data as any)?.player ?? cachedEntry?.data ?? {}) as Record<string, unknown>;
    const currentSystem = (player.current_system as string) || "";

    log.debug("transit throttle — returning cached transit status", {
      agent: agentName,
      tool: toolName,
      remaining_sec: remainingSec,
      destination: transitState.destination,
    });

    // Build a response that matches what the game server would return
    const response: Record<string, unknown> = {
      system: currentSystem,
      poi: "",
      in_transit: true,
    };
    if (transitState.destination) {
      response.destination = transitState.destination;
    }
    if (transitState.ticksRemaining !== undefined) {
      response.eta_ticks = transitState.ticksRemaining;
    }
    response._cached = true;

    return JSON.stringify(response);
  }

  /**
   * Clear throttle state for an agent (e.g., on logout or session reset).
   */
  clear(agentName: string): void {
    this.lastAllowed.delete(agentName);
  }

  /**
   * Clear all throttle state.
   */
  clearAll(): void {
    this.lastAllowed.clear();
  }

  /**
   * Get the number of tracked agents (for monitoring).
   */
  get trackedAgents(): number {
    return this.lastAllowed.size;
  }
}
