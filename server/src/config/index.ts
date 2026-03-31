/**
 * Config module barrel export.
 * Re-exports everything for backwards compatibility — existing imports
 * like `from '../config.js'` resolve here.
 */

// Environment
export {
  FLEET_DIR,
  getFleetDir,
  PORT,
  GANTRY_ENV,
  LOG_LEVEL,
  MARKET_SCAN_INTERVAL_MS,
  MARKET_PRUNE_INTERVAL_MS,
  SCHEMA_TTL_MS,
  DANGER_POLL_INTERVAL_MS,
  POSITION_POLL_INTERVAL_MS,
  setFleetDirForTesting,
} from "./env.js";

// Types
export type {
  AgentConfig,
  AuthConfig,
  MockInitialState,
  MockModeConfig,
  AccountPoolConfig,
  GantryConfig,
  SurvivabilityConfig,
} from "./types.js";

// Constants
export {
  DEFAULT_TURN_INTERVAL,
  DEFAULT_STAGGER_DELAY,
  SOFT_STOP_TIMEOUT,
  SOFT_STOP_POLL_INTERVAL,
  setSoftStopTimingForTesting,
} from "./constants.js";

// Fleet config: loading, caching, hot-reload, agent helpers
export {
  resolveConfigPath,
  loadConfig,
  AGENTS,
  AGENT_NAMES,
  TURN_SLEEP_MS,
  TURN_INTERVAL,
  getConfig,
  getAgent,
  validateAgentName,
  getAgentNames,
  getAgentLabel,
  setConfigForTesting,
  saveConfig,
  getToolsForRolePreset,
} from "./fleet.js";
