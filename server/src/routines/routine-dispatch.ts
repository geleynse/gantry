/**
 * Routine Dispatch — intercepts agent output containing ROUTINE: directives
 * and executes the corresponding routine instead of passing to the game.
 *
 * Integration point: called from the proxy pipeline when an agent's tool output
 * or text response contains a ROUTINE: directive.
 *
 * Implemented — Phase 1A
 */

import { createLogger } from "../lib/logger.js";
import type { RoutineContext, RoutineResult, RoutineToolClient } from "./types.js";
import { runRoutine, formatRoutineResult, getAvailableRoutines } from "./routine-runner.js";
import type { GameClientLike } from "../proxy/compound-tools-impl.js";

const log = createLogger("routine-dispatch");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Events that should immediately interrupt a running routine. */
const INTERRUPT_EVENTS = [
  "pirate_warning", "pirate_combat",   // NPC combat
  "combat_update",                      // active combat in progress
  "player_died", "respawn_state",       // death and respawn
  "police_warning",                     // law enforcement
  "scan_detected",                      // potential PvP threat
] as string[];

// ---------------------------------------------------------------------------
// Directive parsing
// ---------------------------------------------------------------------------

export interface RoutineDirective {
  name: string;
  params: Record<string, unknown>;
}

/** Cached sentinel pattern — auto-invalidated when routine count changes. */
let cachedSentinelPattern: RegExp | null = null;
let cachedRoutineCount = -1;

/**
 * Build (or return cached) sentinel regex that matches ROUTINE:<name> only:
 *   - At the start of the string or immediately after a newline
 *   - Followed by a known (whitelisted) routine name
 *
 * This prevents injection from agents that merely *discuss* routines
 * mid-sentence or mid-paragraph.
 */
function buildSentinelPattern(): RegExp {
  const known = getAvailableRoutines();
  if (known.length === cachedRoutineCount && cachedSentinelPattern) {
    return cachedSentinelPattern;
  }
  cachedRoutineCount = known.length;
  if (known.length === 0) {
    cachedSentinelPattern = /(?!)/;
    return cachedSentinelPattern;
  }
  const names = known.join("|");
  cachedSentinelPattern = new RegExp(`(?:^|\\n)ROUTINE:(${names})[ \\t]*(?:\\n)?(\\{[\\s\\S]*?\\})?`);
  return cachedSentinelPattern;
}

/**
 * Parse a ROUTINE: directive from agent text output.
 * Format: ROUTINE:routine_name {"param": "value", ...}
 * or:     ROUTINE:routine_name\n{"param": "value", ...}
 *
 * Only matches at the start of a line and against the known routine whitelist.
 * Returns null if no valid directive found.
 */
export function parseRoutineDirective(text: string): RoutineDirective | null {
  const pattern = buildSentinelPattern();
  const match = text.match(pattern);
  if (!match) return null;

  const name = match[1];
  let params: Record<string, unknown> = {};

  if (match[2]) {
    try {
      params = JSON.parse(match[2]);
    } catch {
      log.warn("routine directive has invalid JSON params", { name, raw: match[2] });
      // Still return the directive — params default to empty
    }
  }

  return { name, params };
}

/**
 * Check if agent text contains a routine directive.
 * Only detects directives at the start of a line with a known routine name.
 */
export function hasRoutineDirective(text: string): boolean {
  return buildSentinelPattern().test(text);
}

// ---------------------------------------------------------------------------
// Config gate
// ---------------------------------------------------------------------------

/**
 * Check if an agent has routineMode enabled in fleet config.
 */
export function isRoutineModeEnabled(
  agentName: string,
  fleetConfig: { agents?: Array<{ name: string; routineMode?: boolean }> },
): boolean {
  if (!fleetConfig?.agents) return false;
  const agent = fleetConfig.agents.find((a) => a.name === agentName);
  return agent?.routineMode === true;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface DispatchDeps {
  /** Game client for tool execution. */
  client: GameClientLike;
  /** Agent name. */
  agentName: string;
  /** Status cache. */
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  /** Battle cache for mid-routine combat checks. */
  battleCache?: Map<string, unknown>;
  /** Event buffers for pirate/combat event detection. */
  eventBuffers?: Map<string, { hasEventOfType(types: string[]): boolean }>;
  /** Optional callback to log each sub-tool call for dashboard visibility. */
  logSubTool?: (toolName: string, args: unknown, result: unknown, durationMs: number) => void;
}

/**
 * Dispatch a routine directive. Returns the formatted result text for LLM consumption,
 * or null if the routine is unknown / dispatch fails.
 */
export async function dispatchRoutine(
  directive: RoutineDirective,
  deps: DispatchDeps,
): Promise<{ result: RoutineResult; formatted: string }> {
  // Wrap execute with logging and battle-check interception
  const rawExecute = deps.client.execute.bind(deps.client);

  const wrappedExecute: RoutineToolClient["execute"] = async (tool, args, opts) => {
    // Mid-routine battle check: if combat started, abort sub-tool
    if (deps.battleCache?.get(deps.agentName)) {
      return { error: "combat_started — routine aborting, hand off to agent" };
    }

    // Pre-check: dangerous events mean agent should take control
    const agentEvents = deps.eventBuffers?.get(deps.agentName);
    if (agentEvents?.hasEventOfType(INTERRUPT_EVENTS)) {
      const detected = INTERRUPT_EVENTS.find(e => agentEvents.hasEventOfType([e])) ?? "unknown";
      log.warn("routine interrupted by event", { agent: deps.agentName, event: detected, routine: directive.name });
      return { error: `${detected} — routine aborting, take control` };
    }

    const t0 = Date.now();
    const result = await rawExecute(tool, args, opts);
    const durationMs = Date.now() - t0;

    // Log sub-tool call with namespaced name for dashboard visibility
    if (deps.logSubTool) {
      const namespacedTool = `routine:${directive.name}:${tool}`;
      deps.logSubTool(namespacedTool, args, result, durationMs);
    }

    // Post-check: game response may have triggered dangerous events
    if (agentEvents?.hasEventOfType(INTERRUPT_EVENTS)) {
      const detected = INTERRUPT_EVENTS.find(e => agentEvents.hasEventOfType([e])) ?? "unknown";
      log.warn("dangerous event detected after tool call, aborting routine", { agent: deps.agentName, event: detected, tool });
      return { error: `${detected} — routine aborting after ${tool}, take control` };
    }

    return result;
  };

  const routineClient: RoutineToolClient = {
    execute: wrappedExecute,
    waitForTick: deps.client.waitForTick.bind(deps.client),
  };

  const ctx: RoutineContext = {
    agentName: deps.agentName,
    client: routineClient,
    statusCache: deps.statusCache,
    log: (level, msg, data) => {
      log[level]?.(msg, { agent: deps.agentName, ...data });
    },
  };

  const result = await runRoutine(directive.name, directive.params, ctx);

  // If battle or dangerous event occurred mid-routine and we got a normal completion,
  // convert to handoff so the agent can take control
  const postEvents = deps.eventBuffers?.get(deps.agentName);
  const hasInterrupt = postEvents?.hasEventOfType(INTERRUPT_EVENTS);
  if ((deps.battleCache?.get(deps.agentName) || hasInterrupt) && result.status === "completed") {
    result.status = "handoff";
    const detected = hasInterrupt
      ? INTERRUPT_EVENTS.find(e => postEvents!.hasEventOfType([e])) ?? "event_detected"
      : "combat_started";
    result.handoffReason = detected;
  }

  const formatted = formatRoutineResult(directive.name, result);

  return { result, formatted };
}
