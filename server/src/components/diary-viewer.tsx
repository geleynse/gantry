"use client";

// #507 — "No thoughts showing for some agents"
// Investigation: The API route (GET /notes/:name/diary), the query in notes-db, and this
// component's fetch logic are all correct. Empty diary tabs mean those agents simply aren't
// calling write_diary during their turns — this is a prompt/behavior issue, not a code bug.
// Follow-up: audit per-agent prompts to confirm diary-writing instructions are active.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { formatAbsolute, relativeTime } from "@/lib/time";

interface DiaryViewerProps {
  agentName: string;
}

interface DiaryEntry {
  id: number;
  entry: string;
  created_at: string;
}

interface DocData {
  content: string;
}

type SubTab = "diary" | "strategy" | "discoveries" | "market-intel";

const SUBTABS: { id: SubTab; label: string }[] = [
  { id: "diary", label: "Diary" },
  { id: "strategy", label: "Strategy" },
  { id: "discoveries", label: "Discoveries" },
  { id: "market-intel", label: "Market Intel" },
];

export function DiaryViewer({ agentName }: DiaryViewerProps) {
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("diary");
  const [data, setData] = useState<DiaryEntry[] | DocData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());

  async function fetchData(subTab: SubTab) {
    setLoading(true);
    setError(null);
    setData(null);

    try {
      if (subTab === "diary") {
        const result = await apiFetch<{ entries: DiaryEntry[] }>(
          `/notes/${agentName}/diary?count=50`
        );
        setData(result.entries ?? []);
      } else {
        const docType = subTab === "market-intel" ? "market-intel" : subTab;
        const result = await apiFetch<DocData>(`/notes/${agentName}/${docType}`);
        setData(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData(activeSubTab);
  }, [activeSubTab, agentName]);

  function toggleEntry(id: number) {
    setExpandedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const isDiary = activeSubTab === "diary";
  const isLoading = loading;

  return (
    <div className="bg-card border border-border p-3 h-full flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Notes
        </h3>
        <button
          onClick={() => fetchData(activeSubTab)}
          disabled={isLoading}
          className="text-[9px] px-2 py-1 bg-primary/20 text-primary hover:bg-primary/30 transition-colors disabled:opacity-50"
        >
          {isLoading ? "Loading…" : "Refresh"}
        </button>
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
          <div className="text-[10px] text-error py-2 px-2 bg-error/10 border border-error/20 mb-2">
            Error: {error}
          </div>
        )}

        {!error && isLoading && (
          <div className="text-[10px] text-muted-foreground italic py-4 text-center">
            Loading…
          </div>
        )}

        {!error && !isLoading && !data && (
          <div className="text-[10px] text-muted-foreground italic text-center py-4">
            No data available
          </div>
        )}

        {/* Diary entries */}
        {!error && !isLoading && data && isDiary && Array.isArray(data) && (
          <div className="space-y-0">
            {data.length === 0 ? (
              <div className="text-[10px] text-muted-foreground italic py-4 text-center">
                No diary entries yet
              </div>
            ) : (
              data
                .slice()
                .reverse()
                .map((entry) => {
                  const isLong = entry.entry.length > 200;
                  const isExpanded = expandedEntries.has(entry.id);
                  return (
                    <div
                      key={entry.id}
                      className={cn(
                        "border-b border-border/50 py-2.5 text-[11px]",
                        isLong && "cursor-pointer hover:bg-primary/5"
                      )}
                      onClick={isLong ? () => toggleEntry(entry.id) : undefined}
                    >
                      <div className="flex items-center gap-2 text-muted-foreground mb-1.5">
                        <span className="text-[10px]">{formatAbsolute(entry.created_at)}</span>
                        <span className="text-[9px] opacity-60">{relativeTime(entry.created_at)}</span>
                      </div>
                      <div className="text-foreground whitespace-pre-wrap break-words leading-relaxed">
                        {isLong && !isExpanded
                          ? entry.entry.slice(0, 200) + "…"
                          : entry.entry}
                      </div>
                      {isLong && (
                        <div className="text-[9px] text-primary/60 mt-1">
                          {isExpanded ? "Click to collapse" : "Click to expand"}
                        </div>
                      )}
                    </div>
                  );
                })
            )}
          </div>
        )}

        {/* Doc content (strategy, discoveries, market-intel) */}
        {!error && !isLoading && data && !isDiary && (
          <>
            {typeof (data as DocData).content === "string" && (data as DocData).content.length > 0 ? (
              <div className="text-[11px] font-mono text-foreground whitespace-pre-wrap break-words leading-relaxed">
                {(data as DocData).content}
              </div>
            ) : (
              <div className="text-[10px] text-muted-foreground italic text-center py-4">
                No {activeSubTab} content written yet
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
