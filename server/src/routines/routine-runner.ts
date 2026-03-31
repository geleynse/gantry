/**
 * Routine Runner — executes a named routine and returns a RoutineResult.
 *
 * The runner is the bridge between the proxy dispatch layer and individual
 * routine implementations. It handles:
 * - Looking up routines by name
 * - Parsing params
 * - Executing with timeout/max-step guards
 * - Formatting results for LLM consumption
 *
 * Implemented — Phase 1
 */

import { createLogger } from "../lib/logger.js";
import type { RoutineContext, RoutineDefinition, RoutineResult } from "./types.js";
import { sellCycleRoutine } from "./sell-cycle.js";
import { miningLoopRoutine } from "./mining-loop.js";
import { refuelRepairRoutine } from "./refuel-repair.js";
import { patrolAndAttackRoutine } from "./patrol-and-attack.js";
import { missionRunRoutine } from "./mission-run.js";
import { missionCheckRoutine } from "./mission-check.js";
import { navigateAndMineRoutine } from "./navigate-and-mine.js";
import { craftAndSellRoutine } from "./craft-and-sell.js";
import { exploreSystemRoutine } from "./explore-system.js";
import { salvageLoopRoutine } from "./salvage-loop.js";
import { fullTradeRunRoutine } from "./full-trade-run.js";
import { supplyRunRoutine } from "./supply-run.js";
import { navigateHomeRoutine } from "./navigate-home.js";
import { exploreAndMineRoutine } from "./explore-and-mine.js";
import { manageStorageRoutine } from "./manage-storage.js";
import { upgradeShipRoutine } from "./upgrade-ship.js";
import { fleetRefuelRoutine } from "./fleet-refuel.js";
import { fleetJumpRoutine } from "./fleet-jump.js";

const log = createLogger("routine-runner");

// ---------------------------------------------------------------------------
// Routine registry
// ---------------------------------------------------------------------------

const ROUTINE_REGISTRY = new Map<string, RoutineDefinition<any>>();

// All built-in routines — single source of truth for both init and test reset
// (RoutineDefinition<any> is intentional: the generic variance makes a tighter type impractical)
const BUILTIN_ROUTINES: RoutineDefinition<any>[] = [
  sellCycleRoutine, miningLoopRoutine, refuelRepairRoutine,
  patrolAndAttackRoutine, missionRunRoutine, missionCheckRoutine,
  navigateAndMineRoutine, craftAndSellRoutine, exploreSystemRoutine,
  salvageLoopRoutine, fullTradeRunRoutine, supplyRunRoutine,
  navigateHomeRoutine, exploreAndMineRoutine, manageStorageRoutine,
  upgradeShipRoutine, fleetRefuelRoutine, fleetJumpRoutine,
];

function registerAll(): void {
  ROUTINE_REGISTRY.clear();
  for (const routine of BUILTIN_ROUTINES) {
    ROUTINE_REGISTRY.set(routine.name, routine);
  }
}

/** Exported for testing only — resets registry to default state */
export function _resetRegistryForTest(): void {
  registerAll();
}

// Register built-in routines
registerAll();

// ---------------------------------------------------------------------------
// Routine → tool mapping (for denied-tool pre-flight checks)
// ---------------------------------------------------------------------------

/**
 * Static map of routine name → set of game tools that routine calls via ctx.client.execute().
 * Used by the proxy to reject execute_routine before it starts if any of the routine's
 * tools are in agentDeniedTools for that agent.
 */
const ROUTINE_TOOLS: Record<string, readonly string[]> = {
  sell_cycle: ["analyze_market", "get_cargo", "multi_sell"],
  mining_loop: ["travel_to", "get_cargo", "batch_mine"],
  refuel_repair: ["travel_to", "dock", "get_status", "refuel", "repair"],
  patrol_and_attack: ["get_status", "jump", "scan_and_attack", "loot_wrecks"],
  mission_run: ["travel_to", "dock", "get_active_missions", "complete_mission", "get_missions", "accept_mission"],
  mission_check: ["travel_to", "dock", "get_active_missions", "complete_mission", "get_missions", "accept_mission"],
  navigate_and_mine: ["jump_route", "travel_to", "batch_mine", "refuel"],
  craft_and_sell: ["craft", "analyze_market", "get_cargo", "multi_sell", "create_sell_order", "refuel"],
  explore_system: ["jump_route", "survey_system", "scan", "get_system"],
  salvage_loop: ["get_wrecks", "get_cargo", "loot_wreck", "analyze_market", "multi_sell", "refuel"],
  full_trade_run: ["jump_route", "travel_to", "get_cargo", "batch_mine", "dock", "analyze_market", "craft", "multi_sell", "create_sell_order", "refuel"],
  supply_run: ["get_cargo", "analyze_market", "multi_sell", "create_sell_order", "refuel"],
  navigate_home: ["get_status", "jump_route", "refuel", "repair", "get_cargo", "analyze_market", "multi_sell"],
  explore_and_mine: ["get_status", "jump_route", "get_system", "travel_to", "batch_mine", "get_cargo", "dock", "analyze_market", "multi_sell"],
  manage_storage: ["get_status", "get_cargo", "deposit_items", "withdraw_items"],
  upgrade_ship: ["travel_to", "dock", "get_status", "view_market", "install_mod", "browse_ships"],
  fleet_refuel: ["fleet", "get_status", "refuel"],
  fleet_jump: ["fleet", "get_status", "jump_route"],
};

