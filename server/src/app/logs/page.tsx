"use client";

/**
 * Logs page — two side-by-side log viewers. Each pane lets the operator pick
 * any agent and switch between "Raw Logs" and "Tool Calls" tabs.
 *
 * Previously the sidebar linked to /logs but no route existed; users hit a
 * 404 or a blank shell that appeared stuck on "Disconnected". Building the
 * page here wires LogPane (which was already implemented but unused) to the
 * existing per-agent SSE endpoints.
 */

import { useAgentNames } from "@/hooks/use-agent-names";
import { LogPane } from "@/components/log-pane";

export default function LogsPage() {
  const agents = useAgentNames();

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-muted-foreground">
        Waiting for fleet status&hellip;
      </div>
    );
  }

  // Default the two panes to different agents so the operator sees two
  // distinct streams on first load. Falls back to the same agent when only
  // one exists.
  const firstAgent = agents[0];
  const secondAgent = agents[1] ?? agents[0];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4 border-b border-primary/20 pb-3">
        <div>
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">
            Logs
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Live agent logs and tool calls. Pick any agent per pane.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-[calc(100vh-200px)]">
        <LogPane agents={agents} defaultAgent={firstAgent} />
        <LogPane agents={agents} defaultAgent={secondAgent} />
      </div>
    </div>
  );
}
