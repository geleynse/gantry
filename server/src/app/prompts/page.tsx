"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";
import { RefreshCw } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentInfo {
  name: string;
  promptFile: string;
  model: string | null;
  role: string | null;
  systemPrompt: string | null;
}

interface AgentsResponse {
  agents: AgentInfo[];
}

interface AssembledResponse {
  agentName: string;
  assembled: string;
  parts: {
    commonRules: string | null;
    agentPrompt: string | null;
    systemPrompt: string | null;
  };
}

interface CommonRulesResponse {
  filename: string;
  content: string;
}

interface SaveStatus {
  type: "success" | "error";
  text: string;
}

// ---------------------------------------------------------------------------
// Tab definitions
// ---------------------------------------------------------------------------

type TabId = "common-rules" | "agent-prompt" | "system-prompt" | "assembled";

const TABS: { id: TabId; label: string; editable: boolean }[] = [
  { id: "common-rules", label: "Common Rules", editable: true },
  { id: "agent-prompt", label: "Agent Prompt", editable: true },
  { id: "system-prompt", label: "System Prompt", editable: false },
  { id: "assembled", label: "Assembled Preview", editable: false },
];

// ---------------------------------------------------------------------------
// Loading dots
// ---------------------------------------------------------------------------

function LoadingDots() {
  return (
    <div className="flex items-center gap-1 py-8 justify-center">
      <span className="w-1.5 h-1.5 bg-primary animate-bounce [animation-delay:0ms]" />
      <span className="w-1.5 h-1.5 bg-primary animate-bounce [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 bg-primary animate-bounce [animation-delay:300ms]" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PromptsPageWrapper() {
  return (
    <Suspense>
      <PromptsPage />
    </Suspense>
  );
}

function PromptsPage() {
  const { isAdmin, loading: authLoading } = useAuth();
  const searchParams = useSearchParams();

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("agent-prompt");

  // Per-tab content state
  const [commonRulesContent, setCommonRulesContent] = useState<string | null>(null);
  const [agentPromptContent, setAgentPromptContent] = useState<string | null>(null);
  const [systemPromptContent, setSystemPromptContent] = useState<string | null>(null);
  const [assembledContent, setAssembledContent] = useState<string | null>(null);

  // Edit buffers (only for editable tabs)
  const [editingCommonRules, setEditingCommonRules] = useState(false);
  const [editingAgentPrompt, setEditingAgentPrompt] = useState(false);
  const [commonRulesDraft, setCommonRulesDraft] = useState("");
  const [agentPromptDraft, setAgentPromptDraft] = useState("");

  const [loading, setLoading] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);

  // ---------------------------------------------------------------------------
  // Load agent list
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setAgentsLoading(true);
    apiFetch<AgentsResponse>("/prompts/agents")
      .then((data) => {
        setAgents(data.agents);
        if (data.agents.length > 0) {
          // Pre-select agent from URL param (?agent=name) if present and valid
          const paramAgent = searchParams.get("agent");
          const match = paramAgent && data.agents.find((a) => a.name === paramAgent);
          setSelectedAgent(match ? paramAgent : data.agents[0].name);
        }
      })
      .catch((err) => console.error("Failed to load agents:", err))
      .finally(() => setAgentsLoading(false));
  }, []);

  // ---------------------------------------------------------------------------
  // Load tab content when agent or tab changes
  // ---------------------------------------------------------------------------

  const loadTabContent = useCallback(
    async (agent: string | null, tab: TabId) => {
      if (!agent) return;

      setLoading(true);
      setSaveStatus(null);

      try {
        if (tab === "common-rules") {
          const data = await apiFetch<CommonRulesResponse>("/prompts/common-rules");
          setCommonRulesContent(data.content);
          setCommonRulesDraft(data.content);
          setEditingCommonRules(false);
        } else if (tab === "agent-prompt") {
          const data = await apiFetch<AssembledResponse>(`/prompts/assembled/${agent}`);
          setAgentPromptContent(data.parts.agentPrompt);
          setAgentPromptDraft(data.parts.agentPrompt ?? "");
          setEditingAgentPrompt(false);
        } else if (tab === "system-prompt") {
          const data = await apiFetch<AssembledResponse>(`/prompts/assembled/${agent}`);
          setSystemPromptContent(data.parts.systemPrompt);
        } else if (tab === "assembled") {
          const data = await apiFetch<AssembledResponse>(`/prompts/assembled/${agent}`);
          setAssembledContent(data.assembled);
        }
      } catch (err) {
        console.error("Failed to load prompt content:", err);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (selectedAgent) {
      loadTabContent(selectedAgent, activeTab);
    }
  }, [selectedAgent, activeTab, loadTabContent]);

  // ---------------------------------------------------------------------------
  // Save handlers
  // ---------------------------------------------------------------------------

  async function handleSaveCommonRules() {
    setLoading(true);
    setSaveStatus(null);
    try {
      await apiFetch("/prompts/files/common-rules.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: commonRulesDraft }),
      });
      setCommonRulesContent(commonRulesDraft);
      setEditingCommonRules(false);
      setSaveStatus({ type: "success", text: "Saved." });
    } catch (err) {
      setSaveStatus({ type: "error", text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveAgentPrompt() {
    if (!selectedAgent) return;
    setLoading(true);
    setSaveStatus(null);
    try {
      await apiFetch(`/prompts/files/${selectedAgent}.txt`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: agentPromptDraft }),
      });
      setAgentPromptContent(agentPromptDraft);
      setEditingAgentPrompt(false);
      setSaveStatus({ type: "success", text: "Saved." });
    } catch (err) {
      setSaveStatus({ type: "error", text: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  function getTabContent(): string | null {
    switch (activeTab) {
      case "common-rules":
        return commonRulesContent;
      case "agent-prompt":
        return agentPromptContent;
      case "system-prompt":
        return systemPromptContent;
      case "assembled":
        return assembledContent;
      default:
        return null;
    }
  }

  const selectedAgentInfo = agents.find((a) => a.name === selectedAgent);
  const activeTabDef = TABS.find((t) => t.id === activeTab)!;
  const isEditingCurrentTab =
    activeTab === "common-rules" ? editingCommonRules : activeTab === "agent-prompt" ? editingAgentPrompt : false;

  // ---------------------------------------------------------------------------
  // Auth gate
  // ---------------------------------------------------------------------------

  if (authLoading) {
    return <LoadingDots />;
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">Admin access required to view prompt management.</p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-primary/20 pb-4 mb-4 shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-primary uppercase tracking-wider">Prompts</h1>
          <p className="text-xs text-muted-foreground mt-1">
            View and edit fleet agent prompt files.
          </p>
        </div>
      </div>

      <div className="flex flex-1 min-h-0 gap-0">
        {/* Left sidebar — agent list */}
        <aside className="w-[180px] shrink-0 bg-card border border-border overflow-y-auto flex flex-col">
          <div className="px-3 py-2 border-b border-border bg-secondary/30 text-[10px] uppercase tracking-wider text-foreground/70 sticky top-0 z-10">
            Agents
          </div>
          {agentsLoading ? (
            <LoadingDots />
          ) : (
            <ul className="flex-1">
              {agents.map((agent) => (
                <li key={agent.name}>
                  <button
                    onClick={() => setSelectedAgent(agent.name)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 text-xs transition-colors border-b border-border/50",
                      selectedAgent === agent.name
                        ? "bg-primary/10 text-primary font-medium"
                        : "text-foreground hover:bg-secondary/50"
                    )}
                  >
                    <div className="font-medium truncate">{agent.name}</div>
                    {agent.role && (
                      <div className="text-[10px] text-muted-foreground truncate mt-0.5">{agent.role}</div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Main content area */}
        <div className="flex-1 flex flex-col min-w-0 border border-l-0 border-border bg-background">
          {/* Tab bar */}
          <div className="flex items-center border-b border-border bg-card shrink-0">
            <div className="flex gap-0 overflow-x-auto flex-1">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "px-3 py-2 text-[10px] uppercase tracking-wider cursor-pointer whitespace-nowrap transition-colors",
                    activeTab === tab.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 px-3 shrink-0">
              {saveStatus && (
                <span
                  className={cn(
                    "text-[10px] font-medium",
                    saveStatus.type === "success" ? "text-success" : "text-error"
                  )}
                >
                  {saveStatus.text}
                </span>
              )}

              {activeTabDef.editable && isAdmin && (
                <>
                  {isEditingCurrentTab ? (
                    <>
                      <button
                        onClick={() => {
                          if (activeTab === "common-rules") setEditingCommonRules(false);
                          else setEditingAgentPrompt(false);
                          setSaveStatus(null);
                        }}
                        className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={activeTab === "common-rules" ? handleSaveCommonRules : handleSaveAgentPrompt}
                        disabled={loading}
                        className="px-2 py-1 text-[10px] uppercase tracking-wider bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity"
                      >
                        Save
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => {
                        if (activeTab === "common-rules") setEditingCommonRules(true);
                        else setEditingAgentPrompt(true);
                        setSaveStatus(null);
                      }}
                      disabled={loading}
                      className="px-2 py-1 text-[10px] uppercase tracking-wider bg-secondary text-foreground hover:bg-secondary/80 disabled:opacity-50 transition-colors"
                    >
                      Edit
                    </button>
                  )}
                </>
              )}

              <button
                onClick={() => loadTabContent(selectedAgent, activeTab)}
                disabled={loading}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                title="Refresh"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-auto p-0">
            {loading ? (
              <LoadingDots />
            ) : !selectedAgent ? (
              <div className="py-16 text-center text-xs text-muted-foreground italic">
                Select an agent to view prompts.
              </div>
            ) : isEditingCurrentTab && activeTabDef.editable ? (
              <textarea
                value={activeTab === "common-rules" ? commonRulesDraft : agentPromptDraft}
                onChange={(e) => {
                  if (activeTab === "common-rules") setCommonRulesDraft(e.target.value);
                  else setAgentPromptDraft(e.target.value);
                }}
                className="w-full h-full bg-background border-0 text-foreground font-mono text-xs p-4 resize-none focus:outline-none"
                spellCheck={false}
              />
            ) : getTabContent() !== null ? (
              <pre className="whitespace-pre-wrap font-mono text-xs text-foreground break-words p-4 leading-relaxed">
                {getTabContent()}
              </pre>
            ) : (
              <div className="py-16 text-center text-xs text-muted-foreground italic">
                {activeTab === "system-prompt" && selectedAgentInfo
                  ? "No system prompt configured for this agent."
                  : "Content not available."}
              </div>
            )}
          </div>

          {/* Footer: agent info */}
          {selectedAgentInfo && (
            <div className="shrink-0 border-t border-border bg-card px-4 py-2 flex items-center gap-4">
              <span className="text-[10px] uppercase tracking-wider text-foreground/70">{selectedAgentInfo.name}</span>
              {selectedAgentInfo.model && (
                <span className="text-[10px] text-muted-foreground">
                  model: <span className="font-mono">{selectedAgentInfo.model}</span>
                </span>
              )}
              {selectedAgentInfo.role && (
                <span className="text-[10px] text-muted-foreground">{selectedAgentInfo.role}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
