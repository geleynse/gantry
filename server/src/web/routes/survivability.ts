/**
 * Survivability API routes.
 *
 * Provides threat assessment, cloak policy, mod recommendations, and
 * runtime override management for agent survivability features.
 *
 * Mount: app.use("/api/survivability", createSurvivabilityRouter(statusCache, config))
 */

import { Router } from "express";
import type { GantryConfig } from "../../config.js";
import { getAgent, validateAgentName } from "../../config.js";
import { extractQueryAgent } from "../middleware/query-agent.js";
import { assessSystemThreat } from "../../proxy/threat-assessment.js";
import {
  evaluateCloakPolicy,
  setAgentCloakOverride,
  getCloakOverrides,
  CLOAK_THRESHOLDS,
} from "../../proxy/auto-cloak.js";
import { getModRecommendations } from "../../proxy/mod-policy.js";
import { queryAll } from "../../services/database.js";
import { createLogger } from '../../lib/logger.js';

const log = createLogger('survivability');

type StatusCache = Map<string, { data: Record<string, unknown>; fetchedAt: number }>;

const VALID_LEVELS = new Set(["safe", "low", "medium", "high", "extreme"]);
const KNOWN_ROLES = ["combat", "explorer", "hauler", "default"] as const;

/**
 * Extract hull percentage from a status cache entry.
 * Handles both player-wrapped and flat cache formats.
 */
function getHullPercent(data: Record<string, unknown>): number | undefined {
  const ship = (data.ship ?? (data as Record<string, unknown>)) as Record<string, unknown> | undefined;
  if (!ship) return undefined;
  const hull = Number(ship.hull ?? ship.hull_current);
  const maxHull = Number(ship.max_hull);
  if (!isNaN(hull) && !isNaN(maxHull) && maxHull > 0) {
    return (hull / maxHull) * 100;
  }
  return undefined;
}

