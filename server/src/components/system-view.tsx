"use client";

import { AGENT_COLORS } from "@/lib/utils";
import { EMPIRE_COLORS, normalizeEmpire } from "./galaxy-map-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemViewSystem {
  id: string;
  name: string;
  empire?: string;
  connections: string[];
}

export interface SystemViewProps {
  system: SystemViewSystem;
  /** Connection id to name lookup for labeling jump gates */
  systemNames: Record<string, string>;
  agentPositions: Record<string, { system: string; poi: string | null; docked: boolean }>;
  onBack: () => void;
  /** Known POIs from game_snapshots per system (optional, enriches the view) */
  knownPois?: Record<string, string[]>;
  /** Navigate to another system (e.g. by clicking a gate) */
  onSystemNavigate?: (systemId: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use shared EMPIRE_COLORS as star fill colors (same values)

const EMPIRE_GLOW_COLORS: Record<string, string> = {
  solarian:         "rgba(212,160,23,0.25)",
  voidborn:         "rgba(124,58,237,0.25)",
  crimson:          "rgba(220,38,38,0.25)",
  nebula:           "rgba(13,148,136,0.25)",
  outerrim:         "rgba(234,88,12,0.25)",
  piratestronghold: "rgba(127,29,29,0.25)",
  neutral:          "rgba(75,85,99,0.25)",
};

const SVG_W = 600;
const SVG_H = 600;
const CX = SVG_W / 2;
const CY = SVG_H / 2;
const STAR_R = 40;
const POI_ORBIT_R = 195; // Fallback/default orbit radius
const POI_R = 13;
const AGENT_DOT_R = 7;

// Type-based orbit radii — stations close, belts mid, gates outer (Task 6)
const POI_TYPE_ORBIT_R: Record<string, number> = {
  station:  140,
  outpost:  155,
  belt:     200,
  sun:      170,
  gate:     255,
  unknown:  POI_ORBIT_R,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function starColor(empire?: string): string {
  return EMPIRE_COLORS[normalizeEmpire(empire)] ?? EMPIRE_COLORS.neutral;
}

function glowColor(empire?: string): string {
  return EMPIRE_GLOW_COLORS[normalizeEmpire(empire)] ?? EMPIRE_GLOW_COLORS.neutral;
}

export type PoiType = "station" | "belt" | "gate" | "sun" | "outpost" | "unknown";

export interface Poi {
  key: string;
  label: string;
  shortLabel: string;
  type: PoiType;
}

/**
 * Classify a POI name string into a type using name heuristics.
 * Exported for unit testing.
 */
export function classifyPoiType(name: string): PoiType {
  const l = name.toLowerCase();
  if (l.includes("station") || l.includes("base") || l.includes("port") || l.includes("hub")) return "station";
  if (l.includes("belt") || l.includes("asteroid") || l.includes("field") || l.includes("ring")) return "belt";
  if (l.includes("gate") || l.includes("jump") || l.includes("warp") || l.includes("portal")) return "gate";
  if (l.includes("sun") || l.includes("star") || l.includes("corona") || l.includes("sol")) return "sun";
  if (l.includes("outpost") || l.includes("colony") || l.includes("depot") || l.includes("relay")) return "outpost";
  return "unknown";
}

const POI_TYPE_SHORT: Record<PoiType, string> = {
  station: "STA",
  belt:    "BLT",
  gate:    "JMP",
  sun:     "SUN",
  outpost: "OUT",
  unknown: "POI",
};

function buildPois(
  system: SystemViewSystem,
  systemNames: Record<string, string>,
  knownPois?: string[]
): Poi[] {
  const pois: Poi[] = [{ key: "station", label: "Station", shortLabel: "STA", type: "station" }];

  // Gates from connection list (capped at 7 to avoid overcrowding)
  const gateIds = new Set<string>();
  const gates = system.connections.slice(0, 7);
  for (const connId of gates) {
    gateIds.add(connId);
    const connName = systemNames[connId] ?? connId;
    const short = connName.slice(0, 3).toUpperCase();
    pois.push({
      key: "gate-" + connId,
      label: "Gate \u2192 " + connName,
      shortLabel: short,
      type: "gate",
    });
  }

  // Supplement with POIs from game_snapshots, excluding duplicates/station/gates
  if (knownPois) {
    const seenLabels = new Set(pois.map((p) => p.label.toLowerCase()));
    for (const poiName of knownPois) {
      const labelLower = poiName.toLowerCase();
      if (seenLabels.has(labelLower)) continue;
      seenLabels.add(labelLower);
      const type = classifyPoiType(poiName);
      // Skip if it's already covered as a connection gate
      if (type === "gate") continue;
      const short = POI_TYPE_SHORT[type];
      pois.push({
        key: "snapshot-" + poiName.replace(/\s+/g, "-").toLowerCase(),
        label: poiName,
        shortLabel: short,
        type,
      });
    }
  }

  return pois;
}

function poiPosition(index: number, total: number, type: PoiType = "unknown"): { x: number; y: number } {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2;
  const orbitR = POI_TYPE_ORBIT_R[type] ?? POI_ORBIT_R;
  return {
    x: CX + orbitR * Math.cos(angle),
    y: CY + orbitR * Math.sin(angle),
  };
}

function agentPoiKey(poiName: string | null, pois: Poi[]): string {
  if (!poiName) return "station";
  const lower = poiName.toLowerCase();
  for (const poi of pois) {
    if (poi.key === "station") continue;
    if (
      lower.includes(poi.shortLabel.toLowerCase()) ||
      poi.label.toLowerCase().includes(lower)
    ) {
      return poi.key;
    }
  }
  return "station";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Render a POI icon shape based on its type. */
function PoiIcon({
  cx, cy, r, type, isStation,
}: {
  cx: number; cy: number; r: number; type: PoiType; isStation: boolean;
}) {
  const fill = isStation ? "#3b4252" : "#2e3440";
  const stroke = isStation ? "#88c0d0" : type === "belt" ? "#ebcb8b" : type === "sun" ? "#d4a017" : type === "outpost" ? "#a3be8c" : "#4c566a";
  const sw = isStation ? 1.5 : 1;

  if (type === "belt") {
    // Dashed ring
    return (
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray="3 3" />
    );
  }
  if (type === "sun") {
    // Small burst — 4-pointed star using polygon
    const pts = Array.from({ length: 8 }, (_, i) => {
      const angle = (Math.PI / 4) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? r : r * 0.5;
      return `${cx + rad * Math.cos(angle)},${cy + rad * Math.sin(angle)}`;
    }).join(" ");
    return <polygon points={pts} fill={stroke} opacity={0.85} />;
  }
  if (type === "outpost") {
    // Diamond
    return (
      <polygon
        points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
        fill={fill} stroke={stroke} strokeWidth={sw}
      />
    );
  }
  if (type === "gate") {
    // Arrow-like chevron (simple right-pointing shape)
    return (
      <polygon
        points={`${cx - r * 0.6},${cy - r * 0.8} ${cx + r * 0.8},${cy} ${cx - r * 0.6},${cy + r * 0.8}`}
        fill={fill} stroke={stroke} strokeWidth={sw}
      />
    );
  }
  // Default: circle (station or unknown)
  return <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={sw} />;
}

export function SystemView({
  system,
  systemNames,
  agentPositions,
  onBack,
  knownPois,
  onSystemNavigate,
}: SystemViewProps) {
  const systemKnownPois = knownPois?.[system.id];
  const pois = buildPois(system, systemNames, systemKnownPois);
  const poiCount = pois.length;

  const agentsHere = Object.entries(agentPositions).filter(
    ([, pos]) => pos.system === system.id
  );

  const agentsByPoi: Record<
    string,
    Array<{ name: string; docked: boolean }>
  > = {};
  for (const [name, pos] of agentsHere) {
    const key = agentPoiKey(pos.poi, pois);
    if (!agentsByPoi[key]) agentsByPoi[key] = [];
    agentsByPoi[key].push({ name, docked: pos.docked });
  }

  const star = starColor(system.empire);
  const glow = glowColor(system.empire);

  return (
    <div className="flex flex-col w-full h-full">
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3 shrink-0 self-start"
        aria-label="Back to galaxy map"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 12H5" />
          <path d="M12 19l-7-7 7-7" />
        </svg>
        <span className="uppercase tracking-wider text-[10px]">Galaxy Map</span>
      </button>

      {/* SVG visualization */}
      <svg
        viewBox={"0 0 " + SVG_W + " " + SVG_H}
        width="100%"
        height="100%"
        style={{ display: "block", flex: 1, minHeight: 0 }}
        aria-label={"System view: " + system.name}
      >
        <rect width={SVG_W} height={SVG_H} fill="transparent" />

        {/* Orbit guide rings — one per type-based orbit radius (Task 6) */}
        {Array.from(new Set(Object.values(POI_TYPE_ORBIT_R))).sort((a, b) => a - b).map((r) => (
          <circle
            key={r}
            cx={CX}
            cy={CY}
            r={r}
            fill="none"
            stroke="#3b4252"
            strokeWidth="0.75"
            strokeDasharray="4 6"
            opacity="0.35"
          />
        ))}

        {/* Lines from center to each POI */}
        {pois.map((poi, i) => {
          const pos = poiPosition(i, poiCount, poi.type);
          return (
            <line
              key={"line-" + poi.key}
              x1={CX}
              y1={CY}
              x2={pos.x}
              y2={pos.y}
              stroke="#3b4252"
              strokeWidth="0.75"
              opacity="0.4"
            />
          );
        })}

        {/* Star glow */}
        <circle cx={CX} cy={CY} r={STAR_R + 20} fill={glow} />

        {/* Central star */}
        <circle cx={CX} cy={CY} r={STAR_R} fill={star} />
        <circle
          cx={CX - 10}
          cy={CY - 10}
          r={STAR_R * 0.35}
          fill="rgba(255,255,255,0.12)"
        />

        {/* System name */}
        <text
          x={CX}
          y={CY + STAR_R + 18}
          textAnchor="middle"
          fontSize="13"
          fontFamily='"JetBrains Mono", monospace'
          fill="#d8dee9"
          fontWeight="600"
          letterSpacing="0.04em"
        >
          {system.name}
        </text>

        {/* Empire label */}
        {system.empire && (
          <text
            x={CX}
            y={CY + STAR_R + 34}
            textAnchor="middle"
            fontSize="9"
            fontFamily='"JetBrains Mono", monospace'
            fill={star}
            opacity="0.8"
            letterSpacing="0.1em"
          >
            {system.empire.toUpperCase()}
          </text>
        )}

        {/* POIs */}
        {pois.map((poi, i) => {
          const pos = poiPosition(i, poiCount, poi.type);
          const isStation = poi.key === "station";
          const agents = agentsByPoi[poi.key] ?? [];

          const dx = pos.x - CX;
          const dy = pos.y - CY;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const labelOffX = (dx / dist) * (POI_R + 14);
          const labelOffY = (dy / dist) * (POI_R + 14);
          const labelX = pos.x + labelOffX;
          const labelY = pos.y + labelOffY;

          const textAnchor =
            pos.x < CX - 20 ? "end" : pos.x > CX + 20 ? "start" : "middle";
          const dominantBaseline =
            pos.y < CY - 20
              ? "auto"
              : pos.y > CY + 20
                ? "hanging"
                : "middle";

          const isGate = poi.type === "gate";
          const gateTarget = isGate ? poi.key.replace("gate-", "") : null;

          return (
            <g
              key={poi.key}
              style={isGate && onSystemNavigate ? { cursor: "pointer" } : undefined}
              onClick={isGate && onSystemNavigate && gateTarget ? () => onSystemNavigate(gateTarget) : undefined}
            >
              <PoiIcon cx={pos.x} cy={pos.y} r={POI_R} type={poi.type} isStation={isStation} />

              <text
                x={pos.x}
                y={pos.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fontSize="7"
                fontFamily='"JetBrains Mono", monospace'
                fill={isStation ? "#88c0d0" : "#81a1c1"}
                fontWeight="600"
                letterSpacing="0.05em"
              >
                {poi.shortLabel}
              </text>

              <text
                x={labelX}
                y={labelY}
                textAnchor={textAnchor}
                dominantBaseline={dominantBaseline}
                fontSize="9"
                fontFamily='"JetBrains Mono", monospace'
                fill="#81a1c1"
                opacity="0.85"
              >
                {poi.label}
              </text>

              {agents.map(({ name, docked }, agentIdx) => {
                const totalAgents = agents.length;
                const spreadAngle =
                  totalAgents > 1
                    ? (Math.PI / 3) * (agentIdx / (totalAgents - 1) - 0.5)
                    : 0;
                const baseAngle = Math.atan2(dy, dx) + Math.PI;
                const agentAngle = baseAngle + spreadAngle;
                const agentOrbit = POI_R + AGENT_DOT_R + 3;
                const ax = pos.x + agentOrbit * Math.cos(agentAngle);
                const ay = pos.y + agentOrbit * Math.sin(agentAngle);
                const agentColor = AGENT_COLORS[name] ?? "#d8dee9";

                return (
                  <g key={name}>
                    {docked && (
                      <circle
                        cx={ax}
                        cy={ay}
                        r={AGENT_DOT_R + 2.5}
                        fill="none"
                        stroke={agentColor}
                        strokeWidth="1"
                        opacity="0.5"
                        strokeDasharray="2 2"
                      />
                    )}
                    <circle
                      cx={ax}
                      cy={ay}
                      r={AGENT_DOT_R}
                      fill={agentColor}
                    />
                    <text
                      x={ax}
                      y={ay + AGENT_DOT_R + 9}
                      textAnchor="middle"
                      dominantBaseline="hanging"
                      fontSize="7.5"
                      fontFamily='"JetBrains Mono", monospace'
                      fill={agentColor}
                      opacity="0.9"
                    >
                      {name.split("-")[0]}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
