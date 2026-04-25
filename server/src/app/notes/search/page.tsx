"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { formatAbsolute, relativeTime } from "@/lib/time";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  agent: string;
  source: string;
  text: string;
  created_at: string;
  importance?: number;
  id?: number;
}

interface SearchResponse {
  results: SearchResult[];
  query: string;
  agent?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Highlight all occurrences of `term` in `text` using <mark> */
function HighlightedText({ text, term }: { text: string; term: string }) {
  if (!term.trim()) {
    return <span>{text}</span>;
  }

  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);

  return (
    <span>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-warning/30 text-foreground px-0.5 rounded-sm">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  diary: "Diary",
  strategy: "Strategy",
  discoveries: "Discoveries",
  "market-intel": "Market Intel",
  report: "Report",
  thoughts: "Thoughts",
};

function ResultCard({
  result,
  query,
}: {
  result: SearchResult;
  query: string;
}) {
  const sourceLabel = SOURCE_LABELS[result.source] ?? result.source;

  return (
    <Link
      href={`/notes?agent=${encodeURIComponent(result.agent)}&type=${encodeURIComponent(result.source)}`}
      className="block bg-card border border-border hover:border-primary/40 hover:bg-secondary/20 transition-colors p-3 space-y-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
            {result.agent}
          </span>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {sourceLabel}
          </span>
          {result.importance !== undefined && result.importance > 2 && (
            <span className="text-[9px] text-warning font-mono">
              ★{result.importance}
            </span>
          )}
        </div>
        <span
          className="text-[10px] text-muted-foreground tabular-nums shrink-0"
          title={relativeTime(result.created_at)}
        >
          {formatAbsolute(result.created_at)}
        </span>
      </div>
      <p className="text-xs text-foreground leading-relaxed font-mono whitespace-pre-wrap line-clamp-4">
        <HighlightedText text={result.text} term={query} />
      </p>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NotesSearchPage() {
  const [agentList, setAgentList] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"relevance" | "date">("relevance");

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch agent list on mount
  useEffect(() => {
    apiFetch<{ agents: Array<{ name: string }> }>("/prompts/agents")
      .then((res) => setAgentList(res.agents.map((a) => a.name)))
      .catch(() => {});
    // Auto-focus search input
    inputRef.current?.focus();
  }, []);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    debounceRef.current = setTimeout(() => {
      performSearch(query, agentFilter);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, agentFilter]);

  async function performSearch(q: string, agent: string) {
    if (!q.trim()) return;

    setIsSearching(true);
    setError(null);
    setSearched(false);

    try {
      const params = new URLSearchParams({ q, limit: "50" });
      if (agent) params.set("agent", agent);

      const res = await apiFetch<SearchResponse>(
        `/notes/fleet/search?${params.toString()}`
      );
      setResults(res.results);
      setSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  function clearSearch() {
    setQuery("");
    setResults([]);
    setSearched(false);
    setError(null);
    inputRef.current?.focus();
  }

  // Sort results
  const sortedResults = [...results].sort((a, b) => {
    if (sortBy === "date") {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    }
    // "relevance" — keep server order (already sorted by importance+date)
    return 0;
  });

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="border-b border-primary/20 pb-4">
        <h1 className="text-lg font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
          <Search className="w-5 h-5" />
          Memory Search
        </h1>
        <p className="text-xs text-muted-foreground mt-1">
          Full-text search across all agent notes, strategy docs, and diary entries.
        </p>
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes, diary, strategy..."
            className={cn(
              "w-full pl-9 pr-8 py-2.5 bg-background border border-border text-foreground text-sm",
              "placeholder:text-muted-foreground",
              "focus:outline-none focus:border-primary/50"
            )}
          />
          {query && (
            <button
              onClick={clearSearch}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="bg-background border border-border text-foreground text-xs px-2 py-1 min-w-[130px]"
        >
          <option value="">All agents</option>
          {agentList.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
      </div>

      {/* Results controls */}
      {searched && results.length > 0 && (
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {results.length} result{results.length !== 1 ? "s" : ""}
            {agentFilter && ` for ${agentFilter}`}
          </span>
          <div className="flex items-center gap-1">
            <span>Sort:</span>
            {(["relevance", "date"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={cn(
                  "px-2 py-0.5 uppercase tracking-wider transition-colors",
                  sortBy === s
                    ? "text-foreground"
                    : "text-muted-foreground/60 hover:text-muted-foreground"
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      {error && (
        <div className="bg-error/10 border border-error/30 text-error text-xs p-3">
          {error}
        </div>
      )}

      {isSearching && (
        <div className="text-center py-8 text-muted-foreground text-xs">
          Searching...
        </div>
      )}

      {!isSearching && searched && results.length === 0 && (
        <div className="text-center py-12 text-muted-foreground text-sm">
          <div className="mb-1">No results found for &ldquo;{query}&rdquo;</div>
          <div className="text-xs opacity-60">
            Try a different term or remove the agent filter.
          </div>
        </div>
      )}

      {!isSearching && !searched && !query && (
        <div className="text-center py-16 text-muted-foreground">
          <Search className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <div className="text-sm mb-1">Search agent memory</div>
          <div className="text-xs opacity-60">
            Type to search across all notes, diary entries, and strategy documents
          </div>
        </div>
      )}

      {!isSearching && sortedResults.length > 0 && (
        <div className="space-y-2">
          {sortedResults.map((result, idx) => (
            <ResultCard key={`${result.agent}-${result.source}-${idx}`} result={result} query={query} />
          ))}
        </div>
      )}
    </div>
  );
}
