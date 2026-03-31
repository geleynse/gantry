"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useServerStatus, type ServerStatusData } from "@/hooks/use-server-status";

function statusDotClass(status: ServerStatusData["status"] | null): string {
  switch (status) {
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

function statusLabel(status: ServerStatusData["status"] | null): string {
  switch (status) {
    case "up":
      return "UP";
    case "degraded":
      return "DEGRADED";
    case "down":
      return "DOWN";
    default:
      return "—";
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

  const status = data?.status ?? null;
  const version = data?.version ?? null;
  const cbState = data?.circuit_breaker?.state ?? null;
  const lastCheck = data?.last_health_check ?? null;

  const stableCbState = useStableCbState(cbState);

  const isDown = status === "down" || status === "degraded";
  const cooldownSec = data?.circuit_breaker?.cooldown_remaining_ms
    ? Math.ceil(data.circuit_breaker.cooldown_remaining_ms / 1000)
    : null;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground uppercase tracking-wider text-[10px]">
        Server
      </span>

      {/* Status dot */}
      <span
        className={cn("inline-block w-2 h-2 rounded-full", statusDotClass(status))}
        title={data?.notes ?? "Server status unknown"}
      />

      {/* Status text — with hover tooltip when down/degraded */}
      <span className="relative group/srvstatus">
        <span
          className={cn(
            "font-mono text-[11px] cursor-default",
            status === "up" && "text-success",
            status === "degraded" && "text-warning",
            status === "down" && "text-error",
            status === null && "text-muted-foreground",
            isDown && "underline decoration-dotted"
          )}
        >
          {statusLabel(status)}
        </span>

        {/* Tooltip — only shown when down/degraded and we have detail */}
        {isDown && data && (
          <div className={cn(
            "absolute top-full left-0 mt-2 z-50 w-64 p-3 rounded-sm border shadow-xl",
            "bg-card border-border text-[11px] leading-relaxed",
            "invisible opacity-0 group-hover/srvstatus:visible group-hover/srvstatus:opacity-100",
            "transition-opacity duration-150 pointer-events-none"
          )}>
            {/* Arrow */}
            <div className="absolute -top-1.5 left-4 w-3 h-3 bg-card border-l border-t border-border rotate-45" />

            <div className="space-y-1.5">
              <div className="font-semibold uppercase tracking-wider text-[10px] text-error mb-2">
                Server {statusLabel(status)}
              </div>

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
