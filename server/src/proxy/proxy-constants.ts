/**
 * Shared proxy constants and utility functions.
 *
 * Extracted from server.ts to break the circular import between server.ts
 * and gantry-v2.ts. Both files can now import from here without cycles.
 */

import { formatForAgent } from "./format-result.js";
import { persistGameState } from "./cache-persistence.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("proxy");

// ---------------------------------------------------------------------------
// STATE_CHANGING_TOOLS
// ---------------------------------------------------------------------------

/** Tools that change game state (used for cache invalidation and tick waits). */
export const STATE_CHANGING_TOOLS = new Set([
  "mine", "travel", "jump", "dock", "undock", "refuel", "repair", "travel_to",
  "sell", "buy", "deposit_items", "withdraw_items", "view_storage",
  "create_sell_order", "create_buy_order", "cancel_order", "modify_order",
  "craft", "accept_mission", "complete_mission", "decline_mission", "abandon_mission",
  "attack", "battle", "loot_wreck", "salvage_wreck", "sell_wreck", "scrap_wreck", "tow_wreck", "release_tow",
  "buy_ship", "sell_ship", "switch_ship", "commission_ship", "claim_commission", "cancel_commission", "supply_commission", "buy_listed_ship", "list_ship_for_sale", "cancel_ship_listing",
  "install_mod", "uninstall_mod", "faction_build", "faction_upgrade", "personal_build",
  "get_insurance_quote", "buy_insurance", "claim_insurance", "reload",
  "trade_offer", "trade_accept", "trade_decline", "trade_cancel",
  "repair_module", "jettison", "distress_signal",
]);

// ---------------------------------------------------------------------------
// MUTATION_COMMANDS
// ---------------------------------------------------------------------------

/** Commands where double-execution has side effects (financial, combat, etc.).
 *  These must NEVER be retried on timeout — the original may have succeeded.
 *  Subset of STATE_CHANGING_TOOLS. Idempotent commands (dock, refuel, mine, travel, jump) are excluded. */
export const MUTATION_COMMANDS = new Set([
  // Financial
  "buy", "sell", "create_sell_order", "create_buy_order", "cancel_order", "modify_order",
  // Combat
  "attack", "loot_wreck", "salvage_wreck", "sell_wreck", "scrap_wreck",
  // Crafting
  "craft",
  // Trade
  "trade_offer", "trade_accept",
  // Ship
  "buy_ship", "sell_ship", "commission_ship", "buy_listed_ship", "list_ship_for_sale",
  // Insurance
  "buy_insurance", "claim_insurance",
  // Inventory
  "deposit_items", "withdraw_items", "jettison",
  // Building
  "faction_build", "faction_upgrade", "personal_build",
]);

// ---------------------------------------------------------------------------
// CONTAMINATION_WORDS
// ---------------------------------------------------------------------------

/** Words that indicate contaminated captain's log entries (hallucinated infrastructure failures).
 *
 * These are organized by hallucination pattern:
 * 1. System/infrastructure (backend, queue, deadlock, async, lock)
 * 2. State contamination (frozen, stuck, corrupted, pending)
 * 3. Admin narrative (admin reset, await admin, discipline holds)
 * 4. Navigation/cache (navigation frozen, location locked, state sync)
 * 5. Consequence framing (zero ore, doesn't execute, all pending) — hallucinated outcomes
 * 6. Speculative language (mysterious, unexplained, cryptic, i suspect) — hallucination-specific phrases; common hedging removed
 * 7. Conspiracy patterns (intentional, sabotage, deliberately) — agents blaming external forces
 * 8. Temporal/infinite patterns (endless, infinite, perpetual, nonstop, eternal) — hallucinated ongoing failures
 */
