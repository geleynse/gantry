/**
 * Ship images configuration
 * Points to spacemolt.com's ship catalog images.
 * Only some ships have images (faction premium ships); the rest use emoji fallback.
 */

export const SHIP_IMAGE_CDN_BASE = "https://www.spacemolt.com/images/ships/catalog";

export type ShipImageSize = "icon" | "thumbnail" | "medium" | "large" | "xlarge";

export const SIZE_PIXELS: Record<ShipImageSize, number> = {
  icon: 32,
  thumbnail: 64,
  medium: 200,
  large: 400,
  xlarge: 800,
};

export interface ShipClassEmoji {
  class: string;
  emoji: string;
  abbreviation: string;
}

// Emoji fallbacks keyed by prefix — used when no image is available
const SHIP_CLASS_EMOJIS: ShipClassEmoji[] = [
  { class: "starter", emoji: "🚀", abbreviation: "STR" },
  { class: "mining", emoji: "⛏️", abbreviation: "MIN" },
  { class: "freighter", emoji: "📦", abbreviation: "FRE" },
  { class: "fighter", emoji: "🛸", abbreviation: "FIG" },
  { class: "courier", emoji: "💨", abbreviation: "CUR" },
  { class: "blockade", emoji: "🛡️", abbreviation: "BLK" },
  { class: "cargo", emoji: "📦", abbreviation: "CRG" },
  { class: "refinery", emoji: "🏭", abbreviation: "REF" },
  { class: "outerrim", emoji: "🌌", abbreviation: "OTR" },
  { class: "nebula", emoji: "☁️", abbreviation: "NEB" },
  { class: "crimson", emoji: "🔴", abbreviation: "CRM" },
  { class: "solarian", emoji: "☀️", abbreviation: "SOL" },
  { class: "voidborn", emoji: "🌑", abbreviation: "VDB" },
];

const EMOJI_MAP = new Map(SHIP_CLASS_EMOJIS.map((e) => [e.class, e]));

const DEFAULT_EMOJI: ShipClassEmoji = { class: "unknown", emoji: "🚀", abbreviation: "UNK" };

/**
 * Get emoji for a ship class by matching the prefix of the class_id
 */
export function getShipClassEmoji(shipClass: string): ShipClassEmoji {
  const normalized = (shipClass || "").toLowerCase();
  // Try exact match first
  if (EMOJI_MAP.has(normalized)) return EMOJI_MAP.get(normalized)!;
  // Try prefix match (e.g., "mining_barge" → "mining")
  for (const [prefix, entry] of EMOJI_MAP) {
    if (normalized.startsWith(prefix)) return entry;
  }
  return DEFAULT_EMOJI;
}

/**
 * Build ship image URL from class_id.
 * Returns a single webp URL — the game only serves webp.
 */
export function getShipImageUrl(shipClass: string): string {
  const normalized = (shipClass || "unknown").toLowerCase().replace(/\s+/g, "_");
  return `${SHIP_IMAGE_CDN_BASE}/${normalized}.webp`;
}
