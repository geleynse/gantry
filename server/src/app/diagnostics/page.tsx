"use client";

import { useEffect, useRef, useState } from "react";
import { useFleetStatus } from "@/hooks/use-fleet-status";
import { useAgentNames } from "@/hooks/use-agent-names";
import { cn } from "@/lib/utils";
import { RateLimitPanel } from "@/components/rate-limit-panel";
import { HealthMonitorPanel } from "@/components/health-monitor-panel";

// ---------------------------------------------------------------------------
// Sparkline — inline SVG polyline of up to 20 recent success-rate values
// ---------------------------------------------------------------------------

const MAX_HISTORY = 20;

function Sparkline({ data, successRate }: { data: number[]; successRate: number }) {
  if (data.length < 2) {
    return <span className="text-[10px] text-muted-foreground font-mono opacity-50">—</span>;
  }

  const W = 64, H = 18;
  const min = Math.max(0, Math.min(...data) - 5);
  const range = 100 - min || 1;

  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = H - ((v - min) / range) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const color =
    successRate >= 95 ? "#22c55e" : successRate >= 80 ? "#f59e0b" : "#ef4444";

  const lastX = W;
  const lastY = H - ((data[data.length - 1] - min) / range) * H;

  return (
    <svg width={W} height={H} className="inline-block align-middle overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.8"
      />
      <circle cx={lastX.toFixed(1)} cy={lastY.toFixed(1)} r="2" fill={color} />
    </svg>
  );
}

