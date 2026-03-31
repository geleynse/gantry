/**
 * compound-tools/loot-wrecks.ts
 *
 * Implementation of the loot_wrecks compound tool.
 * Scans for wrecks and salvages up to maxWrecks of them.
 */

import { createLogger } from "../../lib/logger.js";
import type { CompoundToolDeps, CompoundResult } from "./types.js";
import { stripPendingFields, extractWrecks } from "./utils.js";

const log = createLogger("compound-tools");

/**
 * Scan for wrecks and salvage up to maxWrecks of them.
 * Returns per-wreck loot results and final cargo state.
 */
export async function lootWrecks(
  deps: CompoundToolDeps,
  count = 5,
): Promise<CompoundResult> {
  const { client, agentName } = deps;
  const maxWrecks = Math.min(count, 10);

  // Step 1: get_wrecks
  const wrecksResp = await client.execute("get_wrecks");
  if (wrecksResp.error) return { error: wrecksResp.error };

  const wrecks = extractWrecks(wrecksResp.result);

  if (wrecks.length === 0) {
    return { status: "no_wrecks", wrecks_found: 0 };
  }

  // Step 2: salvage up to maxWrecks
  const results: Array<{
    wreck_id: string;
    status: string;
    loot?: unknown;
    error?: unknown;
  }> = [];
  const toSalvage = wrecks.slice(0, maxWrecks);
  log.info("loot_wrecks START", {
    agent: agentName,
    total_found: wrecks.length,
    salvaging: toSalvage.length,
  });

  for (const wreck of toSalvage) {
    const wreckId = String(wreck.id ?? wreck.wreck_id ?? "");
    if (!wreckId) continue;

    const salvageResp = await client.execute("salvage_wreck", {
      wreck_id: wreckId,
    });
    if (salvageResp.error) {
      results.push({ wreck_id: wreckId, status: "failed", error: salvageResp.error });
    } else {
      if (
        salvageResp.result &&
        typeof salvageResp.result === "object" &&
        "pending" in (salvageResp.result as Record<string, unknown>)
      ) {
        await client.waitForTick();
        stripPendingFields(salvageResp.result);
      }
      results.push({ wreck_id: wreckId, status: "looted", loot: salvageResp.result });
    }
  }

  // Step 3: final cargo check
  const finalCargo = await client.execute("get_cargo");

  return {
    status: "completed",
    wrecks_found: wrecks.length,
    wrecks_salvaged: results.length,
    results,
    cargo_after: finalCargo.result,
    ...(wrecks.length > maxWrecks && {
      remaining_wrecks: wrecks.length - maxWrecks,
    }),
  };
}
