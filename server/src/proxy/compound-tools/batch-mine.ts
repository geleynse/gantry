/**
 * compound-tools/batch-mine.ts
 *
 * Implementation of the batch_mine compound tool.
 * Mines multiple times in sequence, aggregating results and stopping when cargo is full.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { stripPendingFields } from "./utils.js";
import { getSessionShutdownManager } from "../session-shutdown.js";

const log = createLogger("compound-tools");

/**
 * Mine count times, aggregating results. Stops on error or when cargo is full.
 * After each mine that returns pending, waits for the next tick.
 * Checks cargo every 5 mines.
 */
export async function batchMine(
  deps: CompoundToolDeps,
  count: number,
): Promise<CompoundResult> {
  const { client, agentName, statusCache } = deps;

  const cachedStatus = statusCache.get(agentName);
  const playerData = cachedStatus?.data?.player as Record<string, unknown> | undefined;

  // Prerequisite: Must be UNDOCKED to mine
  if (playerData?.docked_at_base) {
    log.warn("batch_mine blocked: docked", { agent: agentName });
    return {
      error: "You are docked. Use undock() or travel_to(destination, should_dock=false) before mining.",
    };
  }

  const clampedCount = Math.min(Math.max(count, 1), 50);

  const results: unknown[] = [];
  let stoppedReason: string | undefined;
  let lastError: Record<string, unknown> | undefined;
  let emptyMineCount = 0; // Track consecutive empty-yield mines for depletion detection

  const shutdownManager = getSessionShutdownManager();

  for (let i = 0; i < clampedCount; i++) {
    // Check for shutdown signal
    if (shutdownManager.isShuttingDown(agentName)) {
      stoppedReason = "shutdown_signal";
      break;
    }

    const resp = await client.execute("mine", undefined, { noRetry: true });

    if (resp.error) {
      lastError = resp.error as Record<string, unknown>;
      // Depletion-specific error codes — stop cleanly rather than reporting an error
      const errorCode = String(lastError.code ?? lastError.message ?? "").toLowerCase();
      const isDepletion =
        errorCode.includes("depleted") ||
        errorCode.includes("no_resource") ||
        errorCode.includes("nothing_to_mine") ||
        errorCode.includes("nothing to mine") ||
        errorCode.includes("belt_empty") ||
        errorCode.includes("asteroid_depleted") ||
        errorCode.includes("no_ore") ||
        errorCode === "no_target";
      if (isDepletion) {
        stoppedReason = "depleted";
        break;
      }
      if (results.length === 0) return { error: resp.error };
      stoppedReason = "error";
      break;
    }

    // Detect explicit silent depletion: mine succeeded but game explicitly said
    // no ore was extracted (e.g. result has ore/amount=0 or a depleted flag).
    // An empty {} result is ambiguous and NOT treated as depletion.
    const mineResult = resp.result as Record<string, unknown> | null | undefined;
    const explicitEmptyYield =
      mineResult &&
      typeof mineResult === "object" &&
      Object.keys(mineResult).length > 0 && // ignore empty {} (ambiguous)
      !mineResult.pending && // ignore pending results
      // Game explicitly returned amount/ore/yield of 0 or null
      ((typeof mineResult.amount === "number" && mineResult.amount === 0) ||
       (typeof mineResult.ore === "number" && mineResult.ore === 0) ||
       mineResult.depleted === true ||
       mineResult.exhausted === true);
    if (explicitEmptyYield) {
      emptyMineCount++;
      if (emptyMineCount >= 3) {
        stoppedReason = "depleted";
        break;
      }
    } else {
      emptyMineCount = 0;
    }

    results.push(resp.result);

    // Wait for tick if mine returned pending, then strip pending fields
    if (
      resp.result &&
      typeof resp.result === "object" &&
      "pending" in (resp.result as Record<string, unknown>)
    ) {
      await client.waitForTick();
      stripPendingFields(resp.result);
    }

    // Check cargo every 5 mines to see if full
    if ((i + 1) % 5 === 0 && i < clampedCount - 1) {
      const cached = statusCache.get(agentName);
      const ship = cached
        ? (cached.data.ship as Record<string, unknown> | undefined)
        : undefined;
      if (
        ship &&
        typeof ship.cargo_used === "number" &&
        ship.cargo_used >= (ship.cargo_capacity as number)
      ) {
        stoppedReason = "cargo_full";
        break;
      }
    }
  }

  // Get final cargo state (free query)
  const finalCargo = await client.execute("get_cargo");

  return {
    status: "completed",
    mined: results,
    mines_completed: results.length,
    cargo_after: finalCargo.result,
    ...(stoppedReason && { stopped_reason: stoppedReason }),
    ...(lastError && { last_error: lastError }),
  };
}
