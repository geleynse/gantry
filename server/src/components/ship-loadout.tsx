"use client";

import { useState } from "react";
import { cn, getItemName, formatModuleName } from "@/lib/utils";
import { HealthBar } from "./health-bar";
import { ShipImage } from "./ShipImage";
import type { AgentGameState, ShipModule } from "@/hooks/use-game-state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShipLoadoutProps {
  gameState: AgentGameState | null;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Panel({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("bg-card border border-border p-4 space-y-3", className)}>
      <h3 className="text-[10px] uppercase tracking-wider text-foreground/70 border-b border-border pb-2">
        {title}
      </h3>
      {children}
    </div>
  );
}

function PlaceholderNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-muted-foreground italic">
      {children}
    </p>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-muted-foreground italic py-3 text-center">
      {children}
    </div>
  );
}

const KNOWN_CATEGORIES = ["weapon", "defense", "utility"] as const;
const KNOWN_CATEGORY_SET = new Set<string>(KNOWN_CATEGORIES);

function ModuleSlotList({ modules }: { modules: ShipModule[] }) {
  const unclassified = modules.filter(
    (m) => !m.slot_type || !KNOWN_CATEGORY_SET.has(m.slot_type.toLowerCase())
  );
  return (
    <div className="space-y-3">
      {KNOWN_CATEGORIES.map((category) => {
        const modulesInCategory = modules.filter(
          (m) => m.slot_type?.toLowerCase() === category
        );
        const label =
          category === "weapon"
            ? "Weapons"
            : category === "defense"
              ? "Defense"
              : "Utility";
        return (
          <div key={category}>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
              {label}
            </div>
            {modulesInCategory.length > 0 ? (
              <div className="space-y-1">
                {modulesInCategory.map((mod, idx) => (
                  <div
                    key={idx}
                    className="bg-secondary/40 border border-border/50 px-2.5 py-1.5 text-[11px]"
                  >
                    <span className="text-foreground">
                      {formatModuleName(mod.item_name, mod.item_id)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState>No {category} modules equipped</EmptyState>
            )}
          </div>
        );
      })}
      {unclassified.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
            Unknown
          </div>
          <div className="space-y-1">
            {unclassified.map((mod, idx) => (
              <div
                key={idx}
                className="bg-secondary/40 border border-border/50 px-2.5 py-1.5 text-[11px]"
              >
                <span className="text-foreground">
                  {formatModuleName(mod.item_name, mod.item_id)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ShipLoadout({ gameState }: ShipLoadoutProps) {
  const ship = gameState?.ship ?? null;
  const [showLightbox, setShowLightbox] = useState(false);

  if (!ship) {
    return (
      <div className="text-muted-foreground text-sm italic py-8 text-center">
        No ship data available.
      </div>
    );
  }

  // Build cargo items list from cargo_used (we only have aggregate from the API)
  const cargoFull = ship.cargo_used >= ship.cargo_capacity;

  return (
    <>
      <div className="space-y-4">
        {/* Ship header with image */}
        <div className="border-b border-border pb-4 flex items-start gap-4">
          <div>
            <div className="text-lg font-semibold text-foreground">{ship.name}</div>
            {ship.class && (
              <div className="text-xs text-muted-foreground uppercase tracking-wider mt-0.5">
                {ship.class}
              </div>
            )}
          </div>
          {ship.class && (
            <>
              {/* Smaller on mobile, large on desktop */}
              <div className="md:hidden">
                <button
                  data-testid="open-lightbox"
                  onClick={() => setShowLightbox(true)}
                  className="block cursor-pointer bg-transparent border-0 p-0"
                  aria-label="View ship image"
                >
                  <ShipImage
                    shipClass={ship.class}
                    size="thumbnail"
                    alt={`${ship.name} ship`}
                    rounded="md"
                  />
                </button>
              </div>
              <div className="hidden md:block">
                <button
                  data-testid="open-lightbox"
                  onClick={() => setShowLightbox(true)}
                  className="block cursor-pointer bg-transparent border-0 p-0"
                  aria-label="View ship image"
                >
                  <ShipImage
                    shipClass={ship.class}
                    size="large"
                    alt={`${ship.name} ship`}
                    rounded="md"
                  />
                </button>
              </div>
            </>
          )}
        </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Ship vitals */}
        <Panel title="Ship Vitals">
          <div className="space-y-2">
            <HealthBar label="Hull" value={ship.hull} max={ship.max_hull} />
            <HealthBar label="Shield" value={ship.shield} max={ship.max_shield} />
            <HealthBar label="Fuel" value={ship.fuel} max={ship.max_fuel} />
            <HealthBar label="Cargo" value={ship.cargo_used} max={ship.cargo_capacity} invert />
          </div>
          {cargoFull && (
            <div className="text-[10px] text-warning uppercase tracking-wider pt-1">
              Cargo hold full
            </div>
          )}
        </Panel>

        {/* Module slots */}
        <Panel title="Module Slots">
          {ship.modules && ship.modules.length > 0 ? (
            <ModuleSlotList modules={ship.modules} />
          ) : (
            <EmptyState>No module data available</EmptyState>
          )}
        </Panel>
      </div>

      {/* Cargo manifest */}
      <Panel title="Cargo Manifest">
        <div className="flex items-center justify-between text-xs mb-3">
          <span className="text-muted-foreground">
            {ship.cargo_used} / {ship.cargo_capacity} units used
          </span>
          <span
            className={cn(
              "font-mono tabular-nums",
              cargoFull ? "text-warning" : "text-muted-foreground"
            )}
          >
            {ship.cargo_capacity - ship.cargo_used} free
          </span>
        </div>
        {ship.cargo && ship.cargo.length > 0 ? (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {ship.cargo.map((item, idx) => (
              <div key={idx} className="bg-secondary/40 border border-border/50 px-2.5 py-1.5 text-[11px] flex items-center justify-between">
                <span className="text-foreground flex-1">{getItemName(item.item_id, item.name)}</span>
                <span className="text-muted-foreground font-mono ml-2">x{item.quantity ?? 0}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState>Cargo hold is empty</EmptyState>
        )}
      </Panel>

      {/* Skills */}
      <Panel title="Skills">
        {Object.keys(gameState?.skills ?? {}).length > 0 ? (
          <div className="space-y-3">
            {Object.entries(gameState?.skills ?? {}).map(([skillKey, skillData]) => {
              const skillName = skillData.name || skillKey;
              const level = skillData.level ?? 0;
              const xp = skillData.xp ?? 0;
              const xpToNext = skillData.xp_to_next ?? 0;
              const progressPercent = xpToNext > 0 ? Math.min((xp / xpToNext) * 100, 100) : 0;
              return (
                <div key={skillKey} className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-foreground capitalize">{skillName}</span>
                    <span className="text-muted-foreground font-mono">Lvl {level}</span>
                  </div>
                  <div className="bg-secondary/40 border border-border/50 h-2 rounded overflow-hidden">
                    <div
                      className="bg-primary h-full transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  {xpToNext > 0 && (
                    <div className="text-[10px] text-muted-foreground text-right">
                      {xp} / {xpToNext} XP
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState>No skills unlocked</EmptyState>
        )}
      </Panel>
      </div>

      {/* Lightbox modal for fullscreen ship image */}
      {showLightbox && ship.class && (
        <div
          className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4"
          onClick={() => setShowLightbox(false)}
        >
          <div
            className="relative flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <ShipImage
              shipClass={ship.class}
              size="xlarge"
              alt={`${ship.name} ship`}
              rounded="lg"
            />
            <button
              onClick={() => setShowLightbox(false)}
              className="absolute top-2 right-2 bg-black/50 hover:bg-black/75 text-white p-2 rounded transition-colors"
              aria-label="Close lightbox"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  );
}
