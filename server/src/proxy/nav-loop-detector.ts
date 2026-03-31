/**
 * Nav loop detection — identifies agents stuck in navigation loops.
 *
 * Agents occasionally call travel_to the same destination repeatedly within
 * a short window, wasting turns. This module detects the pattern and injects
 * a warning so agents know to try a different destination or dock.
 *
 * Detection:
 *  - travel_to is called with the same destination 3+ times within 10 minutes
 *
 * Warning injected into the travel_to result:
 *  _nav_loop_warning: "You've traveled to [destination] 3 times in the last
 *    10 minutes. You may be stuck in a navigation loop. Try a different
 *    destination or dock at the nearest station."
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("nav-loop");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of travels to the same destination within the window before warning. */
export const NAV_LOOP_THRESHOLD = 3;

/** Time window in milliseconds (10 minutes). */
export const NAV_LOOP_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// NavLoopDetector
// ---------------------------------------------------------------------------

interface TravelEntry {
  destination: string;
  ts: number;
}

/**
 * Per-agent nav loop detector.
 *
 * Tracks the last N travel_to destinations per agent in a ring buffer.
 * Injects a warning when the same destination appears 3+ times within 10 min.
 */
export class NavLoopDetector {
  /** Map of agentName → recent travel entries (ring buffer, newest last). */
  private history = new Map<string, TravelEntry[]>();

  /**
   * Record a travel_to destination for an agent.
   *
   * Returns an object with:
   *  - `count`: how many times this destination was seen in the window (after update)
   *  - `warning`: warning message to inject, or null if none
   */
  record(
    agentName: string,
    destination: string,
  ): { count: number; warning: string | null } {
    const now = Date.now();
    const cutoff = now - NAV_LOOP_WINDOW_MS;

    // Get or create agent's history, evicting stale entries
    const entries = (this.history.get(agentName) ?? []).filter(e => e.ts >= cutoff);

    // Add this travel
    entries.push({ destination, ts: now });

    // Keep at most last 20 entries (memory bound)
    if (entries.length > 20) entries.splice(0, entries.length - 20);

    this.history.set(agentName, entries);

    // Count how many times this destination appears in the window
    const count = entries.filter(e => e.destination === destination).length;

    log.debug("travel recorded", {
      agent: agentName,
      destination,
      count,
      window_entries: entries.length,
    });

    if (count >= NAV_LOOP_THRESHOLD) {
      const warning =
        `You've traveled to "${destination}" ${count} times in the last 10 minutes. ` +
        "You may be stuck in a navigation loop. Try a different destination or dock at the nearest station.";
      log.warn("nav loop detected", { agent: agentName, destination, count });
      return { count, warning };
    }

    return { count, warning: null };
  }

  /**
   * Get the current repeat count for a destination within the window.
   */
  getCount(agentName: string, destination: string): number {
    const now = Date.now();
    const cutoff = now - NAV_LOOP_WINDOW_MS;
    const entries = this.history.get(agentName) ?? [];
    return entries.filter(e => e.ts >= cutoff && e.destination === destination).length;
  }

  /**
   * Reset all history for an agent (e.g. on login/logout).
   */
  reset(agentName: string): void {
    this.history.delete(agentName);
  }

  /**
   * Reset all history.
   */
  resetAll(): void {
    this.history.clear();
  }

  /**
   * Get the number of agents with active history (for monitoring).
   */
  get trackedAgents(): number {
    return this.history.size;
  }
}
