/**
 * manage_storage routine — Manage cargo and station storage: deposit surplus items
 * or withdraw needed items. Must be docked at a station.
 *
 * State machine:
 *   INIT → CHECK_CARGO → CHECK_STORAGE → DEPOSIT/WITHDRAW → DONE
 *
 * Handoff triggers:
 *   - Not docked at a station
 *   - Storage errors
 */

import type { RoutineContext, RoutineDefinition, RoutinePhase, RoutineResult } from "./types.js";
import { done, handoff, phase, completePhase } from "./routine-utils.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ManageStorageParams {
  action: "deposit" | "withdraw" | "deposit_all";
  items?: string[];  // item IDs to deposit/withdraw (required for deposit/withdraw)
}

function parseParams(raw: unknown): ManageStorageParams {
  if (!raw || typeof raw !== "object") {
    throw new Error("params must be an object with { action: 'deposit' | 'withdraw' | 'deposit_all' }");
  }
  const obj = raw as Record<string, unknown>;
  const action = obj.action as string;
  if (!["deposit", "withdraw", "deposit_all"].includes(action)) {
    throw new Error("action must be 'deposit', 'withdraw', or 'deposit_all'");
  }
  if ((action === "deposit" || action === "withdraw") && !Array.isArray(obj.items)) {
    throw new Error("items array is required for deposit/withdraw actions");
  }
  return {
    action: action as ManageStorageParams["action"],
    items: Array.isArray(obj.items) ? obj.items.map(String) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function run(ctx: RoutineContext, params: ManageStorageParams): Promise<RoutineResult> {
  const phases: RoutinePhase[] = [];

  // --- Phase 1: Init — verify docked ---
  const initPhase = phase("init");
  const statusResp = await ctx.client.execute("get_status");
  const status = statusResp.result as Record<string, unknown> | undefined;
  const player = status?.player as Record<string, unknown> | undefined;
  const dockedAt = player?.docked_at_base as string | undefined;

  if (!dockedAt) {
    phases.push(completePhase(initPhase, { docked: false }));
    return handoff("Must be docked at a station to manage storage", {}, phases);
  }
  phases.push(completePhase(initPhase, { docked: true, station: dockedAt }));
  ctx.log("info", `manage_storage: docked at ${dockedAt}, action=${params.action}`);

  // --- Phase 2: Get cargo ---
  const cargoPhase = phase("get_cargo");
  const cargoResp = await ctx.client.execute("get_cargo");
  if (cargoResp.error) {
    phases.push(completePhase(cargoPhase, { error: cargoResp.error }));
    return handoff("Could not get cargo", { error: cargoResp.error }, phases);
  }
  const cargo = cargoResp.result as Record<string, unknown>;
  const cargoItems = (cargo?.cargo || cargo?.items || []) as Array<Record<string, unknown>>;
  phases.push(completePhase(cargoPhase, { itemCount: cargoItems.length }));

  // --- Phase 3: Execute action ---
  let deposited = 0;
  let withdrawn = 0;

  if (params.action === "deposit_all") {
    // Deposit everything in cargo
    const depositPhase = phase("deposit_all");
    for (const item of cargoItems) {
      const itemId = String(item.id || item.item_id || "");
      if (!itemId) continue;
      const resp = await ctx.client.execute("deposit_items", { id: itemId });
      if (!resp.error) {
        deposited++;
      } else {
        ctx.log("warn", `manage_storage: failed to deposit ${itemId}`, { error: resp.error });
      }
    }
    phases.push(completePhase(depositPhase, { deposited }));
    ctx.log("info", `manage_storage: deposited ${deposited}/${cargoItems.length} items`);

  } else if (params.action === "deposit" && params.items) {
    const depositPhase = phase("deposit");
    for (const itemId of params.items) {
      const resp = await ctx.client.execute("deposit_items", { id: itemId });
      if (!resp.error) {
        deposited++;
      } else {
        ctx.log("warn", `manage_storage: failed to deposit ${itemId}`, { error: resp.error });
      }
    }
    phases.push(completePhase(depositPhase, { deposited, requested: params.items.length }));
    ctx.log("info", `manage_storage: deposited ${deposited}/${params.items.length} items`);

  } else if (params.action === "withdraw" && params.items) {
    const withdrawPhase = phase("withdraw");
    for (const itemId of params.items) {
      const resp = await ctx.client.execute("withdraw_items", { id: itemId });
      if (!resp.error) {
        withdrawn++;
      } else {
        ctx.log("warn", `manage_storage: failed to withdraw ${itemId}`, { error: resp.error });
      }
    }
    phases.push(completePhase(withdrawPhase, { withdrawn, requested: params.items.length }));
    ctx.log("info", `manage_storage: withdrew ${withdrawn}/${params.items.length} items`);
  }

  const summaryParts: string[] = [];
  if (deposited > 0) summaryParts.push(`deposited ${deposited} items`);
  if (withdrawn > 0) summaryParts.push(`withdrew ${withdrawn} items`);
  if (summaryParts.length === 0) summaryParts.push("no items transferred");

  const summary = `Storage at ${dockedAt}: ${summaryParts.join(", ")}`;
  return done(summary, {
    station: dockedAt,
    action: params.action,
    deposited,
    withdrawn,
  }, phases);
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const manageStorageRoutine: RoutineDefinition<ManageStorageParams> = {
  name: "manage_storage",
  description: "Manage station storage: deposit cargo items or withdraw from storage. Must be docked.",
  parseParams,
  run,
};
