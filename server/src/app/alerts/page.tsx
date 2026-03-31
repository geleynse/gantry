"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, RefreshCw, CheckCheck, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { relativeTime } from "@/lib/time";
import { getSeverityClasses, sortAlerts, filterAlerts } from "./helpers";
import type { Severity } from "./helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentAlert {
  id: number;
  agent: string;
  severity: string;
  category: string | null;
  message: string;
  acknowledged: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold shrink-0",
        getSeverityClasses(severity)
      )}
    >
      {severity}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Alert row
// ---------------------------------------------------------------------------

function AlertRow({
  alert,
  onAcknowledge,
}: {
  alert: AgentAlert;
  onAcknowledge: (id: number) => void;
}) {
  const [acking, setAcking] = useState(false);

  const handleAck = async () => {
    setAcking(true);
    try {
      await apiFetch(`/alerts/${alert.id}/acknowledge`, { method: "POST" });
      onAcknowledge(alert.id);
    } catch {
      // non-fatal, badge will still show
    } finally {
      setAcking(false);
    }
  };

  return (
    <div
      className={cn(
        "flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-b-0 transition-colors",
        alert.acknowledged
          ? "opacity-40 hover:opacity-60"
          : "hover:bg-secondary/20"
      )}
    >
      {/* Severity badge */}
      <div className="shrink-0 pt-0.5">
        <SeverityBadge severity={alert.severity} />
      </div>

      {/* Agent */}
      <div className="w-24 shrink-0 pt-0.5">
        <span className="text-[11px] font-mono text-foreground">{alert.agent}</span>
      </div>

      {/* Category */}
      <div className="w-24 shrink-0 pt-0.5">
        {alert.category ? (
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {alert.category}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/40">—</span>
        )}
      </div>

      {/* Message */}
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-xs text-foreground leading-relaxed break-words">{alert.message}</p>
        {alert.acknowledged && alert.acknowledged_by && (
          <p className="text-[10px] text-muted-foreground mt-0.5">
            Ack'd by {alert.acknowledged_by}
            {alert.acknowledged_at && ` · ${relativeTime(alert.acknowledged_at)}`}
          </p>
        )}
      </div>

      {/* Timestamp */}
      <div className="shrink-0 text-right pt-0.5">
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {relativeTime(alert.created_at)}
        </span>
      </div>

      {/* Acknowledge button */}
      {!alert.acknowledged && (
        <div className="shrink-0">
          <button
            onClick={handleAck}
            disabled={acking}
            title="Acknowledge"
            className={cn(
              "flex items-center justify-center w-6 h-6 text-muted-foreground transition-colors",
              "hover:bg-secondary hover:text-foreground",
              acking && "opacity-50 cursor-not-allowed"
            )}
          >
            {acking ? (
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      )}

      {/* Spacer when acknowledged (to keep alignment) */}
      {alert.acknowledged && <div className="w-6 shrink-0" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const AUTO_REFRESH_MS = 15_000;
const SEVERITY_OPTIONS = ["all", "critical", "error", "warning", "info"] as const;

export default function AlertsPage() {
  const [allAlerts, setAllAlerts] = useState<AgentAlert[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [severityFilter, setSeverityFilter] = useState<string>("all");
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [ackingAll, setAckingAll] = useState(false);

  const fetchAlerts = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await apiFetch<AgentAlert[]>("/alerts");
      const sorted = sortAlerts(data);
      setAllAlerts(sorted);
      setLastRefresh(new Date());

      // Build agent list from data
      const seen = new Set<string>();
      data.forEach((a) => seen.add(a.agent));
      setAgents(Array.from(seen).sort());
    } catch {
      // non-fatal
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load + auto-refresh
  useEffect(() => {
    fetchAlerts();
    const id = setInterval(fetchAlerts, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  const handleAcknowledge = (id: number) => {
    setAllAlerts((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, acknowledged: 1, acknowledged_by: "operator", acknowledged_at: new Date().toISOString() } : a
      )
    );
  };

  const handleAcknowledgeAll = async () => {
    setAckingAll(true);
    try {
      const params = agentFilter !== "all" ? `?agent=${encodeURIComponent(agentFilter)}` : "";
      await apiFetch(`/alerts/acknowledge-all${params}`, { method: "POST" });
      await fetchAlerts();
    } catch {
      // non-fatal
    } finally {
      setAckingAll(false);
    }
  };

  // Apply filters
  const filtered = filterAlerts(allAlerts, agentFilter, severityFilter);

  const pending = filtered.filter((a) => !a.acknowledged);
  const acknowledged = filtered.filter((a) => a.acknowledged);

  const hasPending = pending.length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-primary/20 pb-4">
        <div>
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            Alerts
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Agent-filed alerts requiring operator attention.
            {hasPending && (
              <span className="ml-2 text-error font-semibold">{pending.length} pending</span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Agent filter */}
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            className="bg-secondary border border-border text-xs text-foreground px-2 py-1 focus:outline-none focus:border-primary"
          >
            <option value="all">All agents</option>
            {agents.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>

          {/* Severity filter */}
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="bg-secondary border border-border text-xs text-foreground px-2 py-1 focus:outline-none focus:border-primary"
          >
            {SEVERITY_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === "all" ? "All severities" : s}</option>
            ))}
          </select>

          {/* Ack all */}
          {hasPending && (
            <button
              onClick={handleAcknowledgeAll}
              disabled={ackingAll}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1 text-[10px] uppercase tracking-wider transition-colors",
                "bg-secondary hover:bg-secondary/80 text-foreground border border-border",
                ackingAll && "opacity-50 cursor-not-allowed"
              )}
            >
              {ackingAll ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : (
                <CheckCheck className="w-3 h-3" />
              )}
              Acknowledge All
            </button>
          )}

          {lastRefresh && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {lastRefresh.toLocaleTimeString()}
            </span>
          )}

          <button
            onClick={fetchAlerts}
            disabled={isLoading}
            title="Refresh"
            className={cn(
              "p-1.5 text-foreground hover:bg-secondary transition-colors",
              isLoading && "opacity-50 cursor-not-allowed"
            )}
          >
            <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      {/* Content */}
      {isLoading && allAlerts.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">Loading alerts...</div>
      ) : pending.length === 0 && acknowledged.length === 0 ? (
        <div className="text-center py-20">
          <AlertTriangle className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No alerts — fleet is operating normally</p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Pending alerts */}
          {pending.length > 0 && (
            <div className="bg-card border border-border">
              <div className="px-4 py-2.5 border-b border-border bg-secondary/30 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider font-semibold text-foreground">
                  Pending
                </span>
                <span className="text-[10px] text-error font-semibold">{pending.length}</span>
              </div>
              <div>
                {pending.map((alert) => (
                  <AlertRow key={alert.id} alert={alert} onAcknowledge={handleAcknowledge} />
                ))}
              </div>
            </div>
          )}

          {/* Empty pending state (when filters active but nothing pending) */}
          {pending.length === 0 && allAlerts.some((a) => !a.acknowledged) && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No pending alerts match current filters
            </div>
          )}

          {/* Acknowledged section toggle */}
          {acknowledged.length > 0 && (
            <div>
              <button
                onClick={() => setShowAcknowledged((v) => !v)}
                className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors mb-2"
              >
                {showAcknowledged ? (
                  <X className="w-3 h-3" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                {showAcknowledged ? "Hide" : "Show"} acknowledged ({acknowledged.length})
              </button>

              {showAcknowledged && (
                <div className="bg-card border border-border opacity-60">
                  <div className="px-4 py-2.5 border-b border-border bg-secondary/30">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                      Acknowledged
                    </span>
                  </div>
                  <div>
                    {acknowledged.map((alert) => (
                      <AlertRow key={alert.id} alert={alert} onAcknowledge={handleAcknowledge} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
