import { Router } from "express";
import type { GantryConfig } from "../../config.js";
import { FLEET_DIR } from "../../config.js";
import type { SharedState } from "../../proxy/server.js";
import type { SessionManager } from "../../proxy/session-manager.js";
import type { HealthMonitor } from "../../services/health-monitor.js";
import { FleetCoordinator } from "../../services/coordinator.js";

import { createActionProxyRouter } from "./action-proxy.js";
import { createAgentRouter } from "./agents.js";
import { createStatusRouter } from "./status.js";
import { createGameStateRouter } from "./game-state.js";
import { createServerStatusRouter } from "./server-status.js";
import { createAccountsRouter } from "./accounts.js";
import { createSecurityRouter } from "./security.js";
import { createMarketRouter } from "./market.js";
import { createCoordinatorRouter } from "./coordinator.js";
import { createHealthRouter } from "./health-details.js";
import { createLogsRouter } from "./logs.js";
import commsRoutes from "./comms.js";
import notesRoutes from "./notes.js";
import { createCaptainsLogsRouter } from "./captains-logs.js";
import injectRoutes from "./inject.js";
import analyticsRoutes from "./analytics.js";
import usageRoutes from "./usage.js";
import analyticsDbRoutes from "./analytics-db.js";
import turnsRoutes from "./turns.js";
import mapRoutes from "./map.js";
import toolCallsRoutes, { agentReasoningRouter } from "./tool-calls.js";
import { createServerLogsRouter } from "./server-logs.js";
import combatRoutes from "./combat.js";
import economyRoutes from "./economy.js";
import knowledgeRoutes from "./knowledge.js";
import directivesRoutes from "./directives.js";
import { agentFleetControlRouter, routinesRouter } from "./fleet-control.js";
import { createSurvivabilityRouter } from "./survivability.js";
import { createFleetCapacityRouter } from "./fleet-capacity.js";
import { createContextSummaryRouter } from "./context-summary.js";
import { createOutboundReviewRouter } from "./outbound-review.js";
import activityRoutes from "./activity.js";
import alertsRoutes from "./alerts.js";
import { createPromptsRouter } from "./prompts.js";
import diagnosticsRoutes from "./diagnostics.js";
import leaderboardRoutes from "./leaderboard.js";
import prayerCanaryRoutes from "./prayer-canary.js";
import { createEnrollmentRouter } from "./enrollment.js";
import { createCredentialsRouter } from "./credentials.js";
import { createHealthMonitorRouter } from "./health-monitor-route.js";
import { createPoiExplorerRouter } from "./poi-explorer.js";
import { createOverseerRouter } from "./overseer.js";
import type { OverseerAgent } from "../../services/overseer-agent.js";
import rateLimitsGameRouter from "./rate-limits-game.js";
import loreRoutes from "./lore.js";
import intelRoutes from "./intel.js";
import { createResourcesRouter } from "./resources.js";
import { createCatalogRouter } from "./catalog.js";

export interface ApiRouteDeps {
  config: GantryConfig;
  sharedState: SharedState;
  /** SessionManager satisfies KickableSessionHandle — no intersection needed. */
  sessions: SessionManager;
  registeredToolCount: number;
  healthMonitor?: HealthMonitor;
  overseerAgent?: OverseerAgent;
  fleetDir?: string;
}

/**
 * Mount all /api/* sub-routes on a single router.
 * This replaces the long list of app.use("/api/...", ...) calls in app.ts.
 * Route paths, middleware, and behaviour are unchanged.
 */
