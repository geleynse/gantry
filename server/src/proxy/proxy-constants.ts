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
  "attack", "battle", "loot_wreck", "sell_wreck", "scrap_wreck", "tow_wreck", "release_tow",
  "buy_ship", "switch_ship", "commission_ship", "cancel_commission", "supply_commission", "buy_listed_ship", "list_ship_for_sale", "cancel_ship_listing",
  "install_mod", "uninstall_mod", "faction_build", "faction_upgrade", "personal_build",
  "get_insurance_quote", "buy_insurance", "claim_insurance", "reload",
  "trade_offer", "trade_accept", "trade_decline", "trade_cancel",
  "repair_module", "jettison", "distress_signal",
  // v0.327 Recycling Processor — not yet in live game action enum (verified absent 2026-05-30),
  // pre-declared so passthrough routes it the moment the game publishes it.
  "configure_recycler",
  // Passenger loop (v0.354.0+) — boarding/dropping passengers changes ship
  // manifest state; must go through the cache-refresh path like other
  // state-changing tools. See compound-tools/passenger-run.ts.
  "load_passenger", "unload_passenger",
]);

// ---------------------------------------------------------------------------
// isStateChangingCall
// ---------------------------------------------------------------------------

/**
 * Determine whether a specific `craft` CALL is state-changing, given its args.
 *
 * Per the live game spec (game.spacemolt.com/api/openapi.json, /craft):
 * - `job_id`/`job_ids` (or `action: "cancel"`) cancel a queued job and REFUND
 *   its escrowed inputs/labor/fees — this mutates state and must still wait,
 *   even if the caller also (incorrectly) sets `dry_run: true`. Checked FIRST
 *   so a cancel can never be misread as a quote.
 * - `jobs: [...]` (bulk craft) is checked next, ahead of `dry_run`, because
 *   the spec states twice that dry_run is "Not supported with bulk jobs" — a
 *   caller sending both gets a real bulk queue (up to 50 jobs), not a quote.
 * - `dry_run: true` (single-recipe only, per above) returns a cost/time quote
 *   "without queuing or spending anything" — a read.
 * - Calling craft with `action: "queue"` (or no recipe_id/jobs at all) lists
 *   currently queued jobs — also a read ("call craft with no recipe
 *   (action=queue) to list your queued jobs"). NOTE: `action: "queue"` is
 *   dead on both real call surfaces — v1's schema strips `action` entirely
 *   (see TOOL_SCHEMAS.craft in tool-registry.ts, which is v1-only and has no
 *   dry_run/action/job_id/jobs field either, so this whole function is a
 *   no-op for v1 callers), and on v2 `action` is the dispatch key itself
 *   (gantry-v2.ts:728-731,1382-1395), so a real v2 craft call always arrives
 *   with `action: "craft"`, never `"queue"`. Retained only in case a direct
 *   passthrough caller sends it; the line below is what actually decides the
 *   bare-queue-listing case on v2.
 * - Anything else that names a recipe (single `recipe_id` or bulk `jobs`)
 *   queues a real craft job — state-changing.
 *
 * Game v0.433.0 / v0.441.10 made the read paths above instant (no tick
 * consumed), but STATE_CHANGING_TOOLS is a flat tool-name set with no access
 * to call arguments, so a plain `.has("craft")` can't tell a quote/listing
 * apart from a real craft. This function is the args-aware check the few
 * `.has()` call sites should use instead for "craft" specifically.
 */
function isCraftStateChanging(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false; // bare `craft` call — queue listing
  // Cancellation refunds escrow — mutates. Checked before `dry_run` and
  // `jobs` so `{action:"cancel", dry_run:true}` can't be misclassified as a
  // read. `job_id`/`job_ids` use `!= null` (not truthiness) so an explicit
  // `job_id: ""` is still treated as a cancel-intent call, per the spec
  // typing job_id as a plain string.
  if (args.action === "cancel" || args.job_id != null || args.job_ids != null) return true;
  if (args.jobs) return true; // bulk jobs — dry_run is NOT supported for bulk craft; always a real queue
  if (args.dry_run === true) return false; // cost/time quote — no queuing or spending
  if (args.action === "queue") return false; // explicit queue listing — dead branch, see doc comment above
  if (!args.recipe_id && !args.jobs) return false; // no recipe named — bare queue listing
  return true;
}

/**
 * Whether a tool CALL (name + args) is state-changing. For every tool except
 * `craft` this is exactly `stateChangingTools.has(toolName)`. `craft` is
 * special-cased via {@link isCraftStateChanging} — see that function for why.
 *
 * Takes the tool set as a parameter (defaulting to the module-level
 * STATE_CHANGING_TOOLS) rather than reading the global directly, so callers
 * that inject a custom/test set still get correct craft behavior against
 * *their* set.
 */
export function isStateChangingCall(
  toolName: string,
  args: Record<string, unknown> | undefined,
  stateChangingTools: Set<string> = STATE_CHANGING_TOOLS,
): boolean {
  if (!stateChangingTools.has(toolName)) return false;
  if (toolName === "craft") return isCraftStateChanging(args);
  return true;
}

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
  "attack", "loot_wreck", "sell_wreck", "scrap_wreck",
  // Crafting
  "craft",
  // Trade
  "trade_offer", "trade_accept",
  // Ship
  "buy_ship", "commission_ship", "buy_listed_ship", "list_ship_for_sale",
  // Insurance
  "buy_insurance", "claim_insurance",
  // Inventory
  "deposit_items", "withdraw_items", "jettison",
  // Building / Facility
  "faction_build", "faction_upgrade", "personal_build",
  // v0.327 Recycling Processor — not yet in live game action enum (verified absent 2026-05-30),
  // pre-declared so passthrough routes it the moment the game publishes it.
  "configure_recycler",
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
// throttledPersistGameState
// ---------------------------------------------------------------------------

const PERSIST_THROTTLE_MS = 30_000;
const lastPersistTime = new Map<string, number>();

export function throttledPersistGameState(agentName: string, state: { data: Record<string, unknown>; fetchedAt: number }): void {
  const now = Date.now();
  const last = lastPersistTime.get(agentName) ?? 0;
  if (now - last >= PERSIST_THROTTLE_MS) {
    lastPersistTime.set(agentName, now);
    persistGameState(agentName, state);
  }
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
