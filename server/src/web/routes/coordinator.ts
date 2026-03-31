/**
 * API routes for the supply-chain coordinator.
 * Factory function follows the same pattern as createMarketRouter.
 */

import { Router } from "express";
import type { FleetCoordinator } from "../../services/coordinator.js";
import { queryInt } from "../middleware/query-helpers.js";

export interface CoordinatorRouterDeps {
  coordinator: FleetCoordinator;
}

export function createCoordinatorRouter({ coordinator }: CoordinatorRouterDeps): Router {
  const router = Router();

  /**
   * GET /api/coordinator/status
   * Current tick state, assignments, and quota summary.
   */
  router.get("/status", (_req, res) => {
    const lastTick = coordinator.getLastTick();
    const quotas = coordinator.getActiveQuotas();
    const zoneCoverage = coordinator.getZoneCoverage();
    res.json({
      enabled: coordinator.isEnabled(),
      lastTick,
      activeQuotas: quotas,
      zoneCoverage,
    });
  });

  /**
   * GET /api/coordinator/history
   * Last N ticks with outcomes.
   */
  router.get("/history", (req, res) => {
    const limit = Math.min(Math.max(1, queryInt(req, 'limit') ?? 10), 100);
    const history = coordinator.getHistory(limit);
    res.json({ history });
  });

  /**
   * POST /api/coordinator/tick
   * Force an immediate coordinator tick (admin only).
   */
  router.post("/tick", async (req, res) => {
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    try {
      const result = await coordinator.tick();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * POST /api/coordinator/enable
   * Enable or disable the coordinator at runtime.
   * Body: { enabled: boolean }
   */
  router.post("/enable", (req, res) => {
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "Body must include { enabled: boolean }" });
      return;
    }
    coordinator.setEnabled(enabled);
    res.json({ enabled: coordinator.isEnabled() });
  });

  /**
   * GET /api/coordinator/quotas
   * Active quotas with progress.
   */
  router.get("/quotas", (_req, res) => {
    const quotas = coordinator.getActiveQuotas();
    res.json({ quotas });
  });

  /**
   * POST /api/coordinator/quotas
   * Manually create a quota.
   * Body: { item_id: string, target_quantity: number, station_id: string, assigned_to?: string }
   */
  router.post("/quotas", (req, res) => {
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const { item_id, target_quantity, station_id, assigned_to } = req.body;
    if (!item_id || !target_quantity || !station_id) {
      res.status(400).json({
        error: "Body must include { item_id, target_quantity, station_id }",
      });
      return;
    }
    try {
      const quota = coordinator.createQuota(
        item_id,
        target_quantity,
        station_id,
        assigned_to,
      );
      res.status(201).json(quota);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  /**
   * DELETE /api/coordinator/quotas/:id
   * Cancel an active quota.
   */
  router.delete("/quotas/:id", (req, res) => {
    if (req.auth?.role !== "admin") {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const quotaId = parseInt(req.params.id, 10);
    if (isNaN(quotaId)) {
      res.status(400).json({ error: "Invalid quota ID" });
      return;
    }
    const cancelled = coordinator.cancelQuota(quotaId);
    if (cancelled) {
      res.json({ ok: true, cancelled: quotaId });
    } else {
      res.status(404).json({ error: "Quota not found or not active" });
    }
  });

  return router;
}
