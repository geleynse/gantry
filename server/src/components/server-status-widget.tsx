"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useServerStatus, type ServerStatusData } from "@/hooks/use-server-status";

// ---------------------------------------------------------------------------
// Pure display helper — testable without React
// ---------------------------------------------------------------------------

export type StatusSeverity = "up" | "degraded" | "down" | "unknown";

export interface ServerStatusDisplay {
  label: string;
  severity: StatusSeverity;
  /** Present when consecutive_failures > 0 */
  tooltipDetail?: string;
}

/**
 * Derives display label + severity from a server-status payload.
 *
 * Rules (circuit_breaker field takes precedence when present):
 *   - cb.state === "closed" && status === "up"  → UP (green)
 *   - cb.state === "half-open"                  → DEGRADED (yellow)
 *   - cb.state === "open"                       → DOWN (red)
 *   - cb missing (old server build)             → fall back to `status`
 *   - payload is null                           → unknown
 */
export function getServerStatusDisplay(
  payload: ServerStatusData | null | undefined
): ServerStatusDisplay {
  if (!payload) return { label: "—", severity: "unknown" };

  const cb = payload.circuit_breaker;
  const failures = cb?.consecutive_failures ?? 0;
  const tooltipDetail =
    failures > 0 ? `${failures} consecutive upstream failure${failures !== 1 ? "s" : ""}` : undefined;

  // When circuit_breaker is present, use its state as the authoritative source
  if (cb) {
    if (cb.state === "open") {
      return { label: "DOWN", severity: "down", tooltipDetail };
    }
    if (cb.state === "half-open") {
      return { label: "DEGRADED", severity: "degraded", tooltipDetail };
    }
    // closed — fall through to status field for the normal UP/DEGRADED distinction
    if (payload.status === "up") {
      return { label: "UP", severity: "up", tooltipDetail };
    }
    if (payload.status === "degraded") {
      return { label: "DEGRADED", severity: "degraded", tooltipDetail };
    }
    return { label: "DOWN", severity: "down", tooltipDetail };
  }

  // Fallback for older server builds that don't include circuit_breaker
  switch (payload.status) {
    case "up":
      return { label: "UP", severity: "up" };
    case "degraded":
      return { label: "DEGRADED", severity: "degraded", tooltipDetail };
    case "down":
      return { label: "DOWN", severity: "down", tooltipDetail };
    default:
      return { label: "—", severity: "unknown" };
  }
}

function dotClass(severity: StatusSeverity): string {
  switch (severity) {
    case "up":
      return "bg-success";
    case "degraded":
      return "bg-warning";
    case "down":
      return "bg-error";
    default:
      return "bg-muted-foreground opacity-50";
  }
}

function textClass(severity: StatusSeverity): string {
  switch (severity) {
    case "up":
      return "text-success";
    case "degraded":
      return "text-warning";
    case "down":
      return "text-error";
    default:
      return "text-muted-foreground";
  }
}


function formatAge(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "—";
  const diff = Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// Debounce the CB state so transient open→closed flicker doesn't flash "CB:OPEN".
// CB open/half-open is shown immediately; clearing back to "closed" is delayed 8s.
function useStableCbState(cbState: string | null): string | null {
  const [stable, setStable] = useState<string | null>(cbState);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (cbState && cbState !== "closed") {
      // Non-closed state — show immediately, cancel any pending clear
      if (clearTimerRef.current) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
      setStable(cbState);
    } else {
      // Transitioning back to closed — delay clearing by 8s to suppress flicker
      if (clearTimerRef.current) return;
      clearTimerRef.current = setTimeout(() => {
        setStable(null);
        clearTimerRef.current = null;
      }, 8000);
    }
    return () => {
      // no cleanup needed — timer will fire or be cancelled above
    };
  }, [cbState]);

  return stable;
}

