"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { AGENT_COLORS } from "@/lib/utils";
import { EMPIRE_COLORS, EMPIRE_LABELS, normalizeEmpire } from "./galaxy-map-utils";
import type { SystemPopupData } from "./galaxy-map-types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SystemPopupProps {
  data: SystemPopupData;
  /** Screen position for the popup (from graph2ScreenCoords) */
  screenPos: { x: number; y: number };
  /** Container dimensions for edge clamping */
  containerSize: { width: number; height: number };
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SystemPopup({ data, screenPos, containerSize, onClose }: SystemPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Position the popup near the node, clamped to container edges
  const popupWidth = 260;
  const popupMaxHeight = 360;
  const margin = 12;

  let left = screenPos.x + margin;
  let top = screenPos.y - popupMaxHeight / 2;

  // Clamp right edge
  if (left + popupWidth > containerSize.width - margin) {
    left = screenPos.x - popupWidth - margin;
  }
  // Clamp left edge
  if (left < margin) left = margin;
  // Clamp top/bottom
  if (top < margin) top = margin;
  if (top + popupMaxHeight > containerSize.height - margin) {
    top = containerSize.height - popupMaxHeight - margin;
  }

  const empireKey = normalizeEmpire(data.empire ?? undefined);
  const empireColor = EMPIRE_COLORS[empireKey] ?? EMPIRE_COLORS.neutral;
  const empireLabel = EMPIRE_LABELS[empireKey] ?? data.empire ?? "Neutral";

  // pointer-events-none on the wrapper so the backdrop doesn't block canvas hover/drag.
  // The popup card itself gets pointer-events-auto.
  return (
    <div className="absolute inset-0 z-20 pointer-events-none">
      <div
        ref={popupRef}
        className="absolute bg-card border border-border shadow-lg overflow-y-auto text-xs pointer-events-auto"
        style={{
          left,
          top,
          width: popupWidth,
          maxHeight: popupMaxHeight,
        }}
      >
        {/* Header */}
        <div className="px-3 py-2 border-b border-border flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold text-sm text-foreground">{data.name}</div>
            <div className="flex items-center gap-1.5 mt-0.5 text-muted-foreground">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: empireColor }}
              />
              <span>{empireLabel}</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-3 py-2 space-y-2.5">
          {/* Agents */}
          {data.agents.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Agents ({data.agents.length})
              </div>
              <ul className="space-y-0.5">
                {data.agents.map((a) => (
                  <li key={a.name} className="flex items-center gap-1.5">
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: AGENT_COLORS[a.name] ?? "#d8dee9" }}
                    />
                    <span className="text-foreground">{a.name}</span>
                    {a.shipClass && (
                      <span className="text-muted-foreground font-mono text-[10px]">{a.shipClass}</span>
                    )}
                    {a.docked && (
                      <span className="text-green-400 text-[10px]">[docked]</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* POIs */}
          {data.pois.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Points of Interest ({data.pois.length})
              </div>
              <ul className="space-y-0.5">
                {data.pois.map((p) => (
                  <li key={p.id} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground font-mono text-[10px] w-6 shrink-0">
                      {(p.type ?? "poi").slice(0, 3).toUpperCase()}
                    </span>
                    <span className="text-foreground truncate">{p.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Connections */}
          {data.connections.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Connections ({data.connections.length})
              </div>
              <ul className="space-y-0.5 max-h-24 overflow-y-auto">
                {data.connections.map((c) => (
                  <li key={c.id} className="flex items-center gap-1.5">
                    {c.empire && (
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full"
                        style={{
                          background:
                            EMPIRE_COLORS[normalizeEmpire(c.empire)] ?? EMPIRE_COLORS.neutral,
                        }}
                      />
                    )}
                    <span className="text-foreground font-mono truncate">{c.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
