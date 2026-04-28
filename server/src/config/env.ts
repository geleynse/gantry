/**
 * Environment variable loading and fleet directory resolution.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Parse an integer from an env var, returning fallback if missing/invalid. */
function envInt(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? "", 10);
  return isNaN(v) ? fallback : v;
}

/**
 * Configuration Resolution Strategy for FLEET_DIR
 *
 * The server needs to locate the fleet-agents directory to read agent configs and serve logs.
 * Resolution follows a strict priority order to enable flexible deployment:
 *
 * 1. FLEET_DIR environment variable (explicit, highest priority)
 *    - Use if set; error if directory doesn't exist
 *
 * 2. Inferred from working directory
 *    - Check for ../fleet-agents relative to cwd (assumes standard monorepo layout)
 *    - Works for: local dev, Docker container with mounted volume
 *
 * 3. Test placeholder
 *    - During tests, return /dev/null (tests override via setConfigForTesting)
 *    - Prevents startup errors in CI environments
 *
 * 4. Error with helpful debugging information
 *    - No valid path found; provide instructions for configuration
 *
 * DEBUGGING: If you see "FLEET_DIR not configured" error:
 * - Option A (Recommended): Set FLEET_DIR=/absolute/path/to/fleet-agents
 * - Option B: Ensure fleet-agents directory exists next to gantry-server
 * - Option C (Container): Mount fleet-agents to /home/spacemolt/fleet-agents
 */
function resolveFleetDir(): string {
  // Priority 1: Explicit FLEET_DIR environment variable
  if (process.env.FLEET_DIR) {
    if (!existsSync(process.env.FLEET_DIR)) {
      throw new Error(`FLEET_DIR="${process.env.FLEET_DIR}" does not exist`);
    }
    return process.env.FLEET_DIR;
  }

  // Priority 2: Inferred from working directory (monorepo layout)
  const localFleetDir = join(process.cwd(), "..", "fleet-agents");
  if (existsSync(localFleetDir)) {
    return localFleetDir;
  }

  // Priority 3: Test environment placeholder
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return "/dev/null"; // Tests call setConfigForTesting() to override
  }

  // Priority 4: No valid path found
  throw new Error(
    `FLEET_DIR not configured. Set FLEET_DIR=/path/to/fleet-agents or place fleet-agents next to gantry-server`
  );
}

export let FLEET_DIR = resolveFleetDir();

/** Get the current fleet directory (always returns the latest value). */
export function getFleetDir(): string {
  return FLEET_DIR;
}

/** For testing only: override the resolved fleet directory. */
export function setFleetDirForTesting(dir: string): void {
  FLEET_DIR = dir;
}

export const PORT = parseInt(process.env.PORT || process.env.GANTRY_PORT || "3100", 10);
export const GANTRY_ENV = process.env.GANTRY_ENV;
export const LOG_LEVEL = process.env.LOG_LEVEL || "DEBUG"; // Default to DEBUG for detailed testing logs

/**
 * GANTRY_MOCK=1 activates mock mode without editing gantry.json.
 * Use for CI / local dev iteration without live game credentials.
 * Precedence: mockMode in gantry.json wins; this is the env-var fallback.
 */
export const GANTRY_MOCK = process.env.GANTRY_MOCK === "1";

// Timing intervals (envInt handles NaN and correctly allows 0)
export const MARKET_SCAN_INTERVAL_MS = envInt("MARKET_SCAN_INTERVAL_MS", 300000);
export const MARKET_PRUNE_INTERVAL_MS = envInt("MARKET_PRUNE_INTERVAL_MS", 600000);
export const SCHEMA_TTL_MS = envInt("SCHEMA_TTL_MS", 3600000);
export const DANGER_POLL_INTERVAL_MS = envInt("DANGER_POLL_INTERVAL_MS", 300000);
export const POSITION_POLL_INTERVAL_MS = envInt("POSITION_POLL_INTERVAL_MS", 15000);
