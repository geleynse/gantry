/**
 * Combat auto-trigger system for responding to pirate and player combat events.
 *
 * IMPORTANT — NPC vs PvP combat distinction:
 * - NPC combat (pirates) is AUTOMATIC. The game resolves it server-side. `scan_and_attack` and
 *   `attack` do NOT work against NPCs. The correct response to pirate_warning/pirate_combat is:
 *   - If hull is OK (>30%): do nothing, let it resolve, loot_wrecks afterward
 *   - If hull is low (<30%): flee
 * - PvP combat (player_combat) may warrant scan_and_attack for combat-role agents
 *
 * Therefore:
 * - pirate_warning/pirate_combat → NO auto-scan_and_attack (was wrong, now removed)
 * - pirate_combat → auto-flee ONLY if hull is critically low (<50%)
 * - player_combat → auto-flee for non-combat agents, scan_and_attack for combat agents
 * - pirate_warning → log only, no action (pre-combat notice, combat is automatic)
 */

import { createLogger } from "../lib/logger.js";
import type { GantryConfig } from "../config.js";
import type { EventBuffer } from "./event-buffer.js";

const log = createLogger("combat-auto-trigger");

/**
 * Check if an agent has a combat role.
 * Returns true if the agent's role field contains "combat" (case-insensitive).
 */
export function isCombatAgent(config: GantryConfig, agentName: string): boolean {
  const agent = config.agents.find((a) => a.name === agentName);
  if (!agent || !agent.role) return false;
  return agent.role.toLowerCase().includes("combat");
}

/**
 * Check if there's a combat event (pirate_combat or player_combat) that should trigger auto-attack.
 * Returns true if the agent has a combat event in their buffer and is a combat-role agent.
 *
 * Note: This function checks for combat events but does NOT drain them.
 * The event will be drained later in withInjections() along with
 * other critical events. This allows the event to be delivered to the agent as well
 * as triggering the auto-response.
 */
export function shouldAutoTriggerCombat(
  config: GantryConfig,
  eventBuffers: Map<string, EventBuffer>,
  agentName: string,
): boolean {
  // Only auto-trigger for combat-role agents
  if (!isCombatAgent(config, agentName)) {
    return false;
  }

  const buffer = eventBuffers.get(agentName);
  if (!buffer) return false;

  // Only trigger scan_and_attack on player_combat events (PvP).
  // pirate_combat is NPC auto-combat — scan_and_attack cannot help (attack is PvP only).
  if (buffer.hasEventOfType(["player_combat"])) {
    log.info("auto-trigger: player_combat detected for combat-role agent → scan_and_attack", {
      agent: agentName,
    });
    return true;
  }

  // pirate_warning: log for research purposes, no action (NPC auto-combat, player can't intervene)
  if (buffer.hasEventOfType(["pirate_warning"])) {
    log.info("auto-trigger: pirate_warning detected — NPC auto-combat, no scan_and_attack (research log)", {
      agent: agentName,
      note: "pirate_warning fires 1-3 ticks before NPC auto-combat begins. No player action possible.",
    });
  }

  return false;
}

/**
 * Check if a non-combat agent should auto-flee due to a combat event (pirate_combat or player_combat).
 * Returns true for any agent role (combat or not) that has a combat event
 * AND is NOT a combat agent (combat agents use scan_and_attack instead).
 *
 * @param hullPercent Current hull percentage (0-100). If provided, pirate_combat only flees if hull < 50%.
 */
export function shouldAutoFlee(
  config: GantryConfig,
  eventBuffers: Map<string, EventBuffer>,
  agentName: string,
  hullPercent?: number,
): boolean {
  // Combat agents handle their own flee decisions
  if (isCombatAgent(config, agentName)) {
    return false;
  }

  const buffer = eventBuffers.get(agentName);
  if (!buffer) return false;

  // player_combat → always flee for non-combat agents
  if (buffer.hasEventOfType(["player_combat"])) {
    log.info("auto-trigger: player_combat detected for non-combat agent → flee", { agent: agentName });
    return true;
  }

  // pirate_combat → NPC auto-combat is taking damage. Non-combat agents should flee.
  // (They don't have weapons to fight back effectively anyway.)
  if (buffer.hasEventOfType(["pirate_combat"])) {
    // If hull is known and healthy (>50%), don't flee yet — let it resolve or wait for damage
    if (hullPercent !== undefined && hullPercent >= 50) {
      log.info("auto-trigger: pirate_combat detected but hull is healthy (>50%) → skipping auto-flee", {
        agent: agentName,
        hull: hullPercent,
      });
      return false;
    }

    log.info("auto-trigger: pirate_combat detected for non-combat agent → flee (NPC auto-combat)", {
      agent: agentName,
      hull: hullPercent ?? "unknown",
      note: "NPC combat is automatic — fleeing to stop damage.",
    });
    return true;
  }

  // pirate_warning: log only — it's just a warning, not yet taking damage. Don't flee preemptively.
  // NPC auto-combat hasn't started. Fleeing on warning wastes turns and leaves wreck loot behind.
  if (buffer.hasEventOfType(["pirate_warning"])) {
    log.info("auto-trigger: pirate_warning (research log — NPC pre-combat notice, no flee triggered)", {
      agent: agentName,
      note: "pirate_warning is pre-combat. Waiting for pirate_combat before fleeing saves turns.",
    });
  }

  return false;
}

/**
 * Determine if the agent should auto-trigger a combat response.
 * - Combat agents with pirate_combat or player_combat event → return "scan_and_attack"
 * - Non-combat agents with pirate_combat or player_combat event → return "flee"
 * - Otherwise → return the original action unchanged
 *
 * This is used to interrupt long-running compound tools (jump_route, travel_to, etc.)
 * when the agent comes under attack.
 */
export function getAutoTriggerAction(
  config: GantryConfig,
  eventBuffers: Map<string, EventBuffer>,
  agentName: string,
  originalAction: string,
  hullPercent?: number,
): string {
  if (shouldAutoTriggerCombat(config, eventBuffers, agentName)) {
    log.info("auto-trigger: interrupting action to execute scan_and_attack", {
      agent: agentName,
      interrupted: originalAction,
      timestamp: Date.now(),
    });
    return "scan_and_attack";
  }
  if (shouldAutoFlee(config, eventBuffers, agentName, hullPercent)) {
    log.info("auto-trigger: interrupting action to execute flee (non-combat agent)", {
      agent: agentName,
      interrupted: originalAction,
      timestamp: Date.now(),
    });
    return "flee";
  }
  return originalAction;
}
