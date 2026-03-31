/**
 * API routes for resource knowledge and override history.
 *
 * GET /api/resources                — list all known resources
 * GET /api/resources?resource=X     — query locations for a specific resource
 * GET /api/resources?system=X       — query all resources in a system
 * GET /api/resources/stats          — resource knowledge stats
 */

import { Router } from "express";
import { ResourceKnowledge } from "../../services/resource-knowledge.js";

export function createResourcesRouter(): Router {
  const router = Router();
  const rk = new ResourceKnowledge();

  router.get("/", (req, res) => {
    const resource = req.query.resource as string | undefined;
    const system = req.query.system as string | undefined;

    if (resource) {
      const locations = rk.query(resource);
      const bestBuy = rk.getBestPrice(resource);
      const bestSell = rk.getBestSellPrice(resource);
      return res.json({
        resource,
        locations,
        best_buy_price: bestBuy,
        best_sell_price: bestSell,
        total: locations.length,
      });
    }

    if (system) {
      const resources = rk.querySystem(system);
      return res.json({ system, resources, total: resources.length });
    }

    // List all known resources
    const resources = rk.listResources();
    return res.json({ resources, total: resources.length, record_count: rk.count() });
  });

  router.get("/stats", (_req, res) => {
    const total = rk.count();
    const resources = rk.listResources();
    res.json({ total_records: total, unique_resources: resources.length });
  });

  return router;
}
