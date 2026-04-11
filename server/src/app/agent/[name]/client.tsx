"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Play, Square, RotateCw, Power, Settings, Save, Loader2 } from "lucide-react";
import { cn, formatModuleName, formatCredits } from "@/lib/utils";
import { getAgentDisplayState } from "@/lib/agent-display-state";
import { getProxyStatusText } from "@/lib/proxy-status";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { useFleetStatus } from "@/hooks/use-fleet-status";
import { useGameState, type ShipModule } from "@/hooks/use-game-state";
import { ShipImage } from "@/components/ShipImage";
import { ShipLoadout } from "@/components/ship-loadout";
import { ShipComparison, type ShipStats } from "@/app/components/ShipComparison";
import { EconomyPanel } from "@/components/economy-panel";
import { ToolCallFeed } from "@/components/tool-call-feed";
import { LogStream } from "@/components/log-stream";
import { DiaryViewer } from "@/components/diary-viewer";
import { PromptViewer } from "@/components/prompt-viewer";
import { GalaxyMap } from "@/components/galaxy-map";
import { StatusBadge } from "@/components/status-badge";
import { ControlsPanel } from "@/components/controls-panel";
import { AgentControls as AgentControlsPanel } from "@/components/agent-controls";
import { SurvivabilityPanel } from "@/components/survivability-panel";
import { LifetimeStatsPanel } from "../lifetime-stats";

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = "ship" | "modules" | "economy" | "activity" | "logs" | "prompt" | "map" | "thoughts" | "survivability" | "lifetime-stats" | "config" | "controls";

const TABS: { id: TabId; label: string; adminOnly?: boolean }[] = [
  { id: "ship", label: "Ship & Loadout" },
  { id: "modules", label: "Modules" },
  { id: "economy", label: "Economy" },
  { id: "activity", label: "Activity" },
  { id: "logs", label: "Logs & Diary" },
  { id: "thoughts", label: "Thoughts" },
  { id: "prompt", label: "Prompt" },
  { id: "map", label: "Live Map" },
  { id: "survivability", label: "Survivability" },
  { id: "lifetime-stats", label: "Lifetime Stats" },
  { id: "controls", label: "Controls", adminOnly: true },
  { id: "config", label: "Config", adminOnly: true },
];

// ---------------------------------------------------------------------------
// Modules Panel (#229)
// ---------------------------------------------------------------------------

