"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { formatDateTime } from "@/lib/time";
import { RefreshCw, Search } from "lucide-react";

// ---------------------------------------------------------------------------
// Types (AgentName is dynamic — populated from fleet config at runtime)
// ---------------------------------------------------------------------------

type AgentName = string;

type DocType = "strategy" | "discoveries" | "market-intel" | "report" | "thoughts" | "diary";

const DOC_TYPES: Array<{ id: DocType; label: string }> = [
  { id: "strategy", label: "Strategy" },
  { id: "discoveries", label: "Discoveries" },
  { id: "market-intel", label: "Market Intel" },
  { id: "report", label: "Report" },
  { id: "thoughts", label: "Thoughts" },
  { id: "diary", label: "Diary" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiaryEntry {
  id: number;
  entry: string;
  created_at: string;
}

interface DiaryResponse {
  entries: DiaryEntry[];
}

interface NoteResponse {
  content: string;
}

interface SearchResult {
  agent: string;
  source: string;
  text: string;
  created_at: string;
  id?: number;
}

interface SearchResponse {
  results: SearchResult[];
  query: string;
  agent?: string;
}

// ---------------------------------------------------------------------------
// Markdown renderer — React element tree (no dangerouslySetInnerHTML)
// ---------------------------------------------------------------------------

/** Parse inline markdown (bold, italic, code) into React nodes */
function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let last = 0;
  for (const m of text.matchAll(regex)) {
    if (m.index! > last) nodes.push(text.slice(last, m.index!));
    const k = `${keyPrefix}-${m.index}`;
    if (m[2]) nodes.push(<strong key={k}><em>{m[2]}</em></strong>);
    else if (m[3]) nodes.push(<strong key={k}>{m[3]}</strong>);
    else if (m[4]) nodes.push(<em key={k}>{m[4]}</em>);
    else if (m[5]) nodes.push(<code key={k} className="bg-muted/30 px-0.5 rounded text-[11px] font-mono">{m[5]}</code>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function MarkdownLine({ line, codeBlocks, idx }: { line: string; codeBlocks: string[]; idx: number }) {
  const cbMatch = line.match(/^\x02(\d+)\x03$/);
  if (cbMatch) {
    return (
      <pre className="bg-muted/20 rounded p-2 my-1.5 text-[11px] overflow-x-auto text-foreground/80 font-mono">
        <code>{codeBlocks[parseInt(cbMatch[1])]}</code>
      </pre>
    );
  }
  const h3 = line.match(/^###\s+(.+)$/);
  if (h3) return <div className="font-bold text-foreground mt-3 mb-0.5 text-[10px] uppercase tracking-wider">{parseInline(h3[1], String(idx))}</div>;
  const h2 = line.match(/^##\s+(.+)$/);
  if (h2) return <div className="font-semibold text-foreground mt-3 mb-1 text-xs uppercase tracking-wider border-b border-border pb-1">{parseInline(h2[1], String(idx))}</div>;
  const h1 = line.match(/^#\s+(.+)$/);
  if (h1) return <div className="font-semibold text-foreground mt-4 mb-1 text-sm">{parseInline(h1[1], String(idx))}</div>;
  if (/^---+$/.test(line.trim())) return <hr className="border-border my-3" />;
  const li = line.match(/^[-*]\s+(.+)$/);
  if (li) return <div className="flex gap-1.5 items-start my-0.5"><span className="text-muted-foreground shrink-0 mt-px select-none">•</span><span>{parseInline(li[1], String(idx))}</span></div>;
  const oli = line.match(/^(\d+)\.\s+(.+)$/);
  if (oli) return <div className="flex gap-1.5 items-start my-0.5"><span className="text-muted-foreground tabular-nums shrink-0 mt-px w-5 text-right select-none">{oli[1]}.</span><span>{parseInline(oli[2], String(idx))}</span></div>;
  if (line.trim() === "") return <div className="h-2" />;
  return <div>{parseInline(line, String(idx))}</div>;
}

function MarkdownContent({ text }: { text: string }) {
  if (!text) return <span className="text-xs text-muted-foreground italic">(empty)</span>;
  const codeBlocks: string[] = [];
  const withPlaceholders = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push((code as string).trimEnd());
    return `\x02${codeBlocks.length - 1}\x03`;
  });
  const lines = withPlaceholders.split("\n");
  return (
    <div className="text-xs text-foreground leading-relaxed">
      {lines.map((line, i) => (
        <MarkdownLine key={i} line={line} codeBlocks={codeBlocks} idx={i} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function NotesPage() {
  const { isAdmin } = useAuth();
  const [agentList, setAgentList] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentName>("");
  const [selectedDocType, setSelectedDocType] = useState<DocType>("strategy");
  const [content, setContent] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced auto-search when query changes
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      handleSearch();
    }, 350);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchQuery]);

  // Fetch agent list from fleet config on mount
  useEffect(() => {
    apiFetch<{ agents: Array<{ name: string }> }>("/prompts/agents")
      .then((res) => setAgentList(res.agents.map((a) => a.name)))
      .catch(() => {/* silently ignore — sidebar stays empty */});
  }, []);

  // Load content when agent or doc type changes
  useEffect(() => {
    if (!selectedAgent) return;
    loadContent();
  }, [selectedAgent, selectedDocType]);

  async function loadContent() {
    setIsLoading(true);
    setError(null);
    setIsEditing(false);

    try {
      if (selectedDocType === "diary") {
        const res = await apiFetch<DiaryResponse>(
          `/notes/${selectedAgent}/diary?count=50`
        );
        setContent(
          res.entries
            .map((e) => `[${formatDateTime(e.created_at)}]\n${e.entry}`)
            .reverse()
            .join("\n\n---\n\n")
        );
      } else {
        const res = await apiFetch<NoteResponse>(
          `/notes/${selectedAgent}/${selectedDocType}`
        );
        setContent(res.content);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load content");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSave() {
    setIsSaving(true);
    setError(null);

    try {
      await apiFetch(`/notes/${selectedAgent}/${selectedDocType}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      setIsEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    setSearchError(null);

    try {
      const res = await apiFetch<SearchResponse>(
        `/notes/fleet/search?q=${encodeURIComponent(searchQuery)}&limit=20`
      );
      setSearchResults(res.results);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  }

  function handleSearchResultClick(result: SearchResult) {
    setSelectedAgent(result.agent as AgentName);
    const docType = result.source as DocType;
    if (DOC_TYPES.find((t) => t.id === docType)) {
      setSelectedDocType(docType);
    }
    setSearchQuery("");
    setSearchResults([]);
  }

  const canEdit = isAdmin && selectedDocType !== "diary";
  const docTypeLabel =
    DOC_TYPES.find((t) => t.id === selectedDocType)?.label || selectedDocType;

  return (
    <div className="flex flex-col md:flex-row h-auto md:h-[calc(100vh-96px)] gap-0 overflow-hidden">
      {/* Left Sidebar — Agent & Doc Type Selector */}
      <div className="w-full md:w-[200px] bg-card border-b md:border-b-0 md:border-r border-border overflow-y-auto flex flex-col shrink-0">
        {/* Mobile: horizontal agent + doc type selectors */}
        <div className="md:hidden p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-foreground">
            Agent
          </div>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="w-full bg-background border border-border text-foreground text-xs px-2 py-1.5"
          >
            <option value="">— select agent —</option>
            {agentList.map((agent) => (
              <option key={agent} value={agent}>{agent}</option>
            ))}
          </select>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-foreground mt-2">
            Doc Type
          </div>
          <div className="flex flex-wrap gap-1">
            {DOC_TYPES.map((docType) => (
              <button
                key={docType.id}
                onClick={() => setSelectedDocType(docType.id)}
                className={cn(
                  "px-2 py-1 text-[10px] uppercase tracking-wider transition-colors",
                  selectedDocType === docType.id
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground"
                )}
              >
                {docType.label}
              </button>
            ))}
          </div>
        </div>

        {/* Desktop: vertical lists */}
        <div className="hidden md:flex flex-1 flex-col min-h-0">
          <div className="px-3 py-2 border-b border-border bg-secondary/30 text-[10px] uppercase tracking-wider font-semibold text-foreground sticky top-0 z-10">
            Agents
          </div>
          <div className="flex-1 overflow-y-auto">
            {agentList.length === 0 ? (
              <div className="px-3 py-4 text-center text-muted-foreground text-xs opacity-60">
                No agents configured
              </div>
            ) : (
              agentList.map((agent) => (
                <button
                  key={agent}
                  onClick={() => setSelectedAgent(agent)}
                  className={cn(
                    "w-full text-left px-3 py-2 text-xs transition-colors border-b border-border/50",
                    selectedAgent === agent
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-foreground hover:bg-secondary/50"
                  )}
                >
                  {agent}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="hidden md:flex flex-1 flex-col min-h-0">
          <div className="px-3 py-2 border-t border-b border-border bg-secondary/30 text-[10px] uppercase tracking-wider font-semibold text-foreground sticky top-0 z-10">
            Doc Types
          </div>
          <div className="flex-1 overflow-y-auto">
            {DOC_TYPES.map((docType) => (
              <button
                key={docType.id}
                onClick={() => setSelectedDocType(docType.id)}
                className={cn(
                  "w-full text-left px-3 py-2 text-xs transition-colors border-b border-border/50",
                  selectedDocType === docType.id
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-foreground hover:bg-secondary/50"
                )}
              >
                {docType.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Center — Content Viewer/Editor */}
      <div className="flex-1 flex flex-col bg-background overflow-hidden min-h-[50vh] md:min-h-0">
        {/* Header */}
        <div className="flex items-center justify-between px-3 md:px-4 py-3 border-b border-border bg-card shrink-0">
          <h1 className="text-xs uppercase tracking-wider font-semibold text-primary truncate">
            {selectedAgent} — {docTypeLabel}
          </h1>
          <div className="flex items-center gap-2 shrink-0">
            {canEdit && (
              <button
                onClick={() => (isEditing ? handleSave() : setIsEditing(true))}
                disabled={isSaving}
                className={cn(
                  "px-3 py-1.5 text-[10px] uppercase tracking-wider transition-colors",
                  isEditing
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-secondary text-foreground hover:bg-secondary/80",
                  isSaving && "opacity-50 cursor-not-allowed"
                )}
              >
                {isSaving ? "Saving\u2026" : isEditing ? "Save" : "Edit"}
              </button>
            )}
            <button
              onClick={loadContent}
              disabled={isLoading}
              className={cn(
                "p-1.5 text-foreground hover:bg-secondary transition-colors",
                isLoading && "opacity-50 cursor-not-allowed"
              )}
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-auto p-3 md:p-4">
          {!selectedAgent ? (
            <div className="flex flex-col items-center justify-center h-full py-16 text-center text-muted-foreground">
              <div className="text-sm mb-1">Select an agent to view their notes</div>
              <div className="text-xs opacity-60">Choose an agent from the sidebar</div>
            </div>
          ) : (
          <>
          {error && (
            <div className="mb-3 p-3 bg-error/20 text-error text-xs">
              {error}
            </div>
          )}

          {isLoading ? (
            <div className="text-center text-muted-foreground text-xs py-8">
              Loading&hellip;
            </div>
          ) : isEditing && canEdit ? (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="bg-background border border-border text-foreground font-mono text-xs p-3 w-full min-h-[400px] resize-y"
              placeholder={`Enter ${docTypeLabel.toLowerCase()} content here\u2026`}
            />
          ) : (
            <MarkdownContent text={content} />
          )}
          </>
          )}
        </div>
      </div>

      {/* Right Sidebar — Search Panel (hidden on mobile) */}
      <div className="hidden md:flex w-[250px] bg-card border-l border-border overflow-y-auto flex-col">
        <div className="px-3 py-2 border-b border-border bg-secondary/30 text-[10px] uppercase tracking-wider font-semibold text-foreground sticky top-0 z-10">
          Fleet Search
        </div>

        <div className="p-3 border-b border-border shrink-0">
          <div className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSearch();
                }
              }}
              placeholder="Search notes…"
              className="flex-1 px-2 py-1.5 text-xs bg-input border border-border text-foreground placeholder:text-muted-foreground"
            />
            <button
              onClick={handleSearch}
              disabled={isSearching}
              className={cn(
                "px-2 py-1.5 text-foreground hover:bg-secondary transition-colors",
                isSearching && "opacity-50 cursor-not-allowed"
              )}
              title="Search"
            >
              <Search className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search Results */}
        <div className="flex-1 overflow-y-auto">
          {searchError ? (
            <div className="px-3 py-4 text-center text-xs text-destructive">
              {searchError}
            </div>
          ) : searchResults.length > 0 ? (
            <div className="divide-y divide-border/50">
              {searchResults.map((result, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSearchResultClick(result)}
                  className="w-full text-left px-3 py-2.5 hover:bg-secondary/50 transition-colors border-b border-border/50"
                >
                  <div className="text-[10px] font-semibold text-primary uppercase tracking-wider mb-1">
                    {result.agent}
                  </div>
                  <div className="text-[9px] text-muted-foreground uppercase tracking-wider mb-1">
                    {result.source}
                  </div>
                  <div className="text-xs text-foreground line-clamp-3 font-mono whitespace-normal">
                    {result.text}
                  </div>
                </button>
              ))}
            </div>
          ) : searchQuery.trim() ? (
            <div className="px-3 py-4 text-center text-muted-foreground text-xs">
              No results found
            </div>
          ) : (
            <div className="px-3 py-4 text-center text-muted-foreground text-xs">
              Enter a search query to find notes across agents
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
