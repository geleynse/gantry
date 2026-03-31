/**
 * Transit stuck detection — identifies agents permanently stranded in hyperspace.
 *
 * Agents occasionally get stuck with an empty location (null current_system) across
 * multiple sessions. They burn 20+ tool calls checking location, wasting money and
 * turns. This module detects the pattern and injects an escalating warning so agents
 * know to try logout/login to recover (NOT self_destruct, which has exponential fees).
 *
 * Detection:
 *  - get_location (or get_status) returns empty/null current_system
 *  - This happens N consecutive times for the same agent
 *
 * At 3+ consecutive empty checks: inject mild warning, recommend logout/login.
 * At 6+ consecutive empty checks: inject urgent warning, warn about self_destruct fees.
 * Reset counter when a non-empty system is returned.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("transit-stuck");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of consecutive empty-location responses before mild warning. */
export const STUCK_WARN_THRESHOLD = 3;

/** Number of consecutive empty-location responses before urgent warning. */
export const STUCK_URGENT_THRESHOLD = 6;

/** Number of consecutive identical cached-query results before "stationary loop" warning. */
export const STATIONARY_LOOP_THRESHOLD = 5;

/** Tools that indicate current location (both v1 tool names and v2 action keys). */
export const LOCATION_TOOLS = new Set([
  "get_location",
  "get_status",
]);

// ---------------------------------------------------------------------------
// Transit stuck detection helpers
// ---------------------------------------------------------------------------

/**
 * Determine whether a tool result indicates an empty (stuck) location.
 *
 * Handles three response formats:
 *  - get_location cached response: { system, poi, docked_at_base, _cache }
 *  - get_status cached response: { current_system, current_poi, ... } or { player: { current_system, ... } }
 *  - get_location raw game response: { current_system, current_poi, ... }
 *
 * Returns true if the system field is null, undefined, or empty string.
 */
export function isEmptyLocation(toolName: string, result: unknown): boolean {
  if (!result || typeof result !== "object") return false;

  const r = result as Record<string, unknown>;

  if (toolName === "get_location") {
    // Cached query returns: { system, poi, docked_at_base }
    // Raw game response returns: { current_system, current_poi, ... }
    const system = r.system ?? r.current_system;
    return !system || (typeof system === "string" && system.trim() === "");
  }

  if (toolName === "get_status") {
    // Cached query returns flattened: { current_system, current_poi, ... }
    // or nested: { player: { current_system, ... } }
    const player = r.player as Record<string, unknown> | undefined;
    const system = player
      ? player.current_system
      : r.current_system;
    return !system || (typeof system === "string" && system.trim() === "");
  }

  return false;
}

// ---------------------------------------------------------------------------
// TransitStuckDetector
// ---------------------------------------------------------------------------

/**
 * Per-agent transit stuck detector.
 *
 * Tracks consecutive empty-location responses per agent. Injects escalating
 * warnings into get_location / get_status responses when an agent appears stranded.
 */
export class TransitStuckDetector {
  /** Map of agentName → consecutive empty-location count. */
  private emptyCounts = new Map<string, number>();

  /** Map of agentName → { lastKey: string, count: number } for stationary loop detection. */
  private stationaryLoops = new Map<string, { lastKey: string; count: number }>();

  /**
   * Record a location check result for an agent.
   *
   * If the result shows an empty system, increments the counter.
   * If the result shows a non-empty system, resets the counter.
   *
   * Returns an object with:
   *  - `count`: current consecutive empty count (after update)
   *  - `warning`: warning message to inject, or null if none
   */
  record(
    agentName: string,
    toolName: string,
    result: unknown,
  ): { count: number; warning: string | null } {
    if (!LOCATION_TOOLS.has(toolName)) {
      return { count: 0, warning: null };
    }

    const empty = isEmptyLocation(toolName, result);

    if (!empty) {
      // Agent has a location — reset empty counter
      const prev = this.emptyCounts.get(agentName) ?? 0;
      if (prev > 0) {
        log.info("transit stuck cleared — agent has location", {
          agent: agentName,
          tool: toolName,
          prev_count: prev,
        });
      }
      this.emptyCounts.delete(agentName);

      // Stationary loop detection: same location returned repeatedly
      const locationKey = this.extractLocationKey(toolName, result);
      if (locationKey) {
        const loop = this.stationaryLoops.get(agentName);
        if (loop && loop.lastKey === locationKey) {
          loop.count++;
          if (loop.count >= STATIONARY_LOOP_THRESHOLD) {
            const warning =
              `You have checked your location ${loop.count} times in a row with the same result (${locationKey}). ` +
              "STOP checking status/location. Take a GAME ACTION: jump, mine, sell, explore, or write docs. " +
              "Repeating status checks wastes your turn budget.";
            log.warn("stationary loop detected", {
              agent: agentName,
              count: loop.count,
              location: locationKey,
            });
            return { count: 0, warning };
          }
        } else {
          this.stationaryLoops.set(agentName, { lastKey: locationKey, count: 1 });
        }
      }

      return { count: 0, warning: null };
    }

    // Empty location — increment counter
    const prev = this.emptyCounts.get(agentName) ?? 0;
    const count = prev + 1;
    this.emptyCounts.set(agentName, count);

    log.info("transit stuck: empty location recorded", {
      agent: agentName,
      tool: toolName,
      count,
    });

    let warning: string | null = null;

    if (count >= STUCK_URGENT_THRESHOLD) {
      warning =
        `STRANDED: ${count} consecutive empty location checks. ` +
        "Call logout() now, then login() to reset your session. " +
        "The game auto-recovers stuck players to home base on the next command (v0.200+). " +
        "Do NOT use self_destruct — it has EXPONENTIAL fees.";
      log.warn("transit stuck: urgent warning threshold reached", {
        agent: agentName,
        count,
      });
    } else if (count >= STUCK_WARN_THRESHOLD) {
      warning =
        `In transit for ${count} consecutive checks. ` +
        "Stop checking location. Do productive work (check cargo, read docs). " +
        "If this persists, call logout() then login() to reset.";
      log.info("transit stuck: warn threshold reached", {
        agent: agentName,
        count,
      });
    }

    return { count, warning };
  }

  /**
   * Extract a location key from a cached query result for stationary loop detection.
   */
  private extractLocationKey(toolName: string, result: unknown): string | null {
    if (!result || typeof result !== "object") return null;
    const r = result as Record<string, unknown>;

    if (toolName === "get_location") {
      const system = r.system ?? r.current_system;
      const poi = r.poi ?? r.current_poi;
      if (system) return `${system}:${poi ?? "unknown"}`;
    }

    if (toolName === "get_status") {
      const player = r.player as Record<string, unknown> | undefined;
      const system = player ? player.current_system : r.current_system;
      const poi = player ? player.current_poi : r.current_poi;
      if (system) return `${system}:${poi ?? "unknown"}`;
    }

    return null;
  }

  /**
   * Get the current consecutive empty count for an agent.
   */
  getCount(agentName: string): number {
    return this.emptyCounts.get(agentName) ?? 0;
  }

  /**
   * Manually reset the counter for an agent (e.g., on login/logout).
   */
  reset(agentName: string): void {
    this.emptyCounts.delete(agentName);
    this.stationaryLoops.delete(agentName);
  }

  /**
   * Reset all counters.
   */
  resetAll(): void {
    this.emptyCounts.clear();
    this.stationaryLoops.clear();
  }

  /**
   * Get the number of agents with active stuck counters (for monitoring).
   */
  get trackedAgents(): number {
    return this.emptyCounts.size + this.stationaryLoops.size;
  }
}
