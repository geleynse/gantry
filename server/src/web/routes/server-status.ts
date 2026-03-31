/**
 * GET /api/server-status        — JSON snapshot of game server health
 * GET /api/server-status/stream  — SSE stream pushing updates every 10s
 */
import { Router } from "express";
import { initSSE, writeSSE } from "../sse.js";
import { computeServerStatus, type GameHealthRef } from "../../services/health-status.js";
import { createLogger } from "../../lib/logger.js";
import type { BreakerRegistry } from "../../proxy/circuit-breaker.js";
import type { MetricsWindow } from "../../proxy/instability-metrics.js";

const log = createLogger("server-status");

export function createServerStatusRouter(gameHealthRef: GameHealthRef, breakerRegistry: BreakerRegistry, serverMetrics: MetricsWindow): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(computeServerStatus(gameHealthRef, breakerRegistry, serverMetrics));
  });

  router.get("/stream", (req, res) => {
    initSSE(req, res);

    let aborted = false;

    // Send immediately, then every 10s
    const send = () => {
      if (aborted) return;
      try {
        writeSSE(res, "server-status", computeServerStatus(gameHealthRef, breakerRegistry, serverMetrics));
      } catch (err) {
        if (!aborted) log.error(`SSE server-status error: ${err}`);
      }
    };

    send();
    const interval = setInterval(send, 10_000);

    req.on("close", () => {
      aborted = true;
      clearInterval(interval);
      res.end();
    });
  });

  return router;
}
