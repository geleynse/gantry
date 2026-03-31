/**
 * Static configuration constants.
 */

// Default timing constants
export const DEFAULT_TURN_INTERVAL = 90;
export const DEFAULT_STAGGER_DELAY = 20;

// Valid geographic zones for agent assignment
export const VALID_OPERATING_ZONES = [
  "sol-sirius",      // Solarian core
  "crimson-zones",   // Crimson faction
  "nebula-deep",     // Nebula faction
  "outback-fringe",  // Fringe regions
  "colonial-hub",    // Neutral trading hubs
] as const;

export type OperatingZone = (typeof VALID_OPERATING_ZONES)[number];

// Web-specific constants (mutable for test overrides)
export let SOFT_STOP_TIMEOUT = 60_000; // 1 minute (reduced from 3 min for faster shutdown)
export let SOFT_STOP_POLL_INTERVAL = 5_000; // 5 seconds

/** Override soft-stop timing for tests. Resets to defaults if called with no args. */
export function setSoftStopTimingForTesting(timeout = 60_000, poll = 5_000): void {
  SOFT_STOP_TIMEOUT = timeout;
  SOFT_STOP_POLL_INTERVAL = poll;
}
