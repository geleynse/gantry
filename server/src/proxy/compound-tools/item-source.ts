/**
 * compound-tools/item-source.ts
 *
 * Centralized item source classification logic.
 * Used by craft_path_to and get_craft_profitability to tag each input
 * with where the agent can get it (mine, salvage, harvest, or market).
 */

export type ItemSource = "mine" | "salvage" | "harvest" | "market";

/**
 * Classify an item by source based on its ID patterns.
 *
 * Rules (applied in order — first match wins):
 *   *_ore, *_crystal, *_gem               → "mine"
 *   *_herb, *_fiber, *_pollen             → "harvest"
 *   salvage_*, wreck_*, scrap_*, *_debris → "salvage"
 *   everything else                        → "market"
 */
export function classifyItemSource(itemId: string): ItemSource {
  const id = itemId.toLowerCase();

  // Mine: ores, crystals, gems, minerals
  if (
    id.endsWith("_ore") ||
    id.endsWith("_crystal") ||
    id.endsWith("_gem") ||
    id.includes("mineral")
  ) {
    return "mine";
  }

  // Harvest: herbs, fibers, pollen, seeds
  if (
    id.endsWith("_herb") ||
    id.endsWith("_fiber") ||
    id.endsWith("_pollen") ||
    id.endsWith("_seed")
  ) {
    return "harvest";
  }

  // Salvage: prefix or suffix patterns
  if (
    id.startsWith("salvage_") ||
    id.startsWith("wreck_") ||
    id.startsWith("scrap_") ||
    id.endsWith("_debris")
  ) {
    return "salvage";
  }

  return "market";
}

/**
 * Returns true if the source means the agent can obtain the item without
 * spending credits (only time/effort).
 */
export function isSelfSourceable(source: ItemSource): boolean {
  return source === "mine" || source === "salvage" || source === "harvest";
}

/**
 * Estimated credit cost if the agent self-sources the item.
 * For mineable/salvageable/harvestable items this is 0 (just time).
 * For market items it's the buy price.
 */
export function selfSourceCost(source: ItemSource, marketBuyPrice: number): number {
  return isSelfSourceable(source) ? 0 : marketBuyPrice;
}
