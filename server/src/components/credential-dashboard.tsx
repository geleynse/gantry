"use client";

import { useState, useEffect } from "react";
import { 
  Key, 
  RefreshCw, 
  Trash2, 
  CheckCircle, 
  XCircle, 
  AlertCircle, 
  Loader2, 
  History,
  ShieldCheck,
  User,
  Clock,
  ExternalLink
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/hooks/use-auth";

interface CredentialStatus {
  name: string;
  hasCredentials: boolean;
  username: string | null;
}

interface AuditEvent {
  id: number;
  timestamp: string;
  agent_name: string;
  action: string;
  actor: string | null;
  details: string | null;
}

export function CredentialDashboard() {
  const { isAdmin } = useAuth();
  const [credentials, setCredentials] = useState<CredentialStatus[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Update Modal State
  const [updatingAgent, setUpdatingAgent] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);

  const fetchData = async () => {
    setRefreshing(true);
    try {
      const [creds, audit] = await Promise.all([
        apiFetch<CredentialStatus[]>("/credentials"),
        apiFetch<AuditEvent[]>("/credentials/audit?limit=50")
      ]);
      setCredentials(creds);
      setAuditLog(audit);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch credentials data:", err);
      setError("Failed to load credential data.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleUpdate = async () => {
    if (!updatingAgent || !newUsername || !newPassword) return;
    setUpdateBusy(true);
    try {
      await apiFetch(`/credentials/${updatingAgent}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: newUsername, password: newPassword }),
      });
      setUpdatingAgent(null);
      setNewUsername("");
      setNewPassword("");
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleRemove = async (agentName: string) => {
    if (!confirm(`Are you sure you want to remove credentials for ${agentName}?`)) return;
    try {
      await apiFetch(`/credentials/${agentName}`, { method: "DELETE" });
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Removal failed");
    }
  };

  if (!isAdmin) return null;

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-xs text-muted-foreground uppercase tracking-widest">Loading credentials…</span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Key className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-bold uppercase tracking-widest">Credential Management</h2>
        </div>
        <button
          onClick={fetchData}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border transition-colors"
        >
          <RefreshCw className={cn("w-3 h-3", refreshing && "animate-spin")} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 bg-error/10 border border-error/30 text-error text-[11px] flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Credentials Table */}
      <div className="bg-card border border-border overflow-hidden">
        <table className="w-full text-left text-xs">
          <thead className="bg-secondary/50 border-b border-border">
            <tr>
              <th className="px-4 py-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Agent</th>
              <th className="px-4 py-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Status</th>
              <th className="px-4 py-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Username</th>
              <th className="px-4 py-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {credentials.map((cred) => (
              <tr key={cred.name} className="hover:bg-secondary/20 transition-colors">
                <td className="px-4 py-3 font-mono text-primary">{cred.name}</td>
                <td className="px-4 py-3">
                  {cred.hasCredentials ? (
                    <div className="flex items-center gap-1.5 text-success">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span className="text-[10px] uppercase tracking-wider">Configured</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-error opacity-70">
                      <XCircle className="w-3.5 h-3.5" />
                      <span className="text-[10px] uppercase tracking-wider">Missing</span>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {cred.username || "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => {
                        setUpdatingAgent(cred.name);
                        setNewUsername(cred.username || "");
                      }}
                      className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/5 border border-border transition-all"
                      title="Update credentials"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleRemove(cred.name)}
                      className="p-1.5 text-muted-foreground hover:text-error hover:bg-error/5 border border-border transition-all"
                      title="Remove credentials"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Audit Log */}
      <div className="space-y-4">
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <History className="w-4 h-4 text-primary" />
          <h3 className="text-[10px] uppercase tracking-widest font-bold">Enrollment Audit Log</h3>
        </div>

        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-2">
          {auditLog.map((event) => (
            <div key={event.id} className="bg-card border border-border p-3 flex items-start gap-4 hover:border-primary/30 transition-colors">
              <div className={cn(
                "p-2 rounded-full",
                event.action === "enrolled" ? "bg-success/10 text-success" :
                event.action === "credential_updated" ? "bg-primary/10 text-primary" :
                event.action === "credential_removed" ? "bg-error/10 text-error" :
                "bg-secondary text-muted-foreground"
              )}>
                {event.action === "enrolled" ? <User className="w-4 h-4" /> :
                 event.action === "credential_updated" ? <ShieldCheck className="w-4 h-4" /> :
                 event.action === "credential_removed" ? <Trash2 className="w-4 h-4" /> :
                 <History className="w-4 h-4" />}
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-foreground">
                    Agent <span className="text-primary font-mono">{event.agent_name}</span> {event.action.replace(/_/g, " ")}
                  </span>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    {new Date(event.timestamp).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-[10px]">
                  <span className="text-muted-foreground">
                    Actor: <span className="text-foreground">{event.actor || "system"}</span>
                  </span>
                  {event.details && (
                    <span className="text-muted-foreground truncate max-w-md">
                      Details: <span className="text-foreground/80 font-mono">{event.details}</span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
          {auditLog.length === 0 && (
            <div className="text-center py-8 text-xs text-muted-foreground border border-dashed border-border uppercase tracking-widest">
              No audit events recorded
            </div>
          )}
        </div>
      </div>

      {/* Update Modal */}
      {updatingAgent && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-card border border-border w-full max-w-sm shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="p-4 border-b border-border flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-widest">Update Credentials</h3>
              <button onClick={() => setUpdatingAgent(null)} className="text-muted-foreground hover:text-foreground">
                <XCircle className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Agent</label>
                <div className="text-sm font-mono text-primary">{updatingAgent}</div>
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Username</label>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Password (256-bit key)</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Paste new 256-bit key"
                  className="w-full bg-background border border-border text-xs px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-primary font-mono"
                />
              </div>
              <div className="pt-2 flex gap-2">
                <button
                  onClick={() => setUpdatingAgent(null)}
                  className="flex-1 py-2 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdate}
                  disabled={updateBusy || !newUsername || !newPassword}
                  className="flex-1 py-2 bg-primary text-primary-foreground text-[10px] uppercase tracking-wider font-bold hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {updateBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Update"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
