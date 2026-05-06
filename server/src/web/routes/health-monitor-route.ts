/**
 * GET /api/diagnostics/health-monitor
 *
 * Returns per-agent watchdog state: desired state, consecutive restart count,
 * and remaining backoff time in seconds.
 */
import { Router } from 'express';
import { createLogger } from '../../lib/logger.js';
import type { HealthMonitor } from '../../services/health-monitor.js';

const log = createLogger("health-monitor-route");

export interface HealthMonitorRouterDeps {
  healthMonitor: HealthMonitor;
}

export function createHealthMonitorRouter(deps: HealthMonitorRouterDeps): Router {
  const router = Router();

  router.get('/health-monitor', (_req, res) => {
    try {
      const allStates = deps.healthMonitor.getAllStates();
      const now = Date.now();

      const agents = Object.fromEntries(
        Object.entries(allStates).map(([name, state]) => [
          name,
          {
            ...state,
            backoffRemainingSec: Math.max(
              0,
              Math.ceil((state.nextRestartAfterMs - now) / 1000),
            ),
          },
        ]),
      );

      res.json({ agents });
    } catch (err) {
      log.error("Failed to get health monitor state", { error: String(err) });
      res.status(500).json({ error: "Internal error fetching health monitor state" });
    }
  });

  return router;
}
