/**
 * Role-based ship mod recommendations for agent survivability.
 *
 * Recommendations are informational only — exposed via API, not auto-executed.
 * Agents decide whether to act on these based on their current loadout and goals.
 *
 * Note: Exact mod type strings used in-game may differ from what's listed here.
 * These are advisory labels — the game's install_mod / uninstall_mod tools use
 * the actual mod IDs returned by the game's module catalog.
 */

export interface ModRecommendation {
  mod_type: string;
  priority: number; // 1 = highest
  reason: string;
}

export const ROLE_MOD_PRIORITIES: Record<string, ModRecommendation[]> = {
  combat: [
    { mod_type: "weapon_upgrade", priority: 1, reason: "Combat effectiveness" },
    { mod_type: "shield_booster", priority: 2, reason: "Survivability in sustained engagements" },
    { mod_type: "hull_reinforcement", priority: 3, reason: "Durability against heavy fire" },
  ],
  trader: [
    { mod_type: "cargo_expander", priority: 1, reason: "Trade volume — more cargo = more profit per route" },
    { mod_type: "fuel_optimizer", priority: 2, reason: "Route efficiency — reduces fuel cost per jump" },
    { mod_type: "shield_booster", priority: 3, reason: "Cargo protection against pirate interdiction" },
  ],
  explorer: [
    { mod_type: "fuel_optimizer", priority: 1, reason: "Range — explorers need to reach remote systems" },
    { mod_type: "scanner_upgrade", priority: 2, reason: "Discovery — better scans yield more POIs and anomalies" },
    { mod_type: "hull_reinforcement", priority: 3, reason: "Survivability — explorer hulls are typically fragile" },
  ],
  miner: [
    { mod_type: "mining_laser", priority: 1, reason: "Yield — higher-tier lasers extract more ore per tick" },
    { mod_type: "cargo_expander", priority: 2, reason: "Capacity — more cargo means fewer return trips" },
    { mod_type: "hull_reinforcement", priority: 3, reason: "Belt survival — asteroids and pirates both deal damage" },
  ],
  crafter: [
    { mod_type: "cargo_expander", priority: 1, reason: "Material capacity for large crafting runs" },
    { mod_type: "fuel_optimizer", priority: 2, reason: "Efficient hauling between crafting stations" },
    { mod_type: "shield_booster", priority: 3, reason: "Protection while transporting valuable materials" },
  ],
  hauler: [
    { mod_type: "cargo_expander", priority: 1, reason: "Maximize payload capacity per run" },
    { mod_type: "fuel_optimizer", priority: 2, reason: "Reduce fuel overhead on long hauls" },
    { mod_type: "shield_booster", priority: 3, reason: "Deter opportunistic pirate attacks" },
  ],
};

const DEFAULT_RECOMMENDATIONS: ModRecommendation[] = [
  { mod_type: "shield_booster", priority: 1, reason: "General survivability" },
  { mod_type: "hull_reinforcement", priority: 2, reason: "Damage absorption across all activities" },
];

/**
 * Get mod recommendations for a given role type.
 * Falls back to generic survivability mods for unknown or undefined roles.
 */
export function getModRecommendations(roleType: string | undefined): readonly ModRecommendation[] {
  if (!roleType) return DEFAULT_RECOMMENDATIONS;
  return ROLE_MOD_PRIORITIES[roleType] ?? DEFAULT_RECOMMENDATIONS;
}
