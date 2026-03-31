"use client";

/**
 * SurvivabilityPanel — agent threat/cloak status panel.
 *
 * Fetches from three endpoints:
 *   GET /api/survivability/threat/:system   — system threat level
 *   GET /api/survivability/policy/:agent    — cloak policy + override
 *   GET /api/survivability/mods/:agent      — mod recommendations
 *
 * And optionally from:
 *   GET /api/survivability/cloak-stats      — 24h activation stats
 *
 * Admin-only: toggle cloak override via POST /api/survivability/cloak-policy
 */

import { useEffect, useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ThreatLevel = "safe" | "low" | "medium" | "high" | "extreme";

interface ThreatData {
  system: string;
  level: ThreatLevel;
  score: number;
  reasons: string[];
}

interface PolicyData {
  agent: string;
  roleType: string | null;
  role: string | null;
  autoCloakEnabled: boolean;
  override: boolean | null;
}

interface ModRecommendation {
  mod_type: string;
  priority: number | string;
  reason?: string;
}

interface ModsData {
  agent: string;
  roleType: string | null;
  recommendations: ModRecommendation[];
}

interface AgentCloakStat {
  agent: string;
  cloakActivations: number;
  threatsDetected: number;
  threatsAvoided: number;
}

interface CloakStatsData {
  windowHours: number;
  stats: AgentCloakStat[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const THREAT_COLORS: Record<ThreatLevel, string> = {
  safe: "text-success",
  low: "text-success/80",
  medium: "text-warning",
  high: "text-orange-400",
  extreme: "text-error",
};

const THREAT_BG: Record<ThreatLevel, string> = {
  safe: "bg-success/10 border-success/30",
  low: "bg-success/5 border-success/20",
  medium: "bg-warning/10 border-warning/30",
  high: "bg-orange-500/10 border-orange-500/30",
  extreme: "bg-error/10 border-error/30",
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: "text-error",
  high: "text-orange-400",
  medium: "text-warning",
  low: "text-muted-foreground",
  // Numeric priorities from mod-policy.ts (1 = highest)
  "1": "text-error",
  "2": "text-orange-400",
  "3": "text-warning",
};

function ThreatBadge({ level }: { level: ThreatLevel }) {
  return (
    <span
      className={cn(
        "inline-block px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border",
        THREAT_COLORS[level],
        THREAT_BG[level],
      )}
    >
      {level}
    </span>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] uppercase tracking-wider text-foreground/60 border-b border-border pb-2 mb-3">
      {children}
    </h3>
  );
}

function LoadingPlaceholder({ label }: { label: string }) {
  return (
    <div className="text-[11px] text-muted-foreground italic py-2">
      Loading {label}…
    </div>
  );
}

function ErrorNote({ msg }: { msg: string }) {
  return (
    <div className="text-[11px] text-error/80 py-1">{msg}</div>
  );
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function ThreatPanel({ system, agentName }: { system: string | null; agentName: string }) {
  const [data, setData] = useState<ThreatData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!system) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<ThreatData>(`/survivability/threat/${encodeURIComponent(system)}?agent=${encodeURIComponent(agentName)}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [system, agentName]);

  if (!system) {
    return (
      <div className="text-[11px] text-muted-foreground italic py-2">
        Agent location unknown — no threat data.
      </div>
    );
  }

  return (
    <div>
      <SectionHeader>System Threat — {system}</SectionHeader>
      {loading && <LoadingPlaceholder label="threat" />}
      {error && <ErrorNote msg={`Failed to load threat: ${error}`} />}
      {data && (
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <ThreatBadge level={data.level} />
            <span className="text-[11px] text-muted-foreground font-mono">
              Score: {data.score}/100
            </span>
          </div>
          {data.reasons.length > 0 && (
            <ul className="space-y-0.5 pl-3">
              {data.reasons.map((r, i) => (
                <li key={i} className="text-[11px] text-muted-foreground list-disc list-inside">
                  {r}
                </li>
              ))}
            </ul>
          )}
          {data.reasons.length === 0 && (
            <div className="text-[11px] text-muted-foreground italic">No threat indicators.</div>
          )}
        </div>
      )}
    </div>
  );
}

function PolicyPanel({ agentName }: { agentName: string }) {
  const { isAdmin } = useAuth();
  const [data, setData] = useState<PolicyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<PolicyData>(`/survivability/policy/${encodeURIComponent(agentName)}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [agentName]);

  useEffect(load, [load]);

  async function handleToggle(enabled: boolean | null) {
    setToggling(true);
    try {
      await apiFetch(`/survivability/cloak-policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentName, enabled }),
      });
      load();
    } catch (e) {
      setError(String(e));
    } finally {
      setToggling(false);
    }
  }

  const overrideLabel =
    data?.override === true
      ? "Force-enabled"
      : data?.override === false
      ? "Force-disabled"
      : "Auto (role-based)";

  return (
    <div>
      <SectionHeader>Cloak Policy</SectionHeader>
      {loading && <LoadingPlaceholder label="policy" />}
      {error && <ErrorNote msg={`Failed to load policy: ${error}`} />}
      {data && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px]">
            <span className="text-muted-foreground">Auto-cloak fleet</span>
            <span className={data.autoCloakEnabled ? "text-success" : "text-muted-foreground"}>
              {data.autoCloakEnabled ? "Enabled" : "Disabled"}
            </span>
            <span className="text-muted-foreground">Role type</span>
            <span className="text-foreground capitalize">{data.roleType ?? data.role ?? "—"}</span>
            <span className="text-muted-foreground">Override</span>
            <span className={cn(
              data.override === true ? "text-success" :
              data.override === false ? "text-error" :
              "text-muted-foreground"
            )}>
              {overrideLabel}
            </span>
          </div>

          {isAdmin && (
            <div className="flex gap-2 pt-1 flex-wrap">
              <button
                onClick={() => handleToggle(true)}
                disabled={toggling || data.override === true}
                className="px-3 py-1 text-[10px] uppercase tracking-wider bg-success/10 border border-success/30 text-success hover:bg-success/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Force Enable
              </button>
              <button
                onClick={() => handleToggle(false)}
                disabled={toggling || data.override === false}
                className="px-3 py-1 text-[10px] uppercase tracking-wider bg-error/10 border border-error/30 text-error hover:bg-error/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Force Disable
              </button>
              <button
                onClick={() => handleToggle(null)}
                disabled={toggling || data.override === null}
                className="px-3 py-1 text-[10px] uppercase tracking-wider bg-secondary border border-border text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Clear Override
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModsPanel({ agentName }: { agentName: string }) {
  const [data, setData] = useState<ModsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<ModsData>(`/survivability/mods/${encodeURIComponent(agentName)}`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [agentName]);

  return (
    <div>
      <SectionHeader>Mod Recommendations</SectionHeader>
      {loading && <LoadingPlaceholder label="mods" />}
      {error && <ErrorNote msg={`Failed to load mods: ${error}`} />}
      {data && data.recommendations.length === 0 && (
        <div className="text-[11px] text-muted-foreground italic">No mod recommendations.</div>
      )}
      {data && data.recommendations.length > 0 && (
        <div className="space-y-1.5">
          {data.recommendations.map((rec, i) => (
            <div
              key={i}
              className="bg-secondary/40 border border-border/50 px-3 py-2 text-[11px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-foreground font-medium capitalize">
                  {rec.mod_type.replace(/_/g, " ")}
                </span>
                <span className={cn(
                  "text-[10px] uppercase tracking-wider font-bold",
                  PRIORITY_COLORS[String(rec.priority).toLowerCase()] ?? "text-muted-foreground"
                )}>
                  {rec.priority}
                </span>
              </div>
              {rec.reason && (
                <div className="text-[10px] text-muted-foreground mt-0.5">{rec.reason}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CloakStatsPanel({ agentName }: { agentName: string }) {
  const [data, setData] = useState<CloakStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<CloakStatsData>(`/survivability/cloak-stats`)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const agentStat = data?.stats.find((s) => s.agent === agentName);

  return (
    <div>
      <SectionHeader>Cloak Activity (last {data?.windowHours ?? 24}h)</SectionHeader>
      {loading && <LoadingPlaceholder label="cloak stats" />}
      {error && <ErrorNote msg={`Failed to load cloak stats: ${error}`} />}
      {data && !agentStat && (
        <div className="text-[11px] text-muted-foreground italic">No cloak activity recorded.</div>
      )}
      {agentStat && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Activations", value: agentStat.cloakActivations },
            { label: "Threats Detected", value: agentStat.threatsDetected },
            { label: "Threats Avoided", value: agentStat.threatsAvoided },
          ].map(({ label, value }) => (
            <div key={label} className="bg-secondary/40 border border-border/50 px-3 py-2 text-center">
              <div className="text-lg font-mono font-bold text-foreground">{value}</div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mt-0.5">
                {label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SurvivabilityPanelProps {
  agentName: string;
  currentSystem: string | null;
}

export function SurvivabilityPanel({ agentName, currentSystem }: SurvivabilityPanelProps) {
  return (
    <div className="space-y-6">
      {/* Threat assessment */}
      <div className="bg-card border border-border p-4">
        <ThreatPanel system={currentSystem} agentName={agentName} />
      </div>

      {/* Cloak policy */}
      <div className="bg-card border border-border p-4">
        <PolicyPanel agentName={agentName} />
      </div>

      {/* Cloak activation stats */}
      <div className="bg-card border border-border p-4">
        <CloakStatsPanel agentName={agentName} />
      </div>

      {/* Mod recommendations */}
      <div className="bg-card border border-border p-4">
        <ModsPanel agentName={agentName} />
      </div>
    </div>
  );
}
