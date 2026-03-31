/**
 * Unified entry point for gantry-server.
 * Combines the MCP action proxy and fleet web dashboard into a single process.
 */

import { FLEET_DIR, PORT, LOG_LEVEL, MARKET_SCAN_INTERVAL_MS } from "./config.js";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { createDatabase } from "./services/database.js";
import { decontaminateDiary, decontaminateNotes } from "./services/notes-db.js";
import { watchTurnFiles, addPostIngestHook } from "./services/turn-ingestor.js";
import { pruneOldToolCalls } from "./web/routes/tool-calls.js";
import { runMarketScan } from "./services/market-scanner.js";
import { createLogger, setLogLevel, parseLogLevel, enableFileLogging } from "./lib/logger.js";
import { getSessionShutdownManager } from "./proxy/session-shutdown.js";
import { CONTAMINATION_WORDS } from "./proxy/proxy-constants.js";
import { join } from "node:path";
import { writeFileSync, mkdirSync, unlinkSync, readFileSync } from "node:fs";
import { runBootstrap } from "./routines/bootstrap.js";
import { LifecycleManager } from "./lib/lifecycle-manager.js";
import { createHealthMonitor } from "./services/health-monitor.js";
import { setLifecycleHooks } from "./services/agent-manager.js";
import { migrateCredentialsIfNeeded, validateCredentials } from "./services/credentials-crypto.js";
import { fetchAndCacheCatalog } from "./services/game-catalog.js";

// Configure log level early
setLogLevel(parseLogLevel(LOG_LEVEL));

const log = createLogger("server");

// --- 0. Handle CLI commands ---
const args = process.argv.slice(2);
if (args.includes("bootstrap")) {
  try {
    await runBootstrap();
    process.exit(0);
  } catch (err) {
    console.error("Bootstrap failed:", err);
    process.exit(1);
  }
}

// --- 0. PID management ---
const pidFile = join(FLEET_DIR, "data", "pids", "gantry-server.pid");
try {
  mkdirSync(join(FLEET_DIR, "data", "pids"), { recursive: true });
  writeFileSync(pidFile, process.pid.toString());
} catch (err) {
  log.warn("Failed to write PID file", { error: err });
}

