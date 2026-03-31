/**
 * explore_system routine — Jump to a system, survey for POIs, scan them, and optionally jump to a next system.
 *
 * State machine:
 *   INIT → JUMP_TARGET → SURVEY → SCAN_POIS → GET_SYSTEM → JUMP_NEXT → DONE
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { withRetry, done, handoff, phase, completePhase, checkCombat } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ExploreSystemParams {
  target_system: string;
  max_pois?: number; // default: 5
  next_system?: string;
}

function parseParams(raw: unknown): ExploreSystemParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { target_system: string }");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.target_system !== "string" || !obj.target_system) {
    throw new Error("target_system is required (string)");
  }
  const params: ExploreSystemParams = { target_system: obj.target_system };
  
  if (obj.max_pois !== undefined) {
    if (typeof obj.max_pois !== "number" || obj.max_pois < 1) {
      throw new Error("max_pois must be a positive number");
    }
    params.max_pois = obj.max_pois;
  }
  
  if (obj.next_system !== undefined) {
    if (typeof obj.next_system !== "string") {
      throw new Error("next_system must be a string");
    }
    params.next_system = obj.next_system;
  }
  
  return params;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: ExploreSystemParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];
  const maxPois = params.max_pois ?? 5;

  // --- Phase 1: Init ---
  const initPhase = phase("init");
  const cached = ctx.statusCache.get(ctx.agentName);
  const player = cached?.data?.player as Record<string, unknown> | undefined;
  const currentSystem = player?.current_system as string | undefined;
  const alreadyInTarget = currentSystem?.includes(params.target_system) ?? false;
  phases.push(completePhase(initPhase, { currentSystem, alreadyInTarget }));

  ctx.log("info", `explore_system: starting in ${currentSystem ?? "unknown"}, target=${params.target_system}`);

  // --- Phase 2: Jump to target system ---
  if (!alreadyInTarget) {
    const jumpPhase = phase("jump_target");
    const jumpResp = await ctx.client.execute("jump_route", { destination: params.target_system });
    if (jumpResp.error) {
      phases.push(completePhase(jumpPhase, { error: JSON.stringify(jumpResp.error) }));
      return handoff(`Jump to ${params.target_system} failed: ${JSON.stringify(jumpResp.error)}`, {}, phases);
    }
    phases.push(completePhase(jumpPhase, jumpResp.result));
    if (checkCombat(jumpResp)) {
      return handoff("Combat detected during jump", {}, phases);
    }
    await ctx.client.waitForTick();
  }

  // --- Phase 3: Survey system ---
  const surveyPhase = phase("survey");
  const surveyResp = await ctx.client.execute("survey_system");
  if (surveyResp.error) {
    phases.push(completePhase(surveyPhase, { error: JSON.stringify(surveyResp.error) }));
    return handoff(`Survey of ${params.target_system} failed: ${JSON.stringify(surveyResp.error)}`, {}, phases);
  }
  const surveyResult = surveyResp.result as Record<string, unknown> | undefined;
  phases.push(completePhase(surveyPhase, surveyResult));

  const pois = (Array.isArray(surveyResult?.pois) ? surveyResult.pois : []) as Array<{ id: string; name?: string }>;
  ctx.log("info", `explore_system: discovered ${pois.length} POIs`);

  // --- Phase 4: Scan POIs ---
  const scanPhase = phase("scan_pois");
  const scannedPois: string[] = [];
  const poisToScan = pois.slice(0, maxPois);
  
  try {
    for (const poi of poisToScan) {
      const poiId = poi.id;
      await withRetry(async () => {
        const scanResp = await ctx.client.execute("scan", { id: poiId });
        if (scanResp.error) {
          ctx.log("warn", `explore_system: scan of ${poiId} failed`, { error: scanResp.error });
          return;
        }
        scannedPois.push(poiId);
        if (checkCombat(scanResp)) {
          throw new Error("combat_detected");
        }
      }, 1);
      
      // Check for combat after each scan via status cache events
      const lastEvents = ctx.statusCache.get(ctx.agentName)?.data?.events as any[];
      if (lastEvents?.some(e => e.type === "battle_started")) {
          phases.push(completePhase(scanPhase, { scanned: scannedPois, aborted: "combat" }));
          return handoff("Combat detected during scanning", { scanned: scannedPois }, phases);
      }

      await ctx.client.waitForTick();
    }
  } catch (err: any) {
    if (err.message === "combat_detected") {
      phases.push(completePhase(scanPhase, { scanned: scannedPois, aborted: "combat" }));
      return handoff("Combat detected during scanning", { scanned: scannedPois }, phases);
    }
    throw err;
  }
  phases.push(completePhase(scanPhase, { scanned: scannedPois }));

  // --- Phase 5: Get full system data ---
  const getSystemPhase = phase("get_system");
  const systemResp = await ctx.client.execute("get_system", { system_id: params.target_system });
  const systemData = systemResp.result;
  phases.push(completePhase(getSystemPhase, systemData));

  // --- Phase 6: Jump to next system (optional) ---
  if (params.next_system) {
    const jumpNextPhase = phase("jump_next");
    const jumpNextResp = await ctx.client.execute("jump_route", { destination: params.next_system });
    if (jumpNextResp.error) {
      phases.push(completePhase(jumpNextPhase, { error: JSON.stringify(jumpNextResp.error) }));
      return handoff(`Jump to next system ${params.next_system} failed: ${JSON.stringify(jumpNextResp.error)}`, { systemData }, phases);
    }
    phases.push(completePhase(jumpNextPhase, jumpNextResp.result));
    if (checkCombat(jumpNextResp)) {
        return handoff(`Jumped to ${params.next_system}, but combat detected`, { systemData }, phases);
    }
    return done(`Explored ${params.target_system} (${scannedPois.length} POIs scanned), jumped to ${params.next_system}`, { systemData, scannedPois }, phases);
  }

  const summary = `Explored ${params.target_system}: discovered ${pois.length} POIs, scanned ${scannedPois.length}`;
  return handoff(summary, { systemData, scannedPois, pois_discovered: pois.length }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const exploreSystemRoutine: RoutineDefinition<ExploreSystemParams> = {
  name: "explore_system",
  description: "Jump to a system, survey POIs, scan them, and optionally jump to next system.",
  parseParams,
  run,
};