export const CONTAMINATION_WORDS = [
  // ───────────── Core System/Infrastructure (proven false) ─────────────
  "action_pending", "backend", "queue lock", "admin reset",
  "frozen", "unresponsive", "degraded", "corrupted", "paralyzed",
  "queue", "async", "pending lock", "tick batch", "deadlock",
  "tick pending", "tick recovery", "admin state", "await admin",
  "tools blocked", "tools queued", "all pending",
  "halting", "await reset", "lock persists",

  // ───────────── State/Cache Contamination ─────────────
  "cache corrupt", "cache stuck", "cache frozen", "cache failure",
  "position data", "state change", "location unchanged", "location frozen",
  "location locked", "location stuck", "state frozen", "state locked",
  "state sync", "server-side", "sessions of", "shifts of",
  "sync", // Hallucination indicator (whitelisted for system name "Sync" in contamination check)

  // ───────────── Navigation/Movement Hallucination ─────────────
  "navigation frozen", "navigation broken", "don't execute", "doesn't execute",
  "game state", "fleet holds", "discipline holds", "fleet discipline",

  // ───────────── Speculative/Hedging Language (precursors to hallucination) ─────────────
  // Agents use these phrases BEFORE inventing false backend states
  "mysterious", "unexplained", "cryptic",
  "i suspect",

  // ───────────── Conspiracy/Sabotage Patterns ─────────────
  // Agents sometimes frame failures as intentional attacks
  "intentional", "deliberately", "sabotage", "conspiracy",
  "targeted", "on purpose", "engineered failure",

  // ───────────── Temporal/Infinite Patterns ─────────────
  // Hallucinated ongoing failures that don't match game reality (one-off issues OK, perpetual ones fabricated)
  "endless", "infinite", "perpetual", "nonstop", "eternal", "constant",
  "continuous failure", "keeps failing", "never stops",
];

// ---------------------------------------------------------------------------
// stripPendingFields
// ---------------------------------------------------------------------------

/** Strip pending fields from a game response after tick resolution.
 *  The game server returns {pending: true, message: "...pending..."} for async actions.
 *  After waitForTick() resolves, the action has completed — strip these so agents don't panic. */
export function stripPendingFields(result: unknown): void {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if ("pending" in obj && obj.pending === true) {
      delete obj.pending;
      if (typeof obj.message === "string" && obj.message.includes("pending")) {
        obj.message = `${obj.command ?? "action"} completed`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// GameStatePersister
// ---------------------------------------------------------------------------

const PERSIST_THROTTLE_MS = 30_000;

/**
 * GameStatePersister — Throttles game state persistence (every 30s per agent max).
 * Each instance maintains its own throttle state.
 */
export class GameStatePersister {
  private lastPersistTime = new Map<string, number>();

  persist(agentName: string, state: { data: Record<string, unknown>; fetchedAt: number }): void {
    const now = Date.now();
    const last = this.lastPersistTime.get(agentName) ?? 0;
    if (now - last >= PERSIST_THROTTLE_MS) {
      this.lastPersistTime.set(agentName, now);
      persistGameState(agentName, state);
    }
  }
}

// Default instance for backward compatibility
const defaultPersister = new GameStatePersister();

/**
 * @deprecated Use GameStatePersister instance directly.
 */
export function throttledPersistGameState(agentName: string, state: { data: Record<string, unknown>; fetchedAt: number }): void {
  defaultPersister.persist(agentName, state);
}

// ---------------------------------------------------------------------------
// reformatResponse
// ---------------------------------------------------------------------------

/** Reformat a JSON text response for the agent's preferred format. Returns original on parse failure. */
export function reformatResponse(
  text: string,
  agentFormat: "json" | "yaml",
  label: string,
): string {
  if (agentFormat === "json") return text;
  try {
    const parsed = JSON.parse(text);
    const yamlText = formatForAgent(parsed, "yaml");
    log.info(`[yaml] ${label}: ${text.length}→${yamlText.length} (${Math.round((1 - yamlText.length / text.length) * 100)}% saved)`);
    return yamlText;
  } catch {
    return text;
  }
}