function ModulesPanel({ gameState }: { gameState: import("@/hooks/use-game-state").AgentGameState | null }) {
  const ship = gameState?.ship ?? null;
  const skills = gameState?.skills ?? {};

  const MODULE_CATEGORIES = [
    { key: "weapon", label: "Weapons", color: "text-error" },
    { key: "defense", label: "Defense", color: "text-info" },
    { key: "utility", label: "Utility", color: "text-warning" },
  ] as const;

  const hasModules = ship?.modules && ship.modules.length > 0;
  const hasSkills = Object.keys(skills).length > 0;

  if (!hasModules && !hasSkills) {
    return (
      <div className="text-muted-foreground text-sm italic py-8 text-center">
        No module or skill data available.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Ship Modules */}
      {hasModules && (
        <div className="bg-card border border-border p-4 space-y-4">
          <h3 className="text-[10px] uppercase tracking-wider text-foreground/70 border-b border-border pb-2">
            Equipped Modules
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {MODULE_CATEGORIES.map(({ key, label, color }) => {
              const mods = ship!.modules.filter(
                (m: ShipModule) => m.slot_type?.toLowerCase() === key
              );
              return (
                <div key={key}>
                  <div className={cn("text-[10px] uppercase tracking-wider mb-2", color)}>
                    {label} ({mods.length})
                  </div>
                  {mods.length > 0 ? (
                    <div className="space-y-1.5">
                      {mods.map((mod: ShipModule, idx: number) => (
                        <div
                          key={idx}
                          className="bg-secondary/40 border border-border/50 px-3 py-2 text-[11px]"
                        >
                          <div className="text-foreground font-medium">
                            {formatModuleName(mod.item_name, mod.item_id)}
                          </div>
                          {mod.item_id && mod.item_name && (
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {mod.item_id}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground italic py-2">
                      No {label.toLowerCase()} equipped
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Uncategorized modules */}
          {(() => {
            const knownTypes = new Set<string>(MODULE_CATEGORIES.map((c) => c.key));
            const uncategorized = ship!.modules.filter(
              (m: ShipModule) => !m.slot_type || !knownTypes.has(m.slot_type.toLowerCase())
            );
            if (uncategorized.length === 0) return null;
            return (
              <div className="mt-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                  Other ({uncategorized.length})
                </div>
                <div className="space-y-1.5">
                  {uncategorized.map((mod: ShipModule, idx: number) => (
                    <div
                      key={idx}
                      className="bg-secondary/40 border border-border/50 px-3 py-2 text-[11px]"
                    >
                      <div className="text-foreground">
                        {formatModuleName(mod.item_name, mod.item_id)}
                      </div>
                      {mod.slot_type && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          Type: {mod.slot_type}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Skills */}
      {hasSkills && (
        <div className="bg-card border border-border p-4 space-y-4">
          <h3 className="text-[10px] uppercase tracking-wider text-foreground/70 border-b border-border pb-2">
            Agent Skills
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.entries(skills).map(([skillKey, skillData]) => {
              const skillName = skillData.name || skillKey;
              const level = skillData.level ?? 0;
              const xp = skillData.xp ?? 0;
              const xpToNext = skillData.xp_to_next ?? 0;
              const progressPercent = xpToNext > 0 ? Math.min((xp / xpToNext) * 100, 100) : 0;
              return (
                <div
                  key={skillKey}
                  className="bg-secondary/40 border border-border/50 px-3 py-2.5"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] text-foreground capitalize font-medium">
                      {skillName}
                    </span>
                    <span className="text-[10px] text-primary font-mono">
                      Lvl {level}
                    </span>
                  </div>
                  <div className="bg-background border border-border/30 h-2 rounded overflow-hidden">
                    <div
                      className="bg-primary h-full transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  {xpToNext > 0 && (
                    <div className="text-[9px] text-muted-foreground text-right mt-1">
                      {xp.toLocaleString()} / {xpToNext.toLocaleString()} XP
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ship Comparison Panel
// ---------------------------------------------------------------------------

/**
 * Shows stat deltas between the agent's current ship and a user-selected target.
 * Target ships are searched via /api/catalog?search=<class>.
 */
function ShipComparisonPanel({ gameState }: { gameState: import("@/hooks/use-game-state").AgentGameState | null }) {
  const ship = gameState?.ship ?? null;
  const [targetClass, setTargetClass] = useState("");
  const [targetShip, setTargetShip] = useState<ShipStats | null>(null);
  const [searching, setSearching] = useState(false);

  const currentStats: ShipStats | null = ship
    ? {
        name: ship.name,
        class_id: ship.class,
        hull: ship.max_hull,
        cargo_capacity: ship.cargo_capacity,
        fuel: ship.max_fuel,
      }
    : null;

  const searchTarget = useCallback(async () => {
    if (!targetClass.trim()) return;
    setSearching(true);
    setTargetShip(null);
    try {
      const res = await fetch(`/api/catalog?type=item&search=${encodeURIComponent(targetClass)}`);
      if (res.ok) {
        const body = await res.json() as { items?: Array<{ id: string; name: string; type?: string }> };
        // Match ship classes — items with type containing "ship" or matching the class name
        const shipItem = body.items?.find(i => i.type?.toLowerCase().includes("ship") || i.name.toLowerCase().includes(targetClass.toLowerCase()));
        if (shipItem) {
          // Use the item name as the ship name; hull/cargo are not in item catalog
          setTargetShip({ name: shipItem.name, class_id: shipItem.id });
        } else if (body.items && body.items.length > 0) {
          setTargetShip({ name: body.items[0].name, class_id: body.items[0].id });
        }
      }
    } catch {
      // ignore
    } finally {
      setSearching(false);
    }
  }, [targetClass]);

  if (!currentStats) return null;

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <h3 className="text-[10px] uppercase tracking-wider text-foreground/70 border-b border-border pb-2">
        Ship Comparison
      </h3>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={targetClass}
          onChange={(e) => setTargetClass(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && searchTarget()}
          placeholder="Target ship class or name…"
          className="flex-1 bg-secondary border border-border text-foreground text-[11px] px-2 py-1.5 placeholder:text-muted-foreground focus:outline-none focus:border-primary"
        />
        <button
          onClick={searchTarget}
          disabled={searching || !targetClass.trim()}
          className="px-3 py-1.5 text-[10px] uppercase tracking-wider bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {searching ? "…" : "Compare"}
        </button>
      </div>
      {targetShip && (
        <ShipComparison current={currentStats} target={targetShip} />
      )}
      {!targetShip && !searching && targetClass && (
        <div className="text-[11px] text-muted-foreground italic">
          No matching ship found in item registry. Try a catalog action in the game first.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model Selector
// ---------------------------------------------------------------------------

const CLAUDE_MODELS = ["haiku", "sonnet", "opus"];
const CODEX_MODELS = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5-codex-mini"];
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.5-pro"];

function getModelsForBackend(backend: string): string[] {
  switch (backend) {
    case "claude": return CLAUDE_MODELS;
    case "codex": return CODEX_MODELS;
    case "gemini": return GEMINI_MODELS;
    default: return [];
  }
}

function ModelSelector({ value, onChange, backend }: { value: string; onChange: (v: string) => void; backend: string }) {
  const knownModels = getModelsForBackend(backend);
  const isCustom = value !== "" && !knownModels.includes(value);
  const [showCustom, setShowCustom] = useState(isCustom);

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === "__custom__") {
      setShowCustom(true);
      onChange("");
    } else {
      setShowCustom(false);
      onChange(v);
    }
  };

  const selectValue = showCustom ? "__custom__" : (value || "");

  return (
    <div className="space-y-1.5">
      <select
        value={selectValue}
        onChange={handleSelectChange}
        className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-primary outline-none text-foreground"
      >
        <option value="">-- select model --</option>
        {knownModels.map(m => (
          <option key={m} value={m}>{m}</option>
        ))}
        <option value="__custom__">custom…</option>
      </select>
      {showCustom && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. claude-3-5-haiku-20241022"
          className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-primary outline-none font-mono text-foreground"
          autoFocus
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config Panel
// ---------------------------------------------------------------------------

function AgentConfigPanel({
  agentName,
  currentBackend,
  currentModel,
  isRunning,
  roleType,
  skillModules,
  operatingZone,
  factionNote,
}: {
  agentName: string;
  currentBackend?: string;
  currentModel?: string;
  isRunning: boolean;
  roleType?: string;
  skillModules?: string[];
  operatingZone?: string;
  factionNote?: string;
}) {
  const [backend, setBackend] = useState(currentBackend || "claude");
  const [model, setModel] = useState(currentModel || "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

  const BACKENDS = ["claude", "codex", "gemini"];

  async function handleSave() {
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/agents/${agentName}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend, model }),
      });
      setMessage({ type: 'success', text: 'Configuration updated successfully' });
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error).message || 'Failed to update configuration' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 max-w-xl">
      {/* Role metadata display (#213a) */}
      {(roleType || skillModules?.length || operatingZone || factionNote) && (
        <div className="bg-card border border-border p-4 space-y-3">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            <h3 className="text-sm font-bold uppercase tracking-wider text-foreground/80">Role & Assignment</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            {roleType && (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Role Type</div>
                <span className="px-2 py-0.5 text-xs font-medium border bg-secondary text-foreground border-border">
                  {roleType}
                </span>
              </div>
            )}
            {operatingZone && (
              <div>
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Operating Zone</div>
                <span className="font-mono text-foreground">{operatingZone}</span>
              </div>
            )}
            {skillModules && skillModules.length > 0 && (
              <div className="sm:col-span-2">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Skill Modules</div>
                <div className="flex flex-wrap gap-1.5">
                  {skillModules.map((mod) => (
                    <span key={mod} className="px-1.5 py-0.5 text-[10px] bg-secondary border border-border text-foreground/80">
                      {mod}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {factionNote && (
              <div className="sm:col-span-2">
                <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1">Faction Note</div>
                <p className="text-foreground/80 italic">{factionNote}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="bg-card border border-border p-4 space-y-4">
      <div className="flex items-center gap-2 border-b border-border pb-2">
        <Settings className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-bold uppercase tracking-wider text-foreground/80">Agent Configuration</h3>
      </div>

      {isRunning ? (
        <div className="bg-warning/10 border border-warning/30 p-3 text-xs text-warning-foreground rounded">
          Agent is currently running. Stop it before changing configuration.
        </div>
      ) : (
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                Backend Provider
              </label>
              <select
                value={backend}
                onChange={(e) => setBackend(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm focus:ring-1 focus:ring-primary outline-none text-foreground"
              >
                {BACKENDS.map(b => (
                  <option key={b} value={b}>{b.charAt(0).toUpperCase() + b.slice(1)}</option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                Model
              </label>
              <ModelSelector value={model} onChange={setModel} backend={backend} />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 pt-2">
            <div className="min-w-0">
              {message && (
                <div className={cn(
                  "text-[11px] font-medium",
                  message.type === 'success' ? "text-success" : "text-error"
                )}>
                  {message.text}
                </div>
              )}
            </div>
            <button
              onClick={handleSave}
              disabled={busy || (backend === currentBackend && model === currentModel)}
              className="flex items-center gap-2 px-4 py-1.5 bg-primary text-primary-foreground text-xs font-bold rounded hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed shrink-0 shadow-sm"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              SAVE CHANGES
            </button>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thoughts Panel
// ---------------------------------------------------------------------------

function ThoughtsPanel({ agentName }: { agentName: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ content: string }>(`/notes/${agentName}/thoughts`)
      .then((data) => {
        if (!cancelled) {
          setContent(data.content ?? "");
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load thoughts");
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [agentName]);

  if (loading) {
    return <div className="py-16 text-center text-muted-foreground text-sm">Loading…</div>;
  }
  if (error) {
    return <div className="py-16 text-center text-destructive text-sm">{error}</div>;
  }
  if (!content) {
    return (
      <div className="py-16 text-center text-muted-foreground text-sm italic">
        No thoughts yet. The agent will start writing here before logout.
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">{content}</pre>
    </div>
  );
}

function PlaceholderTab({ label }: { label: string }) {
  return (
    <div className="py-16 text-center text-muted-foreground text-sm italic">
      {label} — coming soon
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client Component
// ---------------------------------------------------------------------------

function AgentControls({ name, agent }: { name: string; agent: import("@/hooks/use-fleet-status").AgentStatus | null }) {
  const [busy, setBusy] = useState<string | null>(null);

  const isRunning = agent?.llmRunning ?? false;
  const llmRunning = isRunning;
  const shutdownState = agent?.shutdownState ?? "none";

  async function doAction(action: string, method: string = "POST", body?: unknown) {
    setBusy(action);
    try {
      await apiFetch(`/agents/${name}/${action}`, {
        method,
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      console.error(`Failed to ${action}:`, err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {!isRunning ? (
          <button
            onClick={() => doAction("start")}
            disabled={busy !== null}
            className="p-1.5 text-success hover:bg-success/10 transition-colors disabled:opacity-50"
            title="Start"
          >
            <Play className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={() => doAction("stop")}
            disabled={busy !== null}
            className="p-1.5 text-error hover:bg-error/10 transition-colors disabled:opacity-50"
            title="Stop"
          >
            <Square className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={() => doAction("restart")}
          disabled={busy !== null}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          title="Restart"
        >
          <RotateCw className="w-4 h-4" />
        </button>
        {shutdownState === "none" && llmRunning && (
          <button
            onClick={() => doAction("shutdown", "POST", { reason: "User initiated" })}
            disabled={busy !== null}
            className="flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded border border-error/30 bg-error/5 text-error hover:bg-error hover:text-white hover:border-error transition-all shadow-sm ml-1"
            title="Initiate graceful shutdown"
          >
            <Power className="w-3.5 h-3.5" />
            <span>SHUTDOWN</span>
          </button>
        )}
      </div>

    </div>
  );
}

export function AgentDetailClient() {
  const params = useParams();
  const router = useRouter();
  const { isAdmin } = useAuth();
  const name = Array.isArray(params.name) ? params.name[0] : (params.name ?? "");

  // Overseer has its own dedicated page
  useEffect(() => {
    if (name === "overseer") router.replace("/overseer");
  }, [name, router]);

  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (typeof window === "undefined") return "ship";
    const hash = window.location.hash.slice(1);
    return TABS.some(t => t.id === hash) ? (hash as TabId) : "ship";
  });

  function switchTab(id: TabId) {
    setActiveTab(id);
    window.history.replaceState(null, "", `#${id}`);
  }

  const { data: fleetStatus } = useFleetStatus();
  const { data: gameStates } = useGameState();

  const agent = fleetStatus?.agents.find((a) => a.name === name) ?? null;
  const gameState = gameStates?.[name] ?? null;
  const ship = gameState?.ship ?? null;

  const handleSystemClick = (systemId: string) => {
    router.push(`/map?system=${systemId}`);
  };

  return (
    <div className="space-y-0">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-1.5 text-xs mb-4 text-muted-foreground">
        <Link href="/" className="hover:text-foreground transition-colors">
          Dashboard
        </Link>
        <span className="opacity-40">›</span>
        <span>Agent</span>
        <span className="opacity-40">›</span>
        <span className="text-primary font-medium">{name}</span>
      </nav>

      {/* Header bar */}
      <div className="bg-card border border-border p-3 md:p-4 mb-4">
        <div className="flex flex-wrap items-start justify-between gap-3 md:gap-4">
          {/* Left: ship image, name, ship, location */}
          <div className="flex items-start gap-3 md:gap-4 min-w-0">
            {ship && ship.class && (
              <div className="hidden sm:block">
                <ShipImage
                  shipClass={ship.class}
                  size="medium"
                  alt={`${name}'s ship`}
                  lazy={false}
                />
              </div>
            )}
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg md:text-xl font-bold text-primary">{name}</h1>
                {agent && (
                  <StatusBadge 
                    state={getAgentDisplayState(agent)} 
                    size="sm" 
                    subLabel={getProxyStatusText(agent)}
                  />
                )}
                {agent?.role && (
                  <span className="text-[10px] uppercase tracking-wider text-primary bg-primary/10 px-1.5 py-0.5">
                    {agent.role}
                  </span>
                )}
              </div>

              {/* Ship class */}
              {ship && (
                <div className="text-xs text-muted-foreground">
                  <span className="text-foreground">{ship.name}</span>
                  {ship.class && (
                    <span className="ml-1.5">({ship.class})</span>
                  )}
                </div>
              )}

              {/* Location */}
              {gameState?.current_system && (
                <div className="text-xs text-muted-foreground">
                  <span>{gameState.current_system}</span>
                  {gameState.current_poi && (
                    <span> · {gameState.current_poi}</span>
                  )}
                  {gameState.docked_at_base && (
                    <span className="ml-1.5 text-success opacity-80">[docked]</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right: credits + health score + controls — min-w prevents layout shift when controls appear */}
          <div className="flex items-center gap-4 md:gap-6 shrink-0 min-w-[120px] justify-end">
            {gameState && (
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Credits
                </div>
                <div className="font-mono text-sm text-foreground">
                  {formatCredits(gameState.credits)}
                </div>
              </div>
            )}

            {agent?.healthScore !== null && agent?.healthScore !== undefined && agent?.state !== 'stopped' && agent?.state !== 'dead' && (
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Agent Health
                </div>
                <div
                  className={cn(
                    "font-mono text-sm tabular-nums",
                    agent.healthScore > 60
                      ? "text-success"
                      : agent.healthScore > 30
                      ? "text-warning"
                      : "text-error"
                  )}
                >
                  {agent.healthScore}%
                </div>
              </div>
            )}

            {isAdmin && agent && (
              <div className="border-l border-border pl-3 md:pl-4">
                <AgentControls name={name} agent={agent} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tab navigation — horizontally scrollable on mobile with fade edge indicators */}
      <div
        className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{
          WebkitOverflowScrolling: "touch",
          maskImage: "linear-gradient(to right, transparent 0px, black 16px, black calc(100% - 16px), transparent 100%)",
          WebkitMaskImage: "linear-gradient(to right, transparent 0px, black 16px, black calc(100% - 16px), transparent 100%)",
        }}
      >
        <div className="flex gap-0 border-b border-border min-w-max">
          {TABS.filter(t => !t.adminOnly || isAdmin).map((tab) => (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={cn(
                "px-3 md:px-4 py-2 text-xs uppercase tracking-wider cursor-pointer transition-colors whitespace-nowrap",
                activeTab === tab.id
                  ? "text-primary border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-primary/5"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="pt-4">
        {activeTab === "ship" && (
          <div className="space-y-4">
            <ShipLoadout gameState={gameState} />
            <ShipComparisonPanel gameState={gameState} />
          </div>
        )}
        {activeTab === "modules" && <ModulesPanel gameState={gameState} />}
        {activeTab === "economy" && <EconomyPanel agentName={name} />}
        {activeTab === "activity" && <ToolCallFeed key={name} agentName={name} />}
        {activeTab === "logs" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-auto md:h-[calc(100vh-350px)]">
            <div className="h-[50vh] md:h-full">
              <LogStream agentName={name} />
            </div>
            <div className="h-[50vh] md:h-full">
              <DiaryViewer agentName={name} />
            </div>
          </div>
        )}
        {activeTab === "thoughts" && <ThoughtsPanel agentName={name} />}
        {activeTab === "prompt" && <PromptViewer agentName={name} />}
        {activeTab === "map" && (
          <div className="p-0 md:p-4">
            <GalaxyMap
              highlightSystem={gameState?.current_system ?? null}
              highlightAgent={name}
              onSystemClick={handleSystemClick}
              height={500}
            />
          </div>
        )}
        {activeTab === "survivability" && (
          <SurvivabilityPanel
            agentName={name}
            currentSystem={gameState?.current_system ?? null}
          />
        )}
        {activeTab === "lifetime-stats" && (
          gameState?.lifetime_stats
            ? <LifetimeStatsPanel stats={gameState.lifetime_stats} />
            : <div className="py-16 text-center text-muted-foreground text-sm italic">
                Lifetime stats not available — requires game v0.253+ and a status refresh.
              </div>
        )}
        {activeTab === "controls" && isAdmin && (
          <div className="space-y-6">
            <AgentControlsPanel agentName={name} agent={agent} />
            <ControlsPanel agentName={name} />
          </div>
        )}
        {activeTab === "config" && isAdmin && agent && (
          <AgentConfigPanel
            agentName={name}
            currentBackend={agent.backend?.includes('/') ? agent.backend.split('/')[0] : agent.backend}
            currentModel={agent.model}
            isRunning={agent.llmRunning}
            roleType={agent.roleType}
            skillModules={agent.skillModules}
            operatingZone={agent.operatingZone}
            factionNote={agent.factionNote}
          />
        )}
      </div>
    </div>
  );
}
