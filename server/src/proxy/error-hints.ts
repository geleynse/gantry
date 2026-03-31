export interface HintContext {
  docked?: boolean;
  currentPoi?: string;
  cargoUsed?: number;
  cargoCapacity?: number;
  credits?: number;
  fuel?: number;
  hasWeapon?: boolean;
}

interface ErrorHint {
  pattern: string | RegExp;
  hint: string;
}

const ERROR_HINTS: ErrorHint[] = [
  { pattern: "not docked", hint: "You need to dock first. Use dock at a station." },
  { pattern: "must be docked", hint: "You need to dock first. Use dock at a station." },
  { pattern: "already docked", hint: "You're already docked. Use undock to leave." },
  { pattern: "cargo full", hint: "Cargo is full. Dock and use multi_sell to sell cargo for credits. Do NOT deposit — deposits earn 0 credits." },
  { pattern: "cargo hold", hint: "Cargo is full. Dock and use multi_sell to sell cargo for credits. Do NOT deposit — deposits earn 0 credits." },
  { pattern: "not enough fuel", hint: "Low fuel. Dock at a station and refuel." },
  { pattern: "no weapon module", hint: "No weapon equipped. Buy one from view_market and install_mod." },
  { pattern: "not at a base", hint: "You're not at a base POI. Use get_system to find stations." },
  { pattern: "already undocked", hint: "You're already in space. Use travel or jump." },
  { pattern: "insufficient credits", hint: "Not enough credits. Mine and sell ore to earn more." },
  { pattern: "in transit", hint: "Ship is in transit. Wait for arrival before acting." },
  { pattern: "in combat", hint: "You're in combat. Fight or flee first." },
  { pattern: "rate_limited", hint: "Action on cooldown. Try a different action." },
  { pattern: "cooldown", hint: "Action on cooldown. Try a different action." },
  { pattern: "no target", hint: "No target to attack. Use scan to find ships nearby." },
  { pattern: "inventory full", hint: "Storage is full. Withdraw or sell items." },
  { pattern: "criminal", hint: "You have criminal status. Police may interdict you in empire space. Move to lawless systems (police = 0) to avoid further encounters." },
  { pattern: "police", hint: "Police patrol this system. Avoid attacking players or NPCs here — move to lawless space for combat." },
  { pattern: "mission_not_found", hint: "Mission not assigned to you or doesn't exist. Check get_active_missions." },
  { pattern: "unavailable", hint: "Mission unavailable. The error explains why — check level, faction, or item requirements." },
  { pattern: "not found", hint: "Item or target not found. Check spelling and use get_system for options." },
  { pattern: "dock_verification_failed", hint: "This POI is not a dockable station. Use get_system to find stations, then travel_to a station POI." },
  { pattern: "not a base", hint: "This POI is not a dockable station. Use get_system to find stations, then travel_to a station POI." },
  { pattern: "no_base", hint: "This POI is not a dockable station. Use get_system to find stations, then travel_to a station POI." },
  { pattern: "already insured", hint: "Ship already has active insurance. No action needed — skip and continue." },
  { pattern: "no_current_system", hint: "You are in hyperspace transit. Wait for arrival before acting." },
];

function getContextualHint(lower: string, context: HintContext): string | null {

  // Cargo-specific hint
  if (lower.includes("cargo full") && context.cargoUsed !== undefined && context.cargoCapacity !== undefined) {
    return `Cargo full (${context.cargoUsed}/${context.cargoCapacity} units). Sell items or upgrade cargo module.`;
  }

  // Credits-specific hint
  if (lower.includes("insufficient credits") && context.credits !== undefined) {
    return `Not enough credits (you have ${context.credits}cr). Mine and sell ore to earn more.`;
  }

  // Fuel-specific hint
  if (lower.includes("not enough fuel") && context.fuel !== undefined) {
    return `Low fuel (${context.fuel}/100). Dock at the nearest station and refuel.`;
  }

  // Weapon module hint
  if (lower.includes("no weapon") && context.hasWeapon === false) {
    return `No weapon equipped. Dock at a station, check view_market for weapons, then install_mod.`;
  }

  // Dock verification at non-station POIs
  const NON_STATION_POI_KEYWORDS = ["belt", "anomaly", "remnant", "star", "field", "gate", "drift", "comet", "vents", "shelf", "ring", "pocket", "cryobelt", "maw", "sun"];
  if ((lower.includes("no_base") || lower.includes("dock_verification_failed")) && context.currentPoi) {
    const poiLower = context.currentPoi.toLowerCase();
    if (NON_STATION_POI_KEYWORDS.some(kw => poiLower.includes(kw))) {
      return `You're at ${context.currentPoi} which is not a station. Use get_system to find stations.`;
    }
  }

  // Location-aware hints for "not docked"
  if (lower.includes("not docked") && context.currentPoi) {
    if (context.currentPoi.toLowerCase().includes("belt")) {
      return `You're at an asteroid belt — belts have no docking. Travel to a station first.`;
    }
    if (context.currentPoi.toLowerCase().includes("base") || context.currentPoi.toLowerCase().includes("station")) {
      if (context.docked === false) {
        return `You're at a station but not docked. Use dock first.`;
      }
    }
  }

  return null;
}

export function addErrorHint(errorMessage: string, context?: HintContext): string {
  const lower = errorMessage.toLowerCase();

  // Try context-aware hints first if context provided
  if (context) {
    const contextualHint = getContextualHint(lower, context);
    if (contextualHint) {
      return `${errorMessage}\nHint: ${contextualHint}`;
    }
  }

  // Fall back to generic hints
  for (const { pattern, hint } of ERROR_HINTS) {
    const match = typeof pattern === "string"
      ? lower.includes(pattern)
      : pattern.test(errorMessage);
    if (match) return `${errorMessage}\nHint: ${hint}`;
  }
  return errorMessage;
}
