/**
 * Ship image — inline SVG silhouettes per ship category.
 * Deterministic colors from ship class name. No external images needed.
 */

import { cn } from "@/lib/utils";

export interface ShipImageFallbackProps {
  shipClass: string;
  width: number;
  height: number;
  className?: string;
  style?: React.CSSProperties;
}

// Ship category → SVG path (viewBox 0 0 100 100, pointing right)
const SHIP_SILHOUETTES: Record<string, string> = {
  // Mining: bulky with drill/scoop
  mining:
    "M15 50 L30 30 L55 25 L70 30 L85 40 L95 50 L85 60 L70 70 L55 75 L30 70 Z M55 25 L65 15 L75 20 L70 30 M55 75 L65 85 L75 80 L70 70 M30 45 L20 42 L15 50 L20 58 L30 55",
  // Starter: simple wedge
  starter:
    "M15 50 L35 30 L75 28 L90 50 L75 72 L35 70 Z M75 28 L85 20 M75 72 L85 80",
  // Fighter: sleek delta
  fighter:
    "M10 50 L30 35 L60 30 L95 50 L60 70 L30 65 Z M30 35 L25 20 L40 28 M30 65 L25 80 L40 72",
  // Freighter: boxy hauler
  freighter:
    "M15 35 L80 35 L90 42 L90 58 L80 65 L15 65 Z M15 35 L10 42 L10 58 L15 65 M50 35 L50 65 M65 35 L65 65",
  // Courier: streamlined
  courier:
    "M10 50 L25 38 L70 32 L95 50 L70 68 L25 62 Z M25 38 L20 25 L35 32 M25 62 L20 75 L35 68",
  // Blockade: armored
  blockade:
    "M12 40 L30 30 L70 28 L88 40 L88 60 L70 72 L30 70 L12 60 Z M30 30 L28 18 L38 25 M30 70 L28 82 L38 75 M70 28 L78 20 M70 72 L78 80",
  // Cargo: container ship
  cargo:
    "M10 38 L85 38 L92 45 L92 55 L85 62 L10 62 Z M25 38 L25 62 M40 38 L40 62 M55 38 L55 62 M70 38 L70 62",
  // Refinery: industrial
  refinery:
    "M15 35 L75 35 L85 42 L85 58 L75 65 L15 65 L10 58 L10 42 Z M35 25 L35 35 M35 65 L35 75 M55 20 L55 35 M55 65 L55 80",
  // Outerrim: angular aggressive
  outerrim:
    "M8 50 L25 32 L50 22 L75 28 L95 50 L75 72 L50 78 L25 68 Z M25 32 L18 18 L35 28 M25 68 L18 82 L35 72 M75 28 L82 18 M75 72 L82 82",
  // Nebula: organic curves
  nebula:
    "M10 50 L22 34 L45 24 L68 28 L88 38 L95 50 L88 62 L68 72 L45 76 L22 66 Z M22 34 L15 22 L32 28 M22 66 L15 78 L32 72",
  // Crimson: sharp military
  crimson:
    "M8 50 L22 30 L55 22 L80 32 L95 50 L80 68 L55 78 L22 70 Z M55 22 L62 12 L72 22 M55 78 L62 88 L72 78 M22 30 L15 20 M22 70 L15 80",
  // Solarian: elegant
  solarian:
    "M10 50 L28 32 L55 25 L78 30 L95 50 L78 70 L55 75 L28 68 Z M28 32 L22 18 L38 26 M28 68 L22 82 L38 74 M78 30 L85 22 M78 70 L85 78",
  // Voidborn: alien/asymmetric
  voidborn:
    "M8 48 L25 28 L50 20 L72 25 L92 45 L95 55 L88 65 L65 78 L40 80 L20 72 L10 58 Z M25 28 L18 15 M50 20 L48 10 M65 78 L70 88",
};

// Known class_id -> silhouette category mapping.
// This is used when class_id does not include a category prefix (e.g. "theoria", "levy").
const CLASS_ID_TO_CATEGORY: Record<string, string> = {
  theoria: "solarian",
  levy: "crimson",
  prospect: "nebula",
  shard: "starter",
  cobble: "cargo",
  threshold: "voidborn",
};

// Faction/category color palettes (hue-shifted pairs for gradient)
const COLOR_PALETTES: Array<[string, string]> = [
  ["#3b82f6", "#06b6d4"], // blue → cyan
  ["#8b5cf6", "#a855f7"], // violet → purple
  ["#ef4444", "#f97316"], // red → orange
  ["#10b981", "#06b6d4"], // emerald → cyan
  ["#6366f1", "#3b82f6"], // indigo → blue
  ["#f59e0b", "#eab308"], // amber → yellow
  ["#ec4899", "#f43f5e"], // pink → rose
  ["#14b8a6", "#06b6d4"], // teal → cyan
  ["#a855f7", "#8b5cf6"], // purple → violet
  ["#f97316", "#f59e0b"], // orange → amber
];

function hashString(s: string): number {
  return s.toLowerCase().split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
}

function getShipCategory(shipClass: string): string {
  const lower = shipClass.toLowerCase();
  for (const [classId, category] of Object.entries(CLASS_ID_TO_CATEGORY)) {
    if (lower === classId || lower.endsWith(`_${classId}`)) return category;
  }
  for (const category of Object.keys(SHIP_SILHOUETTES)) {
    if (lower.startsWith(category)) return category;
  }
  return "starter"; // default silhouette
}

function getAbbreviation(shipClass: string): string {
  const parts = shipClass.toLowerCase().replace(/_/g, " ").split(" ");
  if (parts.length >= 2) {
    return (parts[0].slice(0, 2) + parts[1][0]).toUpperCase();
  }
  return shipClass.slice(0, 3).toUpperCase();
}

export function ShipImageFallback({
  shipClass,
  width,
  height,
  className,
  style,
}: ShipImageFallbackProps) {
  const category = getShipCategory(shipClass);
  const silhouette = SHIP_SILHOUETTES[category];
  const colorIdx = hashString(shipClass) % COLOR_PALETTES.length;
  const [color1, color2] = COLOR_PALETTES[colorIdx];
  const gradientId = `ship-grad-${hashString(shipClass)}`;
  const abbr = getAbbreviation(shipClass);
  const showAbbr = Math.min(width, height) >= 80;

  return (
    <div
      className={cn("relative overflow-hidden rounded w-full h-full", className)}
      style={{
        background: `linear-gradient(135deg, ${color1}22, ${color2}22)`,
        ...style,
      }}
      title={shipClass.replace(/_/g, " ")}
    >
      <svg
        viewBox="0 0 100 100"
        width="100%"
        height="100%"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={color1} stopOpacity="0.85" />
            <stop offset="100%" stopColor={color2} stopOpacity="0.85" />
          </linearGradient>
        </defs>
        <path
          d={silhouette}
          fill={`url(#${gradientId})`}
          stroke={color1}
          strokeWidth="1"
          strokeOpacity="0.5"
        />
      </svg>
      {showAbbr && (
        <div
          className="absolute bottom-0.5 right-1 text-white/70 font-mono font-bold tracking-wider select-none"
          style={{ fontSize: `${Math.max(8, Math.min(width, height) * 0.11)}px` }}
        >
          {abbr}
        </div>
      )}
    </div>
  );
}
