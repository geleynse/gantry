"use client";

import { EMPIRE_COLORS, EMPIRE_LABELS } from "./galaxy-map-utils";

// ---------------------------------------------------------------------------
// Overlay toggle types
// ---------------------------------------------------------------------------

export interface OverlayToggles {
  empireColors: boolean;
  dangerHeatmap: boolean;
  agentTrails: boolean;
  territoryShading: boolean;
  fogOfWar: boolean;
  wormholes: boolean;
}

// ---------------------------------------------------------------------------
// Toggle button
// ---------------------------------------------------------------------------

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}

function ToggleButton({ active, onClick, title, children }: ToggleButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        "px-2 py-1 text-xs font-mono border transition-colors select-none",
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-card text-muted-foreground border-border hover:border-foreground hover:text-foreground",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Overlay toggle bar — top-right corner of the map
// ---------------------------------------------------------------------------

export interface OverlayBarProps {
  overlays: OverlayToggles;
  onToggle: (key: keyof OverlayToggles) => void;
}

export function OverlayBar({ overlays, onToggle }: OverlayBarProps) {
  // flex-wrap + justify-end so the toggle row stacks onto a second line
  // instead of overflowing the map on narrow viewports or colliding with
  // the Search input in the top-left corner. max-w keeps it from pushing
  // into the left-side controls.
  return (
    <div className="absolute top-2 right-2 flex gap-1 z-10 flex-wrap justify-end max-w-[60%]">
      <ToggleButton
        active={overlays.empireColors}
        onClick={() => onToggle("empireColors")}
        title="Toggle empire territory colors"
      >
        🌐 Empire
      </ToggleButton>
      <ToggleButton
        active={overlays.dangerHeatmap}
        onClick={() => onToggle("dangerHeatmap")}
        title="Toggle danger heatmap"
      >
        ☠ Danger
      </ToggleButton>
      <ToggleButton
        active={overlays.territoryShading}
        onClick={() => onToggle("territoryShading")}
        title="Toggle empire territory shading"
      >
        ◈ Territory
      </ToggleButton>
      <ToggleButton
        active={overlays.agentTrails}
        onClick={() => onToggle("agentTrails")}
        title="Toggle agent trails (coming soon)"
      >
        ◎ Trails
      </ToggleButton>
      <ToggleButton
        active={overlays.fogOfWar}
        onClick={() => onToggle("fogOfWar")}
        title="Toggle fog of war (unexplored systems)"
      >
        ☁ Fog
      </ToggleButton>
      <ToggleButton
        active={overlays.wormholes}
        onClick={() => onToggle("wormholes")}
        title="Toggle wormhole routes"
      >
        ⟐ Wormholes
      </ToggleButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empire legend — bottom-left corner of the map
// ---------------------------------------------------------------------------

export function EmpireLegend({ empires }: { empires: string[] }) {
  return (
    <div className="absolute bottom-2 left-2 z-10 bg-card/80 border border-border px-2 py-1.5 text-[10px] font-mono space-y-0.5 pointer-events-none">
      {empires.map((key) => (
        <div key={key} className="flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{ background: EMPIRE_COLORS[key] ?? EMPIRE_COLORS.neutral }}
          />
          <span className="text-foreground/80">{EMPIRE_LABELS[key] ?? key}</span>
        </div>
      ))}
    </div>
  );
}
