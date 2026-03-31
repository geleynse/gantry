/**
 * COMPOUND_TOOL_DESCRIPTIONS
 *
 * Human-readable one-line descriptions for each compound tool.
 * Used in the activity feed to provide context when a compound tool is displayed.
 */
export const COMPOUND_TOOL_DESCRIPTIONS: Record<string, string> = {
  batch_mine: "Mine multiple ticks with auto-stop on cargo full",
  travel_to: "Undock → travel → dock in one operation",
  jump_route: "Multi-system jump via shortest path",
  multi_sell: "Sell cargo across multiple buyers",
  scan_and_attack: "Scan for hostiles and engage",
  loot_wrecks: "Loot multiple wrecks at current location",
  battle_readiness: "Check combat readiness status",
  flee: "Emergency escape from combat",
  get_craft_profitability: "Analyzes craftable recipes and ranks by profit using current market prices",
  craft_path_to: "Traces the full crafting chain for an item — bill of materials, source tags, and cost estimate",
};

/**
 * Set of compound tool names for fast membership checks.
 * Keep in sync with the implementations in compound-tools/.
 */
export const COMPOUND_TOOL_NAMES = new Set(Object.keys(COMPOUND_TOOL_DESCRIPTIONS));
