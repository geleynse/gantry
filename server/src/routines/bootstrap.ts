import { loadConfig, FLEET_DIR } from "../config.js";
import { createDatabase } from "../services/database.js";
import { SessionManager } from "../proxy/session-manager.js";
import { BreakerRegistry } from "../proxy/circuit-breaker.js";
import { MetricsWindow } from "../proxy/instability-metrics.js";
import { runDiscovery } from "../proxy/discovery-service.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("bootstrap");

/**
 * Bootstrap Routine — Forces a full discovery pass using the first available agent.
 */
export async function runBootstrap(): Promise<void> {
  log.info("Starting bootstrap discovery pass...");
  
  // 1. Initialize DB
  createDatabase();
  
  // 2. Load Config
  const config = loadConfig(FLEET_DIR);
  if (config.agents.length === 0) {
    log.error("No agents configured in gantry.json. Cannot bootstrap.");
    return;
  }

  const breakerRegistry = new BreakerRegistry();
  const serverMetrics = new MetricsWindow();
  const sessions = new SessionManager(config, breakerRegistry, serverMetrics);
  const agent = config.agents[0];
  
  log.info(`Using agent ${agent.name} for discovery`);
  
  try {
    const client = await sessions.getOrCreateClient(agent.name);
    // Relies on restored session credentials — fails gracefully if not authenticated
    await runDiscovery(client);
    
    log.info("Bootstrap discovery pass completed.");
  } catch (err) {
    log.error("Bootstrap discovery pass failed", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    await sessions.logoutAll();
  }
}
