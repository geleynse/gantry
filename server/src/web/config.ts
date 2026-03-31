/**
 * Web-specific re-exports from the merged config module.
 * All core config logic is in src/config.ts; this just re-exports for web convenience.
 */

export {
  FLEET_DIR,
  getFleetDir,
  PORT,
  SOFT_STOP_TIMEOUT,
  SOFT_STOP_POLL_INTERVAL,
  AGENTS,
  AGENT_NAMES,
  TURN_INTERVAL,
  getAgent,
  validateAgentName,
  getAgentLabel,
  getAgentNames,
  getConfig,
  setConfigForTesting,
  resolveConfigPath,
  saveConfig,
  type AgentConfig,
  type GantryConfig,
} from "../config.js";