export default function DiagnosticsPage() {
  const { data: fleetStatus, connected } = useFleetStatus();
  const agentNames = useAgentNames();

  // Accumulate per-agent success rate history from SSE updates
  const historyRef = useRef<Record<string, number[]>>({});
  const [successHistory, setSuccessHistory] = useState<Record<string, number[]>>({});

  useEffect(() => {
    if (!fleetStatus) return;
    let changed = false;
    const next = { ...historyRef.current };
    for (const agent of fleetStatus.agents) {
      if (agent.errorRate?.successRate == null) continue;
      const rate = agent.errorRate.successRate;
      const prev = next[agent.name] ?? [];
      if (prev[prev.length - 1] !== rate) {
        next[agent.name] = [...prev.slice(-(MAX_HISTORY - 1)), rate];
        changed = true;
      }
    }
    if (changed) {
      historyRef.current = next;
      setSuccessHistory(next);
    }
  }, [fleetStatus]);

  if (!fleetStatus || !connected) {
    return (
      <div className="space-y-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
          Diagnostics
        </h1>
        <div className="text-muted-foreground">Loading health diagnostics...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
        Health Diagnostics
      </h1>

      <RateLimitPanel />
      <HealthMonitorPanel />

      <div className="space-y-4">
        {agentNames.map((agentName) => {
          const agent = fleetStatus.agents.find((a) => a.name === agentName);
          if (!agent) return null;

          const isStopped = agent.state === 'stopped';
          const isCrashedOrDead = agent.state === 'dead' || agent.state === 'unreachable';

          return (
            <div
              key={agentName}
              className={cn(
                "bg-card border p-4 rounded-sm space-y-3",
                isStopped
                  ? "border-border/50 opacity-60"
                  : isCrashedOrDead
                  ? "border-error/30"
                  : "border-border"
              )}
            >
              {/* Header */}
              <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
                <div className="flex items-center gap-2">
                  <span className={cn("font-semibold", isStopped ? "text-muted-foreground" : "text-foreground")}>{agent.name}</span>
                  <span
                    className={cn(
                      "inline-block w-2 h-2 rounded-full",
                      isStopped
                        ? "bg-muted-foreground/50"
                        : agent.connectionStatus === "connected"
                        ? "bg-success"
                        : isCrashedOrDead
                        ? "bg-error"
                        : "bg-muted-foreground"
                    )}
                  />
                  {isStopped && (
                    <span className="text-[10px] font-mono text-muted-foreground/70 uppercase">stopped</span>
                  )}
                </div>
                {isStopped ? (
                  <span className="text-sm font-mono text-muted-foreground">
                    — Agent Health
                  </span>
                ) : (
                  <span
                    className={cn(
                      "text-sm font-bold font-mono",
                      agent.healthScore > 60
                        ? "text-success"
                        : agent.healthScore > 30
                        ? "text-warning"
                        : "text-error"
                    )}
                  >
                    {agent.healthScore}% Agent Health
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                {/* Session Info */}
                <div className="space-y-2">
                  <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
                    Session
                  </h3>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Started</span>
                      <span className="font-mono text-foreground">
                        {agent.sessionStartedAt
                          ? new Date(agent.sessionStartedAt).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Last Tool Call</span>
                      <span className="font-mono text-foreground">
                        {agent.lastToolCallAt
                          ? new Date(agent.lastToolCallAt).toLocaleString()
                          : "—"}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Total Turns</span>
                      <span className="font-mono text-foreground">{agent.turnCount}</span>
                    </div>
                  </div>
                </div>

                {/* Latency Metrics */}
                {agent.latencyMetrics && (
                  <div className="space-y-2">
                    <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
                      Latency (turn)
                    </h3>
                    <div className="space-y-1 text-xs">
                      {agent.latencyMetrics.p50Ms == null && agent.latencyMetrics.avgMs == null ? (
                        <p className="text-muted-foreground italic">No data</p>
                      ) : (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">p50</span>
                            <span className="font-mono text-foreground">
                              {agent.latencyMetrics.p50Ms != null ? `${agent.latencyMetrics.p50Ms}ms` : "—"}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">p95</span>
                            <span className="font-mono text-foreground">
                              {agent.latencyMetrics.p95Ms != null ? `${agent.latencyMetrics.p95Ms}ms` : "—"}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">p99</span>
                            <span className="font-mono text-foreground">
                              {agent.latencyMetrics.p99Ms != null ? `${agent.latencyMetrics.p99Ms}ms` : "—"}
                            </span>
                          </div>
                          <div className="flex items-center justify-between pt-1 border-t border-border/50">
                            <span className="text-muted-foreground">Average</span>
                            <span className="font-mono text-foreground">
                              {agent.latencyMetrics.avgMs != null ? `${agent.latencyMetrics.avgMs}ms` : "—"}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Error Rate */}
              {agent.errorRate && (
                <div className="space-y-2 border-t border-border pt-3">
                  <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
                    Error Analysis
                  </h3>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs gap-2">
                      <span className="text-muted-foreground shrink-0">Success Rate</span>
                      <div className="flex items-center gap-2 min-w-0">
                        <Sparkline
                          data={successHistory[agentName] ?? []}
                          successRate={agent.errorRate.successRate}
                        />
                        <span
                          className={cn(
                            "font-bold font-mono shrink-0",
                            agent.errorRate.successRate >= 95
                              ? "text-success"
                              : agent.errorRate.successRate >= 80
                              ? "text-warning"
                              : "text-error"
                          )}
                        >
                          {agent.errorRate.successRate}%
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Total Calls</span>
                      <span className="font-mono text-foreground">
                        {agent.errorRate.totalCalls}
                      </span>
                    </div>

                    {Object.keys(agent.errorRate.errorsByType).length > 0 && (
                      <div className="pt-1 border-t border-border/50">
                        <div className="text-[10px] text-muted-foreground/70 mb-1">
                          Errors by Type:
                        </div>
                        {Object.entries(agent.errorRate.errorsByType)
                          .sort(([, a], [, b]) => b - a)
                          .map(([errorType, count]) => (
                            <div
                              key={errorType}
                              className="flex items-center justify-between text-xs"
                            >
                              <span className="text-error/80 font-mono">
                                {errorType || "unknown"}
                              </span>
                              <span className="text-foreground font-mono">{count}</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Health Issues */}
              <div className="space-y-2 border-t border-border pt-3">
                <h3 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
                  Health Issues
                </h3>
                {agent.healthIssues && agent.healthIssues.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {agent.healthIssues.map((issue, idx) => {
                      const isCritical = !isStopped && (issue === 'NOT RUNNING' || issue.includes('circuit_breaker') || issue.includes('auth-error'));
                      const isWarning = !isStopped && (issue.includes('quota') || issue.includes('stale') || issue.includes('slow') || issue.includes('high-error'));
                      return (
                        <span
                          key={idx}
                          className={cn(
                            "text-[10px] font-mono px-2 py-0.5 rounded border",
                            isCritical
                              ? "bg-error/10 border-error/30 text-error"
                              : isWarning
                              ? "bg-warning/10 border-warning/30 text-warning"
                              : "bg-muted/10 border-border text-muted-foreground"
                          )}
                        >
                          {issue}
                        </span>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-success/80 italic">No issues detected</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
