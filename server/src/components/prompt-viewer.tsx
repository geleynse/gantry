"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface PromptViewerProps {
  agentName: string;
}

interface PromptData {
  main: string | null;
  personality: string | null;
  commonRules: string | null;
  personalityRules: string | null;
}

type SubTab = "main" | "personality" | "commonRules" | "personalityRules";

const SUBTABS: { id: SubTab; label: string; key: keyof PromptData }[] = [
  { id: "main", label: "Main Prompt", key: "main" },
  { id: "personality", label: "Personality", key: "personality" },
  { id: "commonRules", label: "Common Rules", key: "commonRules" },
  { id: "personalityRules", label: "Personality Rules", key: "personalityRules" },
];

export function PromptViewer({ agentName }: PromptViewerProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("main");
  const [data, setData] = useState<PromptData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchPrompts() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/agents/${agentName}/prompts`);
      if (!response.ok) {
        throw new Error(`Failed to fetch prompts`);
      }
      setData(await response.json());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchPrompts();
  }, [agentName]);

  const activeContent = data ? data[SUBTABS.find(t => t.id === activeSubTab)!.key] : null;

  return (
    <div className="bg-card border border-border p-3 h-[70vh] md:h-[calc(100vh-350px)] flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Prompt Files
        </h3>
        <div className="flex items-center gap-2">
          <Link
            href={`/prompts?agent=${agentName}`}
            className="flex items-center gap-1 text-[9px] px-2 py-1 bg-secondary text-foreground hover:bg-secondary/80 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            Edit in Prompts
          </Link>
          <button
            onClick={fetchPrompts}
            disabled={loading}
            className="text-[9px] px-2 py-1 bg-primary/20 text-primary hover:bg-primary/30 transition-colors disabled:opacity-50"
          >
            {loading ? "Loading\u2026" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-0 border-b border-border/50 mb-3">
        {SUBTABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id)}
            className={cn(
              "px-2 py-1.5 text-[10px] uppercase tracking-wider cursor-pointer transition-colors",
              activeSubTab === tab.id
                ? "text-primary border-b border-primary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {error && (
          <div className="text-[10px] text-error py-2 px-2 bg-error/10 border border-error/20">
            Error: {error}
          </div>
        )}

        {!error && loading && (
          <div className="text-[10px] text-muted-foreground italic py-4">
            Loading&hellip;
          </div>
        )}

        {!error && !loading && activeContent === null && (
          <div className="text-[10px] text-muted-foreground italic py-4">
            File not found
          </div>
        )}

        {!error && !loading && activeContent && (
          <pre className="text-[10px] font-mono text-foreground whitespace-pre-wrap break-words leading-relaxed">
            {activeContent}
          </pre>
        )}
      </div>
    </div>
  );
}
