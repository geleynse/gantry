"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RateLimitLimiterStats {
  name: string;
  windowMs: number;
  maxRequests: number;
  activeIps: number;
  requestsInWindow: number;
  rejections: number;
}

interface RateLimitStats {
  limiters: RateLimitLimiterStats[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWindow(ms: number): string {
  if (ms < 60_000) return `${ms / 1000}s`;
  return `${ms / 60_000}m`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RateLimitPanel() {
  const [data, setData] = useState<RateLimitStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const res = await fetch("/api/diagnostics/rate-limits");
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = await res.json() as RateLimitStats;
        if (mounted) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 10_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <div className="bg-card border border-border p-4 rounded-sm space-y-3">
      <h2 className="text-xs uppercase tracking-wider font-semibold text-muted-foreground/70">
        Rate Limiters
      </h2>

      {loading && (
        <div className="text-muted-foreground text-xs">Loading…</div>
      )}

      {error && (
        <div className="text-error text-xs">Failed to load: {error}</div>
      )}

      {data && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground/70 text-left">
                <th className="pb-1 pr-4 font-medium">Limiter</th>
                <th className="pb-1 pr-4 font-medium">Window</th>
                <th className="pb-1 pr-4 font-medium">Max</th>
                <th className="pb-1 pr-4 font-medium">Active IPs</th>
                <th className="pb-1 pr-4 font-medium">Requests</th>
                <th className="pb-1 font-medium">Rejections</th>
              </tr>
            </thead>
            <tbody>
              {data.limiters.map((limiter) => (
                <tr key={limiter.name} className="border-b border-border/30 last:border-0">
                  <td className="py-1 pr-4 font-mono text-foreground">{limiter.name}</td>
                  <td className="py-1 pr-4 font-mono text-muted-foreground">
                    {formatWindow(limiter.windowMs)}
                  </td>
                  <td className="py-1 pr-4 font-mono text-muted-foreground">
                    {limiter.maxRequests}
                  </td>
                  <td className="py-1 pr-4 font-mono text-foreground">
                    {limiter.activeIps}
                  </td>
                  <td className="py-1 pr-4 font-mono text-foreground">
                    {limiter.requestsInWindow}
                  </td>
                  <td
                    className={cn(
                      "py-1 font-mono font-semibold",
                      limiter.rejections > 0 ? "text-error" : "text-muted-foreground",
                    )}
                  >
                    {limiter.rejections}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
