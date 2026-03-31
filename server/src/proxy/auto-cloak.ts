/**
 * Auto-cloak policy evaluation and per-agent state tracking.
 *
 * Determines whether an agent should receive an auto-cloak advisory when entering
 * a new system, based on:
 * - System threat level
 * - Agent role (combat agents tolerate more danger; explorers are cautious)
 * - Per-system cooldown (never re-cloak in the same system)
 * - Docked status (never cloak when docked)
 * - Per-agent runtime overrides (set via API without restarting)
 *
 * The proxy does NOT execute cloak directly — it injects an advisory into the
 * tool response as _cloak_advisory. The agent calls spacemolt(action="cloak")
 * on its next turn.
 */

import { createLogger } from "../lib/logger.js";
import type { GantryConfig } from "../config.js";
import { assessSystemThreat, type ThreatLevel } from "./threat-assessment.js";

const log = createLogger("auto-cloak");

// Ordered threat levels for threshold comparison
const THREAT_ORDER: Record<ThreatLevel, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  extreme: 4,
};

/**
 * Default per-role cloak thresholds.
 * Overridable via fleet-config.json under `survivability.thresholds`.
 */
export const CLOAK_THRESHOLDS: Record<string, ThreatLevel> = {
  combat: "extreme",
  explorer: "high",
  hauler: "medium",
  default: "medium",
};

// Per-agent: last system where a cloak advisory was evaluated (prevents re-cloaking same system)
const lastCloakSystem = new Map<string, string>();

// Per-agent manual overrides: true = force-enable, false = force-disable
// Set via POST /api/survivability/cloak-policy
const agentPolicyOverrides = new Map<string, boolean>();

/** Set a per-agent cloak policy override. Pass null to clear. */
export function setAgentCloakOverride(agentName: string, enabled: boolean | null): void {
  if (enabled === null) {
    agentPolicyOverrides.delete(agentName);
    log.info("cloak override cleared", { agent: agentName });
  } else {
    agentPolicyOverrides.set(agentName, enabled);
    log.info("cloak override set", { agent: agentName, enabled });
  }
}

/** Return all active per-agent overrides (defensive copy). */
export function getCloakOverrides(): Map<string, boolean> {
  return new Map(agentPolicyOverrides);
}

/** Reset all module state. For testing only. */
export function _resetCloakState(): void {
  lastCloakSystem.clear();
  agentPolicyOverrides.clear();
}

/**
 * Detect role type for an agent, checking roleType enum first then role string.
 * Mirrors the pattern in combat-auto-trigger.ts (role.toLowerCase().includes(...)).
 */
function resolveRoleType(config: GantryConfig, agentName: string): string {
  const agent = config.agents.find((a) => a.name === agentName);
  if (!agent) return "unknown";
  if (agent.roleType) return agent.roleType;
  if (!agent.role) return "unknown";
  const r = agent.role.toLowerCase();
  if (r.includes("combat")) return "combat";
  if (r.includes("explorer")) return "explorer";
  if (r.includes("trader")) return "trader";
  if (r.includes("miner")) return "miner";
  if (r.includes("crafter")) return "crafter";
  return "unknown";
}

/**
 * Get the minimum threat level at which an agent should cloak.
 * Prefers config-defined thresholds (survivability.thresholds), falls back to CLOAK_THRESHOLDS.
 * - combat: only cloak at extreme threat (they fight otherwise)
 * - explorer: cloak at high+ threat (fragile ships, need safe passage)
 * - all others: cloak at medium+ threat (default cautious policy)
 */
function getCloakThreshold(roleType: string, config?: GantryConfig): ThreatLevel {
  const cfgThresholds = config?.survivability?.thresholds;
  if (cfgThresholds) {
    const key = roleType as keyof typeof cfgThresholds;
    if (key in cfgThresholds && cfgThresholds[key]) {
      return cfgThresholds[key] as ThreatLevel;
    }
    if (cfgThresholds.default) return cfgThresholds.default as ThreatLevel;
  }
  return (CLOAK_THRESHOLDS[roleType] ?? CLOAK_THRESHOLDS.default) as ThreatLevel;
}

/**
 * Evaluate whether an agent should auto-cloak given current threat and role.
 *
 * Pure function — no side effects. State updates are in checkCloakAdvisory().
 *
 * @param roleType - Resolved role type string
 * @param threatLevel - System threat level
 * @param overrideEnabled - Runtime override (true=force cloak, false=force skip, undefined=use policy)
 * @param config - Fleet config for threshold lookup (optional, falls back to CLOAK_THRESHOLDS)
 * @returns true if the agent should cloak
 */
export function evaluateCloakPolicy(
  roleType: string,
  threatLevel: ThreatLevel,
  overrideEnabled?: boolean,
  config?: GantryConfig,
): boolean {
  // Override: force-disable always wins
  if (overrideEnabled === false) return false;

  // Override: force-enable uses medium threshold (or config default if set)
  const threshold =
    overrideEnabled === true
      ? ((config?.survivability?.thresholds?.default as ThreatLevel | undefined) ?? "medium")
      : getCloakThreshold(roleType, config);

  return THREAT_ORDER[threatLevel] >= THREAT_ORDER[threshold];
}

/**
 * Check whether a cloak advisory should be injected for the given agent and system.
 *
 * Called from withInjections() on every tool response. Only generates an advisory
 * when the agent has entered a new system AND the threat warrants it.
 *
 * @param agentName - Agent to evaluate
 * @param currentSystem - Agent's current system (from statusCache)
 * @param isDocked - Whether the agent is currently docked
 * @param hullPercent - Current hull percentage (affects threat scoring)
 * @param config - Fleet config (for role lookup and autoCloakEnabled flag)
 * @returns Advisory string to inject, or null if no advisory needed
 */
export function checkCloakAdvisory(
  agentName: string,
  currentSystem: string,
  isDocked: boolean,
  hullPercent: number | undefined,
  config: GantryConfig,
): string | null {
  // Never cloak while docked
  if (isDocked) return null;

  // Feature disabled fleet-wide (survivability.autoCloakEnabled must be true to activate)
  if (!(config.survivability?.autoCloakEnabled ?? false)) return null;

  const override = agentPolicyOverrides.get(agentName);

  // Same-system cooldown: don't re-evaluate until the agent jumps somewhere new
  const lastSystem = lastCloakSystem.get(agentName);
  if (lastSystem === currentSystem) return null;

  // New system — update tracking and evaluate threat
  lastCloakSystem.set(agentName, currentSystem);

  const assessment = assessSystemThreat(currentSystem, hullPercent);
  const roleType = resolveRoleType(config, agentName);
  const shouldCloak = evaluateCloakPolicy(roleType, assessment.level, override, config);

  if (!shouldCloak) return null;

  log.info("auto-cloak advisory triggered", {
    agent: agentName,
    system: currentSystem,
    level: assessment.level,
    score: assessment.score,
    role: roleType,
    override: override ?? "none",
  });

  return (
    `[AUTO-CLOAK] Threat: ${assessment.level} (${assessment.score}/100) in ${currentSystem}. ` +
    `Call spacemolt(action="cloak") immediately.`
  );
}
