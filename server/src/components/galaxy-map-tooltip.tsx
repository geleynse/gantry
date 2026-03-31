"use client";

import { EMPIRE_LABELS } from "./galaxy-map-utils";
import type { GraphNode } from "./galaxy-map-types";

// ---------------------------------------------------------------------------
// Tooltip — shown on node hover
// ---------------------------------------------------------------------------

export interface MapTooltipProps {
  node: GraphNode;
  pos: { x: number; y: number };
  dangerTier: "High" | "Medium" | "Low" | null;
  showDanger: boolean;
}

export function MapTooltip({ node, pos, dangerTier, showDanger }: MapTooltipProps) {
  return (
    <div
      className="absolute pointer-events-none z-10 bg-card border border-border px-2 py-1 text-xs text-foreground"
      style={{
        left: pos.x,
        top: pos.y,
        maxWidth: 200,
      }}
    >
      <div className="font-semibold">{node.name}</div>
      <div className="text-muted-foreground capitalize mt-0.5">
        {EMPIRE_LABELS[node.empire] ?? node.empire}
      </div>
      {showDanger && dangerTier && (
        <div className="mt-0.5 text-[10px] text-red-400">
          ⚠ {dangerTier} pirate activity
        </div>
      )}
      {node.agents.length > 0 && (
        <div className="mt-0.5 text-[10px] text-primary">
          {node.agents.join(", ")}
        </div>
      )}
    </div>
  );
}
