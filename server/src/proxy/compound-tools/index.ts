/**
 * compound-tools/index.ts
 *
 * Barrel export for all compound tool implementations.
 * Consumers import from "./compound-tools" and get all public APIs.
 */

// Types
export type {
  GameClientLike,
  CompoundToolDeps,
  BattleStateForCache,
  MultiSellItem,
  CompoundResult,
} from "./types.js";

// Shared utilities
export {
  MAX_BATTLE_TICKS,
  BATTLE_INIT_MAX_TICKS,
  stripPendingFields,
  waitForNavCacheUpdate,
  waitForDockCacheUpdate,
  findTargets,
  isAmmoItem,
  extractWrecks,
} from "./utils.js";

// Tool implementations
export { batchMine } from "./batch-mine.js";
export { travelTo } from "./travel-to.js";
export { jumpRoute } from "./jump-route.js";
export { multiSell } from "./multi-sell.js";
export { scanAndAttack } from "./scan-and-attack.js";
export { battleReadiness } from "./battle-readiness.js";
export { lootWrecks } from "./loot-wrecks.js";
export { flee } from "./flee.js";
export { getCraftProfitability } from "./craft-profitability.js";
export { craftPathTo } from "./craft-path.js";

// Descriptions and name set for UI display
export { COMPOUND_TOOL_DESCRIPTIONS, COMPOUND_TOOL_NAMES } from "./descriptions.js";
