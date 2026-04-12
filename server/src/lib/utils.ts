import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Canonical agent name → color mapping for known agents.
 * NOTE: Used by leaderboard to identify fleet agents among all players.
 * Do NOT use this for UI rendering of agent lists — use useAgentNames() hook instead.
 */
export const AGENT_COLORS: Record<string, string> = {
  // Populated at runtime from fleet config. Add custom colors here if desired.
  // Example: 'my-agent': '#88c0d0',
};

/**
 * Returns a color for the given agent name.
 * Uses the canonical color map for known agents; generates a deterministic
 * color from the name hash for unknown agents.
 */
export function getAgentColor(name: string): string {
  if (AGENT_COLORS[name]) return AGENT_COLORS[name];
  // Simple djb2 hash → hsl color
  let hash = 5381;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 65%)`;
}

/**
 * All fleet agent names (hardcoded).
 * NOTE: Used by leaderboard/leaderboard-table to identify fleet agents among
 * all players. Do NOT use this for UI rendering of agent lists — use the
 * useAgentNames() hook instead so Gantry works with any fleet-config.
 */
export const AGENT_NAMES = [
  // Populated at runtime from fleet config.
  // The leaderboard uses this to distinguish fleet agents from other players.
] as const;

/** Format a number as credits with K/M suffixes and null safety */
export function formatCredits(n: number | null | undefined): string {
  if (n == null) return "---";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M cr`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k cr`;
  return `${n.toLocaleString()} cr`;
}

/** Format a timestamp as relative time (e.g., "2m ago") */
export function relativeTime(ts: string | number | null | undefined): string {
  if (ts == null) return "—";
  const now = Date.now();
  // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" (space, no Z).
  // Some browsers don't parse this — normalize to ISO 8601.
  let then: number;
  if (typeof ts === "string") {
    const iso = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
    then = new Date(iso).getTime();
  } else {
    then = ts;
  }
  if (isNaN(then)) return "—";
  const diff = Math.max(0, now - then);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// Hardcoded mappings for common items/modules (keys are lowercase)
const ITEM_MAPPING: Record<string, string> = {
  'mining_laser_1': 'Mining Laser I',
  'mining_laser_i': 'Mining Laser I',
  'autocannon_i': 'Autocannon I',
  'armor_plate_i': 'Armor Plate I',
  'shield_generator_i': 'Shield Generator I',
  'ftl_drive_i': 'FTL Drive I',
  'sensor_array_i': 'Sensor Array I',
};

/** Translate item_id to human-readable cargo name (e.g., copper_ore → Copper Ore, steel_plate → Steel Plate) */
export function getItemName(itemId: string | undefined, displayName?: string | null): string {
  // If a display name is provided, just fix roman numerals and return
  if (displayName) return fixRomanNumerals(displayName);
  if (!itemId) return 'Unknown';

  const mapped = ITEM_MAPPING[itemId] ?? ITEM_MAPPING[itemId.toLowerCase()];
  if (mapped) return mapped;

  // Ore format: copper_ore, iron_ore → Copper Ore, Iron Ore
  const oreMatch = itemId.match(/^(.+?)_ore$/);
  if (oreMatch) {
    const name = oreMatch[1]
      .replace(/_/g, ' ')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return `${name} Ore`;
  }

  // Generic format: steel_plate, copper_wiring, trade_crystal → Steel Plate, Copper Wiring, Trade Crystal
  const formatted = itemId
    .replace(/_/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return fixRomanNumerals(formatted);
}

/** Detect if a string looks like a raw hex hash (8+ char hex, includes 32-char UUIDs) */
function isHexHash(str: string | null | undefined): boolean {
  if (!str) return false;
  // Match any pure hex string of 8+ chars (includes 32-char UUIDs like 1aa16e807736f14db436567c737255a6)
  return /^[a-f0-9]{8,}$/i.test(str);
}

/**
 * Fix incorrect casing of Roman numeral suffixes.
 * Game API returns names like "Pulse Laser Ii" or "Autocannon Iii" — the
 * standard title-case logic lowercases all-caps tokens like "II" → "Ii".
 * This restores them: Ii→II, Iii→III, Iv→IV, Vi→VI, Vii→VII, Viii→VIII, Ix→IX.
 */
export function fixRomanNumerals(name: string): string {
  return name.replace(/\b(Ii{0,2}|Iv|Vi{0,3}|Ix|II+|IV|VI+|IX)\b/g, (m) => m.toUpperCase());
}

/** Format module name with fallback for unresolved hex hashes */
export function formatModuleName(name: string | null | undefined, id: string | null | undefined): string {
  if (name && !isHexHash(name)) return fixRomanNumerals(name);
  if (id && !isHexHash(id)) return fixRomanNumerals(id);
  if (id && isHexHash(id)) return `Module (${id.slice(0, 4)}…)`;
  return 'Unknown Module';
}

/** Parse args_json and extract a human-readable summary for transaction display */
export function summarizeArgs(json: string | null | undefined): string {
  if (!json) return '—';

  try {
    const parsed = JSON.parse(json);

    // Extract meaningful transaction fields
    if (parsed.item) {
      const qty = parsed.quantity ? ` x${parsed.quantity}` : '';
      return `${parsed.item}${qty}`;
    }
    if (parsed.items && Array.isArray(parsed.items)) {
      return `${parsed.items.length} items`;
    }
    if (parsed.destination) {
      return `→ ${parsed.destination}`;
    }
    if (parsed.item_name) {
      return parsed.item_name;
    }

    // Fallback: stringify and truncate
    return JSON.stringify(parsed).slice(0, 80);
  } catch {
    // If JSON parse fails, truncate the raw string
    return (json || '').slice(0, 80);
  }
}
