"use client";

import { useState, useEffect } from "react";
import { 
  X, 
  UserPlus, 
  Key, 
  Shield, 
  Briefcase, 
  Globe, 
  Terminal, 
  Copy, 
  CheckCircle, 
  AlertCircle, 
  Loader2,
  ChevronRight,
  UserCheck,
  FileCode
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

interface EnrollmentOptions {
  roleTypes: string[];
  mcpPresets: string[];
  empires: string[];
  factions: string[];
  suggestions: Record<string, string>;
}

interface EnrollmentFormProps {
  onClose: () => void;
  onSuccess?: () => void;
}

export function EnrollmentForm({ onClose, onSuccess }: EnrollmentFormProps) {
  const { isAdmin } = useAuth();
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [options, setOptions] = useState<EnrollmentOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{ agentName: string; password?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  
  // Prompt deployment state
  const [promptPreview, setPromptPreview] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployDone, setDeployDone] = useState(false);

  // Form fields
  const [agentName, setAgentName] = useState("");
  const [username, setUsername] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [password, setPassword] = useState("");
  const [empire, setEmpire] = useState("");
  const [role, setRole] = useState("");
  const [roleType, setRoleType] = useState("");
  const [faction, setFaction] = useState("");
  const [mcpPreset, setMcpPreset] = useState("standard");

  useEffect(() => {
    async function fetchOptions() {
      try {
        const data = await apiFetch<EnrollmentOptions>("/agents/enrollment-options");
        setOptions(data);
        if (data.roleTypes.length > 0) setRoleType(data.roleTypes[0]);
        if (data.empires.length > 0) {
          setEmpire(data.empires[0]);
          setFaction(data.empires[0]);
          const suggestedRole = data.suggestions[data.empires[0]];
          if (suggestedRole) setRoleType(suggestedRole);
        }
      } catch (err) {
        console.error("Failed to fetch enrollment options:", err);
        setError("Failed to load enrollment options.");
      } finally {
        setLoading(false);
      }
    }
    fetchOptions();
  }, []);

  useEffect(() => {
    if (successData) {
      apiFetch<{ preview: string }>(`/agents/${successData.agentName}/prompt-preview`)
        .then(res => setPromptPreview(res.preview))
        .catch(err => console.error("Failed to fetch prompt preview:", err));
    }
  }, [successData]);

  const handleEmpireChange = (val: string) => {
    setEmpire(val);
    setFaction(val);
    if (options?.suggestions[val]) {
      setRoleType(options.suggestions[val]);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const payload: any = {
        agentName,
        username,
        role,
        roleType,
        faction,
        mcpPreset,
      };

      if (mode === "new") {
        payload.registrationCode = registrationCode;
        payload.empire = empire;
      } else {
        payload.password = password;
      }

      const res = await apiFetch<any>("/agents/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      setSuccessData({ agentName: res.agent.name, password: res.password });
      if (onSuccess) onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeploy = async () => {
    if (!successData) return;
    setDeploying(true);
    try {
      await apiFetch(`/agents/${successData.agentName}/deploy-prompt`, { method: "POST" });
      setDeployDone(true);
    } catch (err) {
      console.error("Manual deployment failed:", err);
      setError("Manual prompt deployment failed.");
    } finally {
      setDeploying(false);
    }
  };

  if (!isAdmin) return null;

  if (successData) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div className="bg-card border border-primary/30 w-full max-w-xl shadow-2xl animate-in fade-in zoom-in duration-200 max-h-[90vh] overflow-y-auto">
          <div className="p-6 space-y-6">
            <div className="flex flex-col items-center text-center space-y-2">
              <div className="w-12 h-12 rounded-full bg-success/20 flex items-center justify-center mb-2">
                <CheckCircle className="w-8 h-8 text-success" />
              </div>
              <h2 className="text-xl font-bold text-foreground">Enrollment Successful</h2>
              <p className="text-sm text-muted-foreground">
                Agent <strong>{successData.agentName}</strong> has been enrolled and configuration generated.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Password Section */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-warning border-b border-warning/20 pb-2">
                  <Key className="w-4 h-4" />
                  <h3 className="text-[10px] uppercase tracking-widest font-bold">Game Credentials</h3>
                </div>
                {successData.password ? (
                  <div className="bg-warning/5 border border-warning/30 p-4 space-y-3">
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Save this 256-bit key now. It is required for manual dashboard login.
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-background border border-border p-2 text-[9px] font-mono break-all text-foreground">
                        {successData.password}
                      </code>
                      <button
                        onClick={() => copyToClipboard(successData.password!)}
                        className="p-2 bg-secondary hover:bg-secondary/80 text-foreground border border-border transition-colors"
                      >
                        {copied ? <CheckCircle className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 border border-dashed border-border text-center">
                    <p className="text-[10px] text-muted-foreground italic">Existing credentials used.</p>
                  </div>
                )}
              </div>

              {/* Prompt Section */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-primary border-b border-primary/20 pb-2">
                  <FileCode className="w-4 h-4" />
                  <h3 className="text-[10px] uppercase tracking-widest font-bold">Prompt Deployment</h3>
                </div>
                {promptPreview ? (
                  <div className="space-y-3">
                    <textarea
                      readOnly
                      value={promptPreview}
                      className="w-full bg-background border border-border p-2 text-[9px] font-mono h-24 overflow-y-auto resize-none text-muted-foreground"
                    />
                    <button
                      onClick={handleDeploy}
                      disabled={deploying || deployDone}
                      className={cn(
                        "w-full py-2 text-[10px] uppercase tracking-widest font-bold flex items-center justify-center gap-2 transition-all",
                        deployDone 
                          ? "bg-success/20 text-success border border-success/30" 
                          : "bg-primary text-primary-foreground hover:opacity-90"
                      )}
                    >
                      {deploying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : deployDone ? <CheckCircle className="w-3.5 h-3.5" /> : "Deploy Prompt"}
                      {deployDone ? "Deployed" : "Confirm Deployment"}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-center p-8">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                )}
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-full py-3 bg-secondary text-foreground text-xs uppercase tracking-widest font-bold hover:bg-secondary/80 transition-colors border border-border"
            >
              Finish & Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-card border border-border w-full max-w-2xl shadow-2xl animate-in fade-in zoom-in duration-200 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-4 sticky top-0 bg-card z-10">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-primary" />
            <h2 className="text-sm font-bold uppercase tracking-widest">Enroll New Agent</h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-8">
          {/* Mode Toggle */}
          <div className="flex p-1 bg-secondary border border-border">
            <button
              type="button"
              onClick={() => setMode("new")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 text-[10px] uppercase tracking-wider transition-all",
                mode === "new" ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <UserPlus className="w-3.5 h-3.5" />
              New Account
            </button>
            <button
              type="button"
              onClick={() => setMode("existing")}
              className={cn(
                "flex-1 flex items-center justify-center gap-2 py-2 text-[10px] uppercase tracking-wider transition-all",
                mode === "existing" ? "bg-background text-primary shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <UserCheck className="w-3.5 h-3.5" />
              Existing Account
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Identity Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-primary border-b border-primary/20 pb-2">
                <Shield className="w-4 h-4" />
                <h3 className="text-[10px] uppercase tracking-widest font-bold">Identity & Auth</h3>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="agentName" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Agent Name (Fleet Identity)
                  </label>
                  <input
                    id="agentName"
                    type="text"
                    required
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                    placeholder="e.g. shadow-vane"
                    className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                  />
                  <p className="text-[9px] text-muted-foreground">Lowercase and hyphens only.</p>
                </div>

                <div className="space-y-1">
                  <label htmlFor="username" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Game Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Chosen game username"
                    className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                {mode === "new" ? (
                  <>
                    <div className="space-y-1">
                      <label htmlFor="empire" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                        Empire
                      </label>
                      <select
                        id="empire"
                        value={empire}
                        onChange={(e) => handleEmpireChange(e.target.value)}
                        className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        {options?.empires.map(e => (
                          <option key={e} value={e}>{e}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="registrationCode" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                        Registration Code
                      </label>
                      <input
                        id="registrationCode"
                        type="text"
                        required
                        value={registrationCode}
                        onChange={(e) => setRegistrationCode(e.target.value)}
                        placeholder="From spacemolt.com/dashboard"
                        className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                      />
                    </div>
                  </>
                ) : (
                  <div className="space-y-1">
                    <label htmlFor="password" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Password (256-bit key)
                    </label>
                    <input
                      id="password"
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Existing account key"
                      className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Role & Mission Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-primary border-b border-primary/20 pb-2">
                <Briefcase className="w-4 h-4" />
                <h3 className="text-[10px] uppercase tracking-widest font-bold">Role & Mission</h3>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <label htmlFor="role" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Role Description
                  </label>
                  <input
                    id="role"
                    type="text"
                    required
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    placeholder="e.g. Long-range Mining"
                    className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="roleType" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Role Type (Schema)
                  </label>
                  <select
                    id="roleType"
                    value={roleType}
                    onChange={(e) => setRoleType(e.target.value)}
                    className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary capitalize"
                  >
                    {options?.roleTypes.map(rt => (
                      <option key={rt} value={rt}>{rt}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label htmlFor="faction" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Faction
                  </label>
                  <input
                    id="faction"
                    type="text"
                    required
                    value={faction}
                    onChange={(e) => setFaction(e.target.value)}
                    placeholder="e.g. Solarian"
                    className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor="mcpPreset" className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    MCP Preset
                  </label>
                  <select
                    id="mcpPreset"
                    value={mcpPreset}
                    onChange={(e) => setMcpPreset(e.target.value)}
                    className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary capitalize"
                  >
                    {options?.mcpPresets.map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-error/10 border border-error/30 text-error text-[11px] flex items-start gap-2 animate-in slide-in-from-top-2 duration-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-border sticky bottom-0 bg-card pb-2">
            <button
              type="button"
              onClick={onClose}
              className="px-6 py-2.5 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground hover:bg-secondary border border-border transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || loading}
              className="px-8 py-2.5 bg-primary text-primary-foreground text-[10px] uppercase tracking-widest font-bold flex items-center gap-2 hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Enrolling…
                </>
              ) : (
                <>
                  Enroll Agent
                  <ChevronRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