// Enable file logging for the web UI (fire and forget)
try {
  const logFilePath = join(FLEET_DIR, "logs", "gantry-server.log");
  enableFileLogging(logFilePath).catch(err => {
    log.warn("Failed to enable file logging", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
} catch (err) {
  log.warn("Error setting up file logging", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// --- 1. Credentials ---
// Migrate plaintext fleet-credentials.json → encrypted fleet-credentials.enc.json.
// Skips if .enc.json already exists. Verifies decrypt roundtrip before committing.
try {
  const migrated = migrateCredentialsIfNeeded(FLEET_DIR);
  if (migrated) log.info("Credential encryption migration completed");
} catch (err) {
  log.warn("Credential migration failed (will use plaintext fallback)", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// --- 2. Load config ---
log.info("Loading config", { fleet_dir: FLEET_DIR });
const config = loadConfig(FLEET_DIR);
log.info("Config loaded", {
  agents: config.agents.length,
  game_mcp: config.gameMcpUrl,
});

for (const agent of config.agents) {
  const route = agent.socksPort
    ? `socks5://127.0.0.1:${agent.socksPort}`
    : "direct";
  log.debug("Agent route configured", {
    agent: agent.name,
    route,
  });
}

// --- 1b. Validate credentials against game API (advisory — never blocks startup) ---
// Skipped when validateCredentialsOnStartup is explicitly false or in mock mode.
if (config.validateCredentialsOnStartup !== false && !config.mockMode?.enabled) {
  validateCredentials(FLEET_DIR, config.gameMcpUrl).catch((err: unknown) => {
    log.warn("Credential validation threw unexpectedly", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// --- 1c. Fetch game catalog (items/recipes/ships) — non-blocking, 24h file cache ---
if (!config.mockMode?.enabled) {
  fetchAndCacheCatalog(config.gameApiUrl, FLEET_DIR).catch((err: unknown) => {
    log.warn("Catalog fetch failed (non-fatal, will retry next startup)", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// --- 2. Initialize analytics database ---
try {
  createDatabase();
  watchTurnFiles();
  log.info("Analytics database initialized");

  // Purge contaminated diary entries and note lines on startup
  for (const agent of config.agents) {
    const diaryPurged = decontaminateDiary(agent.name, CONTAMINATION_WORDS);
    const notesPurged = decontaminateNotes(agent.name, CONTAMINATION_WORDS);
    if (diaryPurged > 0 || notesPurged > 0) {
      log.info("Decontaminated agent data", { agent: agent.name, diary_entries: diaryPurged, note_lines: notesPurged });
    }
  }
} catch (err) {
  log.error("Failed to initialize analytics database", {
    error: err instanceof Error ? err.message : String(err),
  });
}

// --- 3. Create health monitor (before app so it can be wired into API routes) ---
const healthMonitor = createHealthMonitor(config.agents);

// --- 3b. Create unified app ---
const BIND_HOST = process.env.GANTRY_HOST ?? "0.0.0.0";
const { app, sessions, sharedState, overseerAgent, dispose: disposeProxy } = await createApp(config, { bindHost: BIND_HOST, healthMonitor });

// --- 3c. Wire lifecycle hooks (health monitor + MCP session cleanup on agent stop) ---
// sessionStore is only available after createApp, so both hooks are set here together.
const sessionStore = sharedState.sessions.store;
setLifecycleHooks({
  onStarted: (name) => healthMonitor.markRunning(name),
  onStopped: (name) => {
    healthMonitor.markStopped(name);
    // Delay session expiry by 30s to give the agent time to write its captain's log
    // and logout after receiving the shutdown signal. Without this delay, the session
    // expires ~4s after the signal — too fast for the agent to clean up.
    setTimeout(() => {
      try {
        sessionStore.expireAgentSessions(name);
        log.info("Expired MCP sessions for stopped agent", { agent: name });
      } catch (err) {
        log.warn("Failed to expire MCP sessions for stopped agent", {
          agent: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 30_000);
  },
});

// --- 3d. Wire overseer cost backfill ---
// The overseer agent calls log_decision at turn end, but can't know its own cost.
// After each overseer turn file is ingested (cost parsed from JSONL), backfill
// the cost_estimate on the latest overseer_decisions row.
if (overseerAgent) {
  addPostIngestHook((data) => {
    if (data.agent !== "overseer") return;
    overseerAgent.updateLatestDecisionCost({
      costUsd: data.costUsd,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
    });
  });
  log.info("Overseer cost backfill hook registered");
}

// Track all background timers for clean shutdown
const appTimers = new LifecycleManager();

// --- 4. Start listening ---
const server = app.listen(PORT, BIND_HOST, () => {
  log.info("Server listening", { port: PORT });
  log.info("Log level configured", { log_level: LOG_LEVEL });
  log.info("Service endpoints available", {
    mcp_v1: `http://localhost:${PORT}/mcp`,
    mcp_v2: `http://localhost:${PORT}/mcp/v2`,
    health: `http://localhost:${PORT}/health`,
    api: `http://localhost:${PORT}/api/ping`,
    web_ui: `http://localhost:${PORT}/`,
  });
});

// --- 5. Coordinator timer ---
const coordinator = sharedState.fleet.coordinator;
if (coordinator) {
  const intervalMinutes = config.coordinator?.intervalMinutes ?? 10;
  const COORDINATOR_INTERVAL = intervalMinutes * 60 * 1000;
  const coordinatorTimer = setInterval(async () => {
    try {
      if (coordinator.isEnabled()) {
        await coordinator.tick();
      }
    } catch (err) {
      log.warn("Coordinator tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, COORDINATOR_INTERVAL);
  coordinatorTimer.unref();
  appTimers.register("coordinator", coordinatorTimer);
  log.info("Coordinator timer started", { intervalMs: COORDINATOR_INTERVAL });
}

// --- 6. Periodic market scan ---
const marketScanTimer = setInterval(async () => {
  try {
    const result = await runMarketScan();
    if (result.orders_created > 0) {
      log.info("Market scan completed", {
        orders_created: result.orders_created,
      });
    }
  } catch {
    // Non-fatal — market scan may fail during startup or when game server is down
  }
}, MARKET_SCAN_INTERVAL_MS);
marketScanTimer.unref();
appTimers.register("marketScan", marketScanTimer);

// --- 6. Tool call pruning (every 6 hours, 7-day retention) ---
const PRUNE_INTERVAL = 6 * 60 * 60 * 1000;
const pruneTimer = setInterval(() => {
  const deleted = pruneOldToolCalls(168); // 168 hours = 7 days
  if (deleted > 0) {
    log.info("Pruned old tool call records", { deleted });
  }
}, PRUNE_INTERVAL);
pruneTimer.unref();
appTimers.register("toolCallPrune", pruneTimer);

// --- 7. Battle completion monitor (every 5 seconds) ---
// Monitors agents in shutdown_waiting state and transitions them to draining
// when their battles complete. battleCache is part of the proxy sharedState.
const BATTLE_MONITOR_INTERVAL = 5 * 1000;
const battleMonitorTimer = setInterval(() => {
  const shutdownManager = getSessionShutdownManager();
  const waitingAgents = shutdownManager.getAgentsWaitingForBattle();

  for (const agentName of waitingAgents) {
    const battleState = sharedState.cache.battle.get(agentName);

    // If no battle or battle is no longer active, transition to draining
    if (!battleState || battleState.status !== "active") {
      const transitioned = shutdownManager.transitionToDraining(agentName);

      if (transitioned) {
        log.info("Agent battle completed, transitioning to draining", {
          agent: agentName,
        });
      }
    }
  }
}, BATTLE_MONITOR_INTERVAL);
battleMonitorTimer.unref();
appTimers.register("battleMonitor", battleMonitorTimer);

// --- 8. Agent health monitor timer ---
const HEALTH_MONITOR_INTERVAL = 30_000; // 30 seconds
const healthMonitorTimer = setInterval(async () => {
  try {
    await healthMonitor.tick();
  } catch (err) {
    log.warn("Health monitor tick failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}, HEALTH_MONITOR_INTERVAL);
healthMonitorTimer.unref();
appTimers.register("healthMonitor", healthMonitorTimer);
log.info("Health monitor started", { intervalMs: HEALTH_MONITOR_INTERVAL });

// --- 9. Graceful shutdown ---
let forceExitTimeout: ReturnType<typeof setTimeout> | undefined;

async function shutdown(signal: string) {
  log.info("Shutting down", { signal });

  // Clear the force-exit timer (won't trigger anymore)
  if (forceExitTimeout) {
    clearTimeout(forceExitTimeout);
  }

  // Set a force-exit timer immediately (30s total timeout for entire shutdown)
  forceExitTimeout = setTimeout(() => {
    log.error("Forced exit after shutdown timeout");
    process.exit(1);
  }, 30_000);
  forceExitTimeout.unref();

  try {
    // Phase 1: Stop accepting new requests (unref background timers, stop listening)
    log.debug("Shutdown phase 1: stopping background tasks");
    appTimers.stopAll();

    // Phase 2: Dispose of proxy resources (MCP connections, transports)
    log.debug("Shutdown phase 2: disposing proxy resources");
    if (disposeProxy) {
      await disposeProxy();
    }

    // Phase 3: Clean up sessions (logout all agents)
    log.debug("Shutdown phase 3: logging out sessions");
    await sessions.logoutAll();

    // Phase 4: Close HTTP server gracefully
    log.debug("Shutdown phase 4: closing HTTP server");
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          log.error("Error closing server", { error: err.message });
          reject(err);
        } else {
          log.info("Server closed successfully, exiting");
          resolve();
        }
      });
    });

    // All cleanup complete — exit cleanly
    try {
      const currentPid = readFileSync(pidFile, "utf-8");
      if (currentPid === process.pid.toString()) {
        unlinkSync(pidFile);
      }
    } catch { /* ignore — PID file may not exist */ }
    process.exit(0);
  } catch (err) {
    log.error("Error during shutdown", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Force exit on error (will hit timeout eventually)
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Log unhandled errors and gracefully shut down to prevent corrupted state
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception — initiating graceful shutdown", {
    message: err.message,
    stack: err.stack,
  });
  // Graceful shutdown instead of silently continuing in corrupted state
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection — initiating graceful shutdown", {
    reason: String(reason),
  });
  // Graceful shutdown instead of silently continuing in corrupted state
  shutdown("unhandledRejection");
});
