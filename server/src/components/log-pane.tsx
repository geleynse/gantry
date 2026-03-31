"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { LogStream } from "@/components/log-stream";
import { ToolCallFeed } from "@/components/tool-call-feed";

type Tab = "logs" | "tools";

interface LogPaneProps {
  agents: string[];
  /** Override the default selected agent (defaults to agents[0]) */
  defaultAgent?: string;
}

export function LogPane({ agents, defaultAgent }: LogPaneProps) {
  const [selected, setSelected] = useState<string>(defaultAgent ?? agents[0] ?? "");
  const [activeTab, setActiveTab] = useState<Tab>("logs");

  // When the defaultAgent prop changes (e.g. after SSE connects and agent names arrive),
  // update the selection — but only if we haven't selected something ourselves yet.
  useEffect(() => {
    if (defaultAgent && selected === "") {
      setSelected(defaultAgent);
    }
  }, [defaultAgent, selected]);

  return (
    <div className="flex flex-col h-full border border-border bg-card overflow-hidden">
      {/* Pane header: agent selector + tabs */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border shrink-0 bg-card">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="bg-card border border-border text-foreground text-xs px-2 py-1 focus:outline-none focus:border-primary cursor-pointer"
        >
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>

        {/* Tab bar */}
        <div className="flex items-center gap-0.5 ml-auto">
          <button
            onClick={() => setActiveTab("logs")}
            className={cn(
              "px-2 py-1 text-[10px] uppercase tracking-wider cursor-pointer transition-colors",
              activeTab === "logs"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Raw Logs
          </button>
          <button
            onClick={() => setActiveTab("tools")}
            className={cn(
              "px-2 py-1 text-[10px] uppercase tracking-wider cursor-pointer transition-colors",
              activeTab === "tools"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Tool Calls
          </button>
        </div>
      </div>

      {/* Pane content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "logs" && selected && (
          <LogStream key={selected} agentName={selected} />
        )}
        {activeTab === "tools" && selected && (
          <ToolCallFeed agentName={selected} />
        )}
      </div>
    </div>
  );
}
