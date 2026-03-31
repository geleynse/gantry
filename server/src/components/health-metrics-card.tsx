"use client";

import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import type { LatencyMetrics, ErrorRateBreakdown } from "@/hooks/use-fleet-status";

interface HealthMetricsCardProps {
  agent: string;
  latency?: LatencyMetrics | null;
  errorRate?: ErrorRateBreakdown | null;
  connectionStatus?: "connected" | "disconnected" | "reconnecting";
}

export function HealthMetricsCard({
  agent,
  latency,
  errorRate,
  connectionStatus = "connected",
}: HealthMetricsCardProps) {
  const [expanded, setExpanded] = useState(false);

  if (!latency && !errorRate) {
    return null;
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="bg-card border border-border rounded-sm space-y-2"
    >
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between gap-2 hover:opacity-80 transition-opacity cursor-pointer p-3"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-xs uppercase tracking-wider font-semibold text-foreground">
            Proxy Metrics
          </span>
          <span
            className={cn(
              "inline-block w-1.5 h-1.5 rounded-full shrink-0",
              connectionStatus === "connected" ? "bg-success" : "bg-warning"
            )}
            title={connectionStatus}
          />
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </div>

      {expanded && (
        <div className="space-y-2 pt-2 px-3 pb-3 border-t border-border/50">
          {/* Latency metrics */}
          {latency && (
            <div className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                Latency (ms)
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                <div className="bg-background/50 p-1.5 rounded border border-border/50">
                  <div className="text-muted-foreground/70 mb-0.5">p50</div>
                  <div className="text-foreground">{latency.p50Ms ?? "—"}</div>
                </div>
                <div className="bg-background/50 p-1.5 rounded border border-border/50">
                  <div className="text-muted-foreground/70 mb-0.5">p95</div>
                  <div className="text-foreground">{latency.p95Ms ?? "—"}</div>
                </div>
                <div className="bg-background/50 p-1.5 rounded border border-border/50">
                  <div className="text-muted-foreground/70 mb-0.5">p99</div>
                  <div className="text-foreground">{latency.p99Ms ?? "—"}</div>
                </div>
              </div>
              {latency.avgMs && (
                <div className="text-[10px] text-muted-foreground flex items-center justify-between">
                  <span>Average</span>
                  <span className="font-mono text-foreground">{latency.avgMs}ms</span>
                </div>
              )}
            </div>
          )}

          {/* Error rate breakdown */}
          {errorRate && (
            <div className="space-y-1 pt-2 border-t border-border/50">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                  Success Rate
                </div>
                <span
                  className={cn(
                    "text-[10px] font-bold font-mono",
                    errorRate.successRate >= 95
                      ? "text-success"
                      : errorRate.successRate >= 80
                      ? "text-warning"
                      : "text-error"
                  )}
                >
                  {errorRate.successRate}%
                </span>
              </div>

              <div className="text-[10px] text-muted-foreground">
                <span className="text-foreground font-mono">{errorRate.totalCalls}</span> total calls
              </div>

              {(errorRate.countRateLimit > 0 || errorRate.countConnection > 0) && (
                <div className="space-y-1 pt-1">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    Connection Issues
                  </div>
                  {errorRate.countRateLimit > 0 && (
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span className="font-mono text-warning/80">Rate limit</span>
                      <span className="font-mono text-warning">{errorRate.countRateLimit}</span>
                    </div>
                  )}
                  {errorRate.countConnection > 0 && (
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span className="font-mono text-error/80">Connection failed</span>
                      <span className="font-mono text-error">{errorRate.countConnection}</span>
                    </div>
                  )}
                </div>
              )}

              {Object.keys(errorRate.errorsByType).length > 0 && (
                <div className="space-y-1 pt-1">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                    Errors by Type
                  </div>
                  {Object.entries(errorRate.errorsByType)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([errorType, count]) => (
                      <div
                        key={errorType}
                        className="flex items-center justify-between text-[10px] text-muted-foreground"
                      >
                        <span className="truncate font-mono text-error/80">
                          {errorType || "unknown"}
                        </span>
                        <span className="font-mono text-foreground shrink-0">{count}</span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