export function ServerStatusWidget() {
  const { data, connected } = useServerStatus();

  const version = data?.version ?? null;
  const cbState = data?.circuit_breaker?.state ?? null;
  const lastCheck = data?.last_health_check ?? null;

  const stableCbState = useStableCbState(cbState);

  // Derive display label + severity from circuit_breaker state (falls back to
  // status field when circuit_breaker is absent — old server builds).
  const display = getServerStatusDisplay(data);
  const { label, severity, tooltipDetail } = display;

  const isNotUp = severity !== "up" && severity !== "unknown";
  const cooldownSec = data?.circuit_breaker?.cooldown_remaining_ms
    ? Math.ceil(data.circuit_breaker.cooldown_remaining_ms / 1000)
    : null;

  // Build tooltip title — shown on hover of the dot
  const dotTitle = [data?.notes, tooltipDetail].filter(Boolean).join(" — ") || "Server status unknown";

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
        Server
      </span>

      {/* Status dot — color driven by circuit-breaker-aware severity */}
      <span
        className={cn("inline-block w-2 h-2 rounded-full", dotClass(severity))}
        title={dotTitle}
      />

      {/* Status text — with hover tooltip when not UP */}
      <span className="relative group/srvstatus">
        <span
          className={cn(
            "font-mono text-[11px] cursor-default",
            textClass(severity),
            isNotUp && "underline decoration-dotted"
          )}
        >
          {label}
        </span>

        {/* Tooltip — only shown when not UP and we have detail */}
        {isNotUp && data && (
          <div className={cn(
            "absolute top-full left-0 mt-2 z-50 w-64 p-3 rounded-sm border shadow-xl",
            "bg-card border-border text-[11px] leading-relaxed",
            "invisible opacity-0 group-hover/srvstatus:visible group-hover/srvstatus:opacity-100",
            "transition-opacity duration-150 pointer-events-none"
          )}>
            {/* Arrow */}
            <div className="absolute -top-1.5 left-4 w-3 h-3 bg-card border-l border-t border-border rotate-45" />

            <div className="space-y-1.5">
              <div className={cn(
                "font-semibold uppercase tracking-wider text-[10px] mb-2",
                severity === "down" ? "text-error" : "text-warning"
              )}>
                Server {label}
              </div>

              {tooltipDetail && (
                <p className="text-warning/90 font-mono">{tooltipDetail}</p>
              )}

              {data.notes && (
                <p className="text-foreground/80 font-mono break-words">{data.notes}</p>
              )}

              {data.circuit_breaker && (
                <div className="pt-1.5 border-t border-border/50 space-y-1 text-[10px] font-mono">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Circuit breaker</span>
                    <span className={cn(
                      data.circuit_breaker.state === "open" ? "text-error" :
                      data.circuit_breaker.state === "half-open" ? "text-warning" :
                      "text-muted-foreground"
                    )}>
                      {data.circuit_breaker.state.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Consecutive failures</span>
                    <span className="text-foreground">{data.circuit_breaker.consecutive_failures}</span>
                  </div>
                  {cooldownSec !== null && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cooldown remaining</span>
                      <span className="text-warning">{cooldownSec}s</span>
                    </div>
                  )}
                </div>
              )}

              {data.latency_ms != null && (
                <div className="pt-1 border-t border-border/50 flex justify-between text-[10px] font-mono">
                  <span className="text-muted-foreground">Last latency</span>
                  <span className="text-foreground">{data.latency_ms}ms</span>
                </div>
              )}
            </div>
          </div>
        )}
      </span>

      {/* Version badge */}
      {version && (
        <span className="text-[10px] text-muted-foreground font-mono">
          ({version})
        </span>
      )}

      {/* Circuit breaker — only shown when not closed (debounced to suppress flicker) */}
      {stableCbState && stableCbState !== "closed" && (
        <span className="text-[10px] text-warning font-mono uppercase">
          CB:{stableCbState}
        </span>
      )}

      {/* Last check age */}
      <span className="text-[10px] text-muted-foreground font-mono">
        {formatAge(lastCheck)}
      </span>

      {/* SSE disconnected indicator */}
      {!connected && data && (
        <span className="text-[10px] text-error" title="SSE disconnected">
          [offline]
        </span>
      )}
    </div>
  );
}
