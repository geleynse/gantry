"use client";

import { ActivityFeed } from "@/components/activity-feed";
import { useSSE } from "@/hooks/use-sse";
import { cn } from "@/lib/utils";
import type { ActivityEvent } from "@/components/activity-feed";

export default function ActivityPage() {
  // Mirror SSE connection status for the page header live badge.
  // The feed component opens its own connection; this is a separate
  // subscription to the same endpoint so the header stays in sync.
  const { connected } = useSSE<ActivityEvent[]>("/api/activity/stream", "activity");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-primary/20 pb-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
          Fleet Activity
        </h1>

        {/* Live indicator */}
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "inline-block w-2 h-2 rounded-full",
              connected ? "bg-success animate-pulse" : "bg-error",
            )}
          />
          <span
            className={cn(
              "text-[9px] uppercase tracking-wider font-semibold",
              connected ? "text-success" : "text-error",
            )}
          >
            {connected ? "live" : "disconnected"}
          </span>
        </div>
      </div>

      <ActivityFeed />
    </div>
  );
}
