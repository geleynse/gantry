"use client";

/**
 * PrayerCanaryButton — admin-only button that starts a prayer canary run.
 *
 * Canary starts a fresh agent session with a system prompt that directs
 * the agent to call spacemolt_pray as its first action and exit. Only
 * valid when the agent is NOT running (startAgentCanary rejects otherwise).
 */

import { useState } from "react";
import { Sparkles, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api";

interface CanaryResponse {
  ok: boolean;
  message: string;
}

export function PrayerCanaryButton({
  agentName,
  isRunning,
  prayEnabled,
  onCanaryStarted,
}: {
  agentName: string;
  isRunning: boolean;
  prayEnabled: boolean;
  /**
   * Fired after a successful POST /api/prayer-canary. The button itself
   * already disables while busy, but useFleetStatus is SSE-only with no
   * manual refetch, so the parent may want to apply a short cooldown
   * window so the user can't double-click before the SSE update arrives.
   */
  onCanaryStarted?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CanaryResponse | null>(null);

  if (!prayEnabled) return null;

  const disabled = busy || isRunning;
  const disabledReason = isRunning
    ? "Agent is running — stop it first"
    : null;

  async function run() {
    setBusy(true);
    setResult(null);
    setConfirming(false);
    try {
      const res = await apiFetch<CanaryResponse>(`/prayer-canary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: agentName }),
      });
      setResult(res);
      if (res.ok) onCanaryStarted?.();
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message ?? "Failed to start canary" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-card border border-border p-4 space-y-3">
      <div className="border-b border-border pb-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-violet-400" />
          <h3 className="text-[10px] uppercase tracking-wider text-foreground/70">Prayer Canary</h3>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          Starts a fresh session that fires a <code className="font-mono">spacemolt_pray</code> call and exits — verifies PrayerLang routing end-to-end.
        </p>
      </div>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={disabled}
          title={disabledReason ?? undefined}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-wider border transition-colors",
            "bg-violet-500/10 text-violet-400 border-violet-500/30 hover:bg-violet-500/20",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          <Sparkles className="w-3 h-3" />
          Run Canary
        </button>
      ) : (
        <div className="flex items-center gap-2 bg-violet-500/5 border border-violet-500/30 px-3 py-2">
          <span className="text-[11px] text-violet-300 flex-1">
            Run prayer canary on <strong>{agentName}</strong>?
          </span>
          <button
            onClick={run}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-1 bg-violet-500 text-white text-[10px] uppercase tracking-wider font-bold hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2 className="w-3 h-3 animate-spin" />}
            Confirm
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border hover:bg-secondary transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {isRunning && !confirming && !result && (
        <div className="text-[11px] text-muted-foreground italic">
          Stop the agent before running a canary.
        </div>
      )}

      {result && result.ok && (
        <div className="flex items-start gap-1.5 text-[11px] text-success">
          <CheckCircle className="w-3 h-3 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div>{result.message}</div>
            <div className="text-muted-foreground text-[10px]">
              Watch the agent&apos;s Activity tab — the first tool call should be <code className="font-mono">pray</code>.
            </div>
          </div>
        </div>
      )}
      {result && !result.ok && (
        <div className="flex items-start gap-1.5 text-[11px] text-error">
          <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
          <div>{result.message}</div>
        </div>
      )}
    </div>
  );
}