/**
 * Get the list of game tools a routine uses. Returns undefined if the routine
 * is unknown (caller should check hasRoutine() first).
 */
export function getRoutineTools(routineName: string): readonly string[] | undefined {
  return ROUTINE_TOOLS[routineName];
}

/** Get list of available routine names. */
export function getAvailableRoutines(): string[] {
  return Array.from(ROUTINE_REGISTRY.keys());
}

/** Check if a routine exists. */
export function hasRoutine(name: string): boolean {
  return ROUTINE_REGISTRY.has(name);
}

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

export { withRetry } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Default max execution time for a routine (15 minutes). */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Run a named routine with the given params and context.
 *
 * @returns RoutineResult — always returns, never throws.
 */
export async function runRoutine(
  routineName: string,
  rawParams: unknown,
  ctx: RoutineContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RoutineResult> {
  const t0 = Date.now();

  const routine = ROUTINE_REGISTRY.get(routineName);
  if (!routine) {
    return {
      status: "error",
      summary: `Unknown routine: ${routineName}`,
      data: { availableRoutines: getAvailableRoutines() },
      phases: [],
      durationMs: Date.now() - t0,
    };
  }

  // Parse params
  let params: unknown;
  try {
    params = routine.parseParams(rawParams);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Include usage example for common routines to help agents self-correct
    const examples: Record<string, string> = {
      full_trade_run: 'Example: execute_routine(id="full_trade_run", text=\'{"belt":"main_belt","station":"sol_central","cycles":3}\')',
      mining_loop: 'Example: execute_routine(id="mining_loop", text=\'{"belt":"main_belt","cycles":3}\')',
      explore_system: 'Example: execute_routine(id="explore_system", text=\'{"target_system":"sirius"}\')',
      navigate_and_mine: 'Example: execute_routine(id="navigate_and_mine", text=\'{"target_system":"sirius","belt":"iron_reach_mining_colony","station":"sirius_observatory_station","cycles":3}\')',
      supply_run: 'Example: execute_routine(id="supply_run", text=\'{"buy_station":"sol_central","sell_station":"sirius_observatory_station","items":[{"item_id":"steel_plate","quantity":10}]}\')',
      sell_cycle: 'Example: execute_routine(id="sell_cycle", text=\'{"station":"sol_central"}\')',
    };
    const hint = examples[routineName] ? ` ${examples[routineName]}` : "";
    return {
      status: "error",
      summary: `Invalid params for ${routineName}: ${errMsg}.${hint}`,
      data: { rawParams },
      phases: [],
      durationMs: Date.now() - t0,
    };
  }

  log.info("routine started", { agent: ctx.agentName, routine: routineName, params });

  // Execute with timeout
  try {
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const result = await Promise.race([
      routine.run(ctx, params),
      new Promise<RoutineResult>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Routine ${routineName} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    clearTimeout(timeoutHandle!);

    result.durationMs = Date.now() - t0;
    log.info("routine finished", {
      agent: ctx.agentName,
      routine: routineName,
      status: result.status,
      durationMs: result.durationMs,
      summary: result.summary,
    });

    return result;
  } catch (err) {
    const durationMs = Date.now() - t0;
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("routine crashed", { agent: ctx.agentName, routine: routineName, error: errMsg, durationMs });

    return {
      status: "error",
      summary: `Routine ${routineName} failed: ${errMsg}`,
      data: {},
      phases: [],
      durationMs,
    };
  }
}

/**
 * Format a RoutineResult as a text block for LLM consumption.
 */
export function formatRoutineResult(routineName: string, result: RoutineResult): string {
  const lines: string[] = [];

  if (result.status === "handoff") {
    lines.push(`ROUTINE_HANDOFF: ${routineName}`);
    lines.push(`reason: "${result.handoffReason ?? "unknown"}"`);
  } else {
    lines.push(`ROUTINE_RESULT: ${routineName} ${result.status}`);
  }

  lines.push(result.summary);

  if (Object.keys(result.data).length > 0) {
    for (const [k, v] of Object.entries(result.data)) {
      lines.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  }

  lines.push(`duration=${result.durationMs}ms`);

  return lines.join("\n");
}
