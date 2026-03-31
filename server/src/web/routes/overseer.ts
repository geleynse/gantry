import { Router } from "express";
import type { OverseerAgent } from "../../services/overseer-agent.js";
import { getAgent, getConfig } from "../../config/fleet.js";

export function createOverseerRouter(overseerAgent: OverseerAgent): Router {
  const router = Router();

  router.get("/decisions", (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    res.json(overseerAgent.getDecisionHistory(limit));
  });

  router.get("/decisions/:id", (req, res) => {
    const id = Number(req.params.id);
    const decision = overseerAgent.getDecisionById(id);
    if (!decision) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(decision);
  });

  router.get("/status", (_req, res) => {
    const agentConfig = getAgent("overseer");
    const gantryConfig = getConfig();
    const overseerConfig = gantryConfig.overseer;
    const lastDecision = overseerAgent.getDecisionHistory(1)[0] ?? null;
    const turnIntervalSeconds = overseerConfig?.intervalMinutes
      ? overseerConfig.intervalMinutes * 60
      : 300; // default 5 min for overseer
    const turnIntervalMs = turnIntervalSeconds * 1000;
    const lastTickAt = lastDecision?.created_at ?? null;
    const nextTickAt = lastTickAt
      ? new Date(new Date(lastTickAt).getTime() + turnIntervalMs).toISOString()
      : null;

    res.json({
      // Runtime
      state: agentConfig ? "idle" : "stopped",
      enabled: overseerConfig?.enabled ?? false,
      tickNumber: lastDecision?.tick_number ?? 0,
      lastTickAt,
      nextTickAt,
      costToday: overseerAgent.getCostToday(),
      decisionsToday: overseerAgent.getDecisionsToday(),
      // Config
      model: agentConfig?.model ?? overseerConfig?.model ?? "unknown",
      turnIntervalSeconds,
      config: overseerConfig ?? null,
    });
  });

  return router;
}
