/**
 * upgrade_ship routine — Evaluate current ship modules and install upgrades
 * available at the current station.
 *
 * State machine:
 *   INIT → [TRAVEL → DOCK] → SURVEY → EVALUATE → UPGRADE → SHIP_CHECK → DONE
 *
 * The routine never auto-buys a new ship — it flags recommendations only.
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase, travelAndDock } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UpgradeShipParams {
  /** Travel to this station first (optional — skip if already docked). */
  station?: string;
  /** Max credits to spend (default: 50% of current credits). */
  budget?: number;
  /** Module types to prioritize, e.g. ["weapon", "shield", "cargo", "engine"]. */
  priorities?: string[];
  /** Item IDs to never buy. */
  blacklist?: string[];
}

function parseParams(raw: unknown): UpgradeShipParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const station = typeof obj.station === "string" && obj.station ? obj.station : undefined;

  let budget: number | undefined;
  if (obj.budget !== undefined) {
    if (typeof obj.budget !== "number" || obj.budget < 0) {
      throw new Error("budget must be a non-negative number");
    }
    budget = obj.budget;
  }

  let priorities: string[] = [];
  if (obj.priorities !== undefined) {
    if (!Array.isArray(obj.priorities) || obj.priorities.some((p) => typeof p !== "string")) {
      throw new Error("priorities must be an array of strings");
    }
    priorities = obj.priorities as string[];
  }

  let blacklist: string[] = [];
  if (obj.blacklist !== undefined) {
    if (!Array.isArray(obj.blacklist) || obj.blacklist.some((b) => typeof b !== "string")) {
      throw new Error("blacklist must be an array of strings");
    }
    blacklist = obj.blacklist as string[];
  }

  return { station, budget, priorities, blacklist };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreModule(mod: { tier?: number; type?: string }, priorities: string[]): number {
  const tierScore = (mod.tier ?? 0) * 10;
  const priorityIdx = priorities.indexOf(mod.type ?? "");
  const priorityScore = priorityIdx >= 0 ? (priorities.length - priorityIdx) * 5 : 0;
  return tierScore + priorityScore;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, rawParams: UpgradeShipParams): Promise<RoutineResult> {
  // Normalize optional boolean-like defaults
  const params: Required<UpgradeShipParams> = {
    station: rawParams.station ?? "",
    budget: rawParams.budget ?? -1, // -1 = compute from credits
    priorities: rawParams.priorities ?? [],
    blacklist: rawParams.blacklist ?? [],
  };

  const phases: RoutinePhase[] = [];

  // --- Phase INIT: Read status cache ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const cachedShip = cached?.data?.ship as Record<string, unknown> | undefined;

  const currentPoi = player?.current_poi as string | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;
  const cachedCredits = typeof player?.credits === "number" ? player.credits : undefined;

  const targetStation = params.station;
  const alreadyAtStation = targetStation
    ? (currentPoi?.includes(targetStation) ?? false)
    : true; // no station specified — assume we stay where we are
  const alreadyDocked = !!dockedAt && (targetStation ? alreadyAtStation : true);

  phases.push(completePhase(initPhase, { currentPoi, dockedAt, alreadyAtStation, alreadyDocked }));
  ctx.log("info", `upgrade_ship: starting at ${currentPoi ?? "unknown"}, docked=${alreadyDocked}, target=${targetStation || "(current)"}`);

  // If not docked and no station specified, can't proceed
  if (!alreadyDocked && !targetStation) {
    return handoff(
      "Not docked at a station and no station provided — cannot survey market",
      { currentPoi },
      phases,
    );
  }

  // --- Phase TRAVEL + DOCK ---
  if (!alreadyDocked || (!alreadyAtStation && targetStation)) {
    const tdResult = await travelAndDock(ctx, targetStation || currentPoi || "", {
      alreadyAtStation,
      alreadyDocked,
      label: "upgrade_ship",
    });
    phases.push(...tdResult.phases);
    if (tdResult.failed) {
      return handoff(tdResult.failed, { station: targetStation }, phases);
    }
  }

  // --- Phase SURVEY: Get current status + market ---
  const statusResp = await ctx.client.execute("get_status");
  const statusResult = statusResp.result as Record<string, unknown> | undefined;
  const ship = (statusResult?.ship ?? cachedShip) as Record<string, unknown> | undefined;
  const credits =
    typeof (statusResult?.player as Record<string, unknown>)?.credits === "number"
      ? (statusResult!.player as Record<string, unknown>).credits as number
      : cachedCredits ?? 0;

  // Resolve budget: explicit param wins, otherwise 50% of current credits
  const effectiveBudget = params.budget >= 0 ? params.budget : Math.floor(credits * 0.5);

  // Current modules: array of { id, type, tier, ... }
  const currentModules = Array.isArray(ship?.modules)
    ? (ship!.modules as Array<Record<string, unknown>>)
    : [];

  const surveyPhase = phase("survey");
  const marketResp = await ctx.client.execute("view_market");
  const marketResult = marketResp.result as Record<string, unknown> | undefined;

  // Market modules: try common shapes — items/modules/equipment arrays
  let marketItems: Array<Record<string, unknown>> = [];
  for (const key of ["modules", "equipment", "items"]) {
    if (Array.isArray((marketResult as Record<string, unknown> | undefined)?.[key])) {
      marketItems = (marketResult as Record<string, unknown>)[key] as Array<Record<string, unknown>>;
      break;
    }
  }
  // Also check nested market.modules or market.items
  if (marketItems.length === 0) {
    const nested = (marketResult as Record<string, unknown> | undefined)?.market as Record<string, unknown> | undefined;
    for (const key of ["modules", "equipment", "items"]) {
      if (Array.isArray(nested?.[key])) {
        marketItems = nested![key] as Array<Record<string, unknown>>;
        break;
      }
    }
  }

  phases.push(completePhase(surveyPhase, { marketItemCount: marketItems.length, credits, effectiveBudget }));
  ctx.log("info", `upgrade_ship: ${marketItems.length} items on market, budget=${effectiveBudget}, credits=${credits}`);

  // --- Phase EVALUATE: Score upgrades ---
  const evaluatePhase = phase("evaluate");

  // Build current module tier map by type
  const currentTierByType = new Map<string, number>();
  for (const mod of currentModules) {
    const modType = typeof mod.type === "string" ? mod.type : "";
    const modTier = typeof mod.tier === "number" ? mod.tier : 0;
    const existing = currentTierByType.get(modType) ?? -1;
    if (modTier > existing) currentTierByType.set(modType, modTier);
  }

  // Filter to purchasable upgrades
  interface Candidate {
    id: string;
    type: string;
    tier: number;
    price: number;
    score: number;
    name: string;
  }

  const candidates: Candidate[] = [];
  for (const item of marketItems) {
    const id = typeof item.id === "string" ? item.id : (typeof item.item_id === "string" ? item.item_id : "");
    if (!id) continue;

    // Skip blacklisted
    if (params.blacklist.includes(id)) continue;

    const itemType = typeof item.type === "string" ? item.type : (typeof item.category === "string" ? item.category : "");
    const itemTier = typeof item.tier === "number" ? item.tier : 0;
    const price = typeof item.price === "number" ? item.price : (typeof item.cost === "number" ? item.cost : 0);
    const name = typeof item.name === "string" ? item.name : id;

    // Must be an upgrade over current tier for same type
    const currentTier = currentTierByType.get(itemType) ?? -1;
    if (itemTier <= currentTier) continue;

    // Must be affordable
    if (price > effectiveBudget) continue;

    const score = scoreModule({ tier: itemTier, type: itemType }, params.priorities);
    candidates.push({ id, type: itemType, tier: itemTier, price, score, name });
  }

  // Sort best first
  candidates.sort((a, b) => b.score - a.score);

  phases.push(completePhase(evaluatePhase, { candidateCount: candidates.length, candidates: candidates.slice(0, 5) }));
  ctx.log("info", `upgrade_ship: ${candidates.length} upgrade candidates found`);

  // --- Phase UPGRADE: Install upgrades (skip loop if no candidates) ---
  const upgradePhase = phase("upgrade");
  let remainingBudget = effectiveBudget;
  let creditsSpent = 0;
  const upgradedModules: Array<{ id: string; name: string; type: string; tier: number; price: number }> = [];

  for (const candidate of candidates) {
    // Recheck budget (prices may vary, be conservative)
    if (candidate.price > remainingBudget) continue;

    const installResp = await ctx.client.execute("install_mod", { item_id: candidate.id });
    if (installResp.error) {
      ctx.log("warn", `upgrade_ship: install_mod failed for ${candidate.id}: ${JSON.stringify(installResp.error)}`);
      continue;
    }

    upgradedModules.push(candidate);
    creditsSpent += candidate.price;
    remainingBudget -= candidate.price;

    // Update tier tracking so we don't try to install two mods of same type
    currentTierByType.set(candidate.type, candidate.tier);
    ctx.log("info", `upgrade_ship: installed ${candidate.name} (tier ${candidate.tier}, ${candidate.price} cr)`);

    await ctx.client.waitForTick();
  }

  phases.push(completePhase(upgradePhase, { upgradedCount: upgradedModules.length, creditsSpent, upgrades: upgradedModules }));

  // --- Phase SHIP_CHECK: Check for better ship (recommend only, never buy) ---
  const shipCheckPhase = phase("ship_check");
  let shipRecommendation: Record<string, unknown> | undefined;

  const shipsResp = await ctx.client.execute("browse_ships");
  const shipsResult = shipsResp.result as Record<string, unknown> | undefined;
  const availableShips = Array.isArray(shipsResult?.ships)
    ? (shipsResult!.ships as Array<Record<string, unknown>>)
    : Array.isArray(shipsResult?.listings)
      ? (shipsResult!.listings as Array<Record<string, unknown>>)
      : (Array.isArray(shipsResult) ? (shipsResult as unknown as Array<Record<string, unknown>>) : []);

  const currentHull = typeof ship?.hull_max === "number" ? ship.hull_max : 0;
  const currentSlots = typeof ship?.module_slots === "number" ? ship.module_slots : currentModules.length;

  for (const candidate of availableShips) {
    const shipId = typeof candidate.id === "string" ? candidate.id : "";
    const shipName = typeof candidate.name === "string" ? candidate.name : shipId;
    const shipPrice = typeof candidate.price === "number" ? candidate.price : (typeof candidate.cost === "number" ? candidate.cost : 0);
    const shipHull = typeof candidate.hull_max === "number" ? candidate.hull_max : 0;
    const shipSlots = typeof candidate.module_slots === "number" ? candidate.module_slots : 0;

    const betterHull = shipHull > currentHull;
    const betterSlots = shipSlots > currentSlots;
    const affordable = shipPrice > 0 && shipPrice <= credits - creditsSpent;

    if ((betterHull || betterSlots) && affordable) {
      shipRecommendation = {
        id: shipId,
        name: shipName,
        price: shipPrice,
        hull_max: shipHull,
        module_slots: shipSlots,
        reason: betterHull && betterSlots
          ? `Better hull (${shipHull} vs ${currentHull}) and more module slots (${shipSlots} vs ${currentSlots})`
          : betterHull
          ? `Better hull (${shipHull} vs ${currentHull})`
          : `More module slots (${shipSlots} vs ${currentSlots})`,
      };
      break; // Only recommend the first viable candidate
    }
  }

  phases.push(completePhase(shipCheckPhase, { shipsAvailable: availableShips.length, shipRecommendation }));

  // --- Build summary ---
  const parts: string[] = [];
  if (upgradedModules.length > 0) {
    parts.push(`Installed ${upgradedModules.length} module(s): ${upgradedModules.map((m) => m.name).join(", ")}`);
    parts.push(`Spent ${creditsSpent} credits`);
  } else if (candidates.length === 0) {
    parts.push("No upgrades available or affordable at current station");
  } else {
    parts.push("No modules installed");
  }
  if (shipRecommendation) {
    parts.push(`Ship recommendation: ${shipRecommendation.name} — ${shipRecommendation.reason}`);
  }

  const summary = parts.join(". ");
  ctx.log("info", `upgrade_ship: ${summary}`);

  return done(summary, {
    modules_upgraded: upgradedModules.length,
    credits_spent: creditsSpent,
    credits_remaining: credits - creditsSpent,
    upgrades: upgradedModules,
    ship_recommendation: shipRecommendation ?? null,
    budget_used: effectiveBudget,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const upgradeShipRoutine: RoutineDefinition<UpgradeShipParams> = {
  name: "upgrade_ship",
  description: "Evaluate current ship modules and install upgrades available at the current station. Recommends better ships but does not auto-buy.",
  parseParams,
  run,
};