export function createApiRoutes(deps: ApiRouteDeps): Router {
  const { config, sharedState, sessions, registeredToolCount, healthMonitor } = deps;
  const fleetDir = deps.fleetDir ?? FLEET_DIR;

  const router = Router();

  // Utility ping
  router.get("/ping", (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

  // Auth endpoints
  // Note: /api/auth/me and /api/auth/debug remain in app.ts because they close over `adapter`
  // and the trust-proxy app setting — keeping them there avoids threading those references here.

  // --- Agent sub-routers ---
  const agentRouter = createAgentRouter(sharedState.cache.battle, sharedState.proxy.breakerRegistry, fleetDir, config);
  const logsRouter = createLogsRouter(fleetDir, config);
  router.use("/agents", agentRouter);
  router.use("/agents", logsRouter);
  router.use("/agents", injectRoutes);
  router.use("/agents", directivesRoutes);
  router.use("/agents", agentFleetControlRouter);
  router.use("/agents", agentReasoningRouter);
  router.use("/agents", createContextSummaryRouter(sharedState.cache.status, sharedState.cache.events));
  router.use("/agents", createEnrollmentRouter());

  // --- Routines ---
  router.use("/routines", routinesRouter);

  // --- Credentials ---
  router.use("/credentials", createCredentialsRouter());

  // --- Status ---
  const statusRouter = createStatusRouter(
    sharedState.cache.battle,
    sharedState.proxy.breakerRegistry,
    sharedState.proxy.serverMetrics,
  );
  router.use("/status", statusRouter);

  // --- Simple routes (no DI needed) ---
  router.use("/comms", commsRoutes);
  router.use("/notes", notesRoutes);
  router.use("/analytics", analyticsRoutes);
  router.use("/usage", usageRoutes);
  router.use("/analytics-db", analyticsDbRoutes);
  router.use("/turns", turnsRoutes);
  router.use("/map", mapRoutes);
  router.use("/tool-calls", toolCallsRoutes);
  router.use("/activity", activityRoutes);
  router.use("/prompts", createPromptsRouter(fleetDir, config));
  router.use("/alerts", alertsRoutes);
  router.use("/server/logs", createServerLogsRouter(fleetDir));
  router.use("/combat", combatRoutes);
  router.use("/economy", economyRoutes);
  router.use("/captains-logs", createCaptainsLogsRouter());
  router.use("/knowledge", knowledgeRoutes);
  router.use("/pois", createPoiExplorerRouter());
  router.use("/lore", loreRoutes);
  router.use("/intel", intelRoutes);
  router.use("/resources", createResourcesRouter());
  router.use("/catalog", createCatalogRouter());

  // --- Game API rate limit tracker ---
  router.use("/rate-limits", rateLimitsGameRouter);

  // --- Overseer ---
  if (deps.overseerAgent) {
    router.use("/overseer", createOverseerRouter(deps.overseerAgent));
  }

  // --- Factory routes (need shared state / sessions) ---
  router.use("/action-proxy", createActionProxyRouter(sessions, registeredToolCount));

  // Build coordinator from shared state and wire it back in
  const coordinator = new FleetCoordinator(
    sharedState.cache.status,
    sharedState.cache.market,
    sharedState.fleet.arbitrageAnalyzer,
    sharedState.cache.battle,
  );
  sharedState.fleet.coordinator = coordinator;

  router.use("/coordinator", createCoordinatorRouter({ coordinator }));
  router.use("/market", createMarketRouter({
    marketCache: sharedState.cache.market,
    arbitrageAnalyzer: sharedState.fleet.arbitrageAnalyzer,
    marketReservations: sharedState.fleet.marketReservations,
    analyzeMarketCache: sharedState.fleet.analyzeMarketCache,
  }));
  router.use("/survivability", createSurvivabilityRouter(sharedState.cache.status, config));
  router.use("/fleet", createFleetCapacityRouter(sharedState.cache.status, config));
  router.use("/game-state", createGameStateRouter(sharedState.cache.status, sharedState.cache.market));
  router.use("/server-status", createServerStatusRouter(
    sharedState.proxy.gameHealthRef,
    sharedState.proxy.breakerRegistry,
    sharedState.proxy.serverMetrics,
  ));
  router.use("/health", createHealthRouter(sharedState.proxy.breakerRegistry));
  router.use("/outbound", createOutboundReviewRouter(sharedState.sessions.active));
  router.use("/accounts", createAccountsRouter(sessions, config.accountPool?.poolFile ?? null));
  router.use("/security", createSecurityRouter(sessions));
  router.use("/diagnostics", diagnosticsRoutes);
  router.use("/leaderboard", leaderboardRoutes);
  router.use("/prayer-canary", prayerCanaryRoutes);

  // Health monitor watchdog (optional — only when healthMonitor is provided)
  if (healthMonitor) {
    router.use("/diagnostics", createHealthMonitorRouter({ healthMonitor }));
  }

  // Catch-all 404 for unmatched API routes
  router.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return router;
}
