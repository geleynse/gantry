/**
 * compound-tools-impl.ts
 *
 * Re-export shim for backward compatibility.
 * The canonical implementations now live in compound-tools/ (one file per tool).
 *
 * This file preserves the original import path for any consumers that still
 * reference "./compound-tools-impl.js" directly.
 */

export type {
  GameClientLike,
  CompoundToolDeps,
  BattleStateForCache,
  MultiSellItem,
  CompoundResult,
} from "./compound-tools/index.js";

export {
  MAX_BATTLE_TICKS,
  BATTLE_INIT_MAX_TICKS,
  stripPendingFields,
  waitForNavCacheUpdate,
  waitForDockCacheUpdate,
  findTargets,
  batchMine,
  travelTo,
  jumpRoute,
  multiSell,
  scanAndAttack,
  battleReadiness,
  lootWrecks,
  flee,
} from "./compound-tools/index.js";