export function createSurvivabilityRouter(
  statusCache: StatusCache,
  config: GantryConfig,
): Router {
  const router = Router();

  /**
   * GET /api/survivability/threat/:system
   * Threat assessment for a system. Pass ?agent=name to include hull factor.
   */
  router.get("/threat/:system", (req, res) => {
    const system = req.params.system;
    if (!system) {
      res.status(400).json({ error: "system required" });
      return;
    }

    let hullPercent: number | undefined;
    const agentParam = extractQueryAgent(req);
    if (agentParam) {
      const cached = statusCache.get(agentParam);
      if (cached) hullPercent = getHullPercent(cached.data);
    }

    const assessment = assessSystemThreat(system, hullPercent);
    res.json({ system, ...assessment });
  });

  /**
   * GET /api/survivability/policy/:agent
   * Current cloak policy for an agent: role, threshold, override, and fleet-wide toggle.
   */
  router.get("/policy/:agent", (req, res) => {
    const name = req.params.agent;
    if (!validateAgentName(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const agent = getAgent(name);
    const override = getCloakOverrides().get(name);
    const autoCloakEnabled = config.survivability?.autoCloakEnabled ?? false;

    res.json({
      agent: name,
      roleType: agent?.roleType ?? null,
      role: agent?.role ?? null,
      autoCloakEnabled,
      override: override ?? null,
    });
  });

  /**
   * GET /api/survivability/mods/:agent
   * Mod recommendations based on agent role.
   */
  router.get("/mods/:agent", (req, res) => {
    const name = req.params.agent;
    if (!validateAgentName(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const agent = getAgent(name);
    const recommendations = getModRecommendations(agent?.roleType);
    res.json({
      agent: name,
      roleType: agent?.roleType ?? null,
      recommendations,
    });
  });

  /**
   * GET /api/survivability/cloak-stats
   * Per-agent cloak activation stats from the last 24 hours.
   *
   * Returns for each configured agent:
   *   - cloakActivations: number of cloak tool calls in last 24h
   *   - threatsDetected: number of entries in combat_events in last 24h
   *   - threatsAvoided: cloak activations that occurred in a system with combat events
   */
  router.get("/cloak-stats", (_req, res) => {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    type CloakRow = { agent: string; count: number };
    type ThreatRow = { agent: string; count: number };

    let cloakRows: CloakRow[] = [];
    let threatRows: ThreatRow[] = [];

    try {
      cloakRows = queryAll<CloakRow>(
        `SELECT agent, COUNT(*) as count
         FROM proxy_tool_calls
         WHERE tool_name LIKE '%cloak%'
           AND success = 1
           AND created_at >= ?
         GROUP BY agent`,
        since
      );
    } catch (err) {
      log.debug('cloak-stats query skipped', { error: err instanceof Error ? err.message : String(err) });
    }

    try {
      threatRows = queryAll<ThreatRow>(
        `SELECT agent, COUNT(*) as count
         FROM combat_events
         WHERE event_type IN ('pirate_combat', 'pirate_warning')
           AND created_at >= ?
         GROUP BY agent`,
        since
      );
    } catch (err) {
      log.debug('threat-stats query skipped', { error: err instanceof Error ? err.message : String(err) });
    }

    const cloakMap = new Map(cloakRows.map((r) => [r.agent, r.count]));
    const threatMap = new Map(threatRows.map((r) => [r.agent, r.count]));

    const stats = config.agents.map((a) => {
      const cloakActivations = cloakMap.get(a.name) ?? 0;
      const threatsDetected = threatMap.get(a.name) ?? 0;
      // Avoided = min(cloak activations, threats detected) — a proxy for effective evasions
      const threatsAvoided = Math.min(cloakActivations, threatsDetected);
      return { agent: a.name, cloakActivations, threatsDetected, threatsAvoided };
    });

    res.json({ windowHours: 24, stats });
  });

  /**
   * GET /api/survivability/thresholds
   * Current effective cloak thresholds (config overrides merged with defaults).
   */
  router.get("/thresholds", (_req, res) => {
    const cfgThresholds = config.survivability?.thresholds;
    const effective = {
      combat: cfgThresholds?.combat ?? CLOAK_THRESHOLDS.combat,
      explorer: cfgThresholds?.explorer ?? CLOAK_THRESHOLDS.explorer,
      hauler: cfgThresholds?.hauler ?? CLOAK_THRESHOLDS.hauler,
      default: cfgThresholds?.default ?? CLOAK_THRESHOLDS.default,
    };
    res.json({ thresholds: effective, source: cfgThresholds !== undefined ? "config" : "defaults" });
  });

  /**
   * POST /api/survivability/thresholds
   * Update cloak thresholds at runtime (merges with current config survivability.thresholds).
   *
   * Body: Partial<{ combat, explorer, hauler, default }> — each a ThreatLevel string.
   * Valid levels: safe | low | medium | high | extreme
   */
  router.post("/thresholds", (req, res) => {
    const body = req.body ?? {};
    const updates: Record<string, string> = {};

    for (const role of KNOWN_ROLES) {
      if (role in body) {
        if (!VALID_LEVELS.has(body[role])) {
          res.status(400).json({ error: `Invalid threshold '${body[role]}' for role '${role}'. Must be one of: ${[...VALID_LEVELS].join(", ")}` });
          return;
        }
        updates[role] = body[role];
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No valid threshold fields provided" });
      return;
    }

    // Merge into config survivability.thresholds
    if (!config.survivability) config.survivability = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config.survivability.thresholds = {
      ...(config.survivability.thresholds ?? {}),
      ...updates,
    } as any;

    res.json({ ok: true, thresholds: config.survivability.thresholds });
  });

  /**
   * POST /api/survivability/cloak-policy
   * Update runtime cloak policy for an agent (or all agents).
   *
   * Body: { agent?: string, enabled: boolean | null }
   * - enabled=true  → force-enable cloak regardless of threat (uses medium threshold)
   * - enabled=false → force-disable cloak for this agent
   * - enabled=null  → clear override, revert to role-based policy
   */
  router.post("/cloak-policy", (req, res) => {
    const { agent, enabled } = req.body ?? {};

    if (enabled !== null && typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be boolean or null" });
      return;
    }

    if (agent !== undefined) {
      if (!validateAgentName(agent)) {
        res.status(404).json({ error: `Unknown agent: ${agent}` });
        return;
      }
      setAgentCloakOverride(agent, enabled as boolean | null);
      res.json({ ok: true, agent, enabled: enabled ?? null });
    } else {
      // Apply to all configured agents
      for (const a of config.agents) {
        setAgentCloakOverride(a.name, enabled as boolean | null);
      }
      res.json({ ok: true, agent: "all", enabled: enabled ?? null });
    }
  });

  return router;
}
