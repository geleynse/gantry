/**
 * Shared pipeline functions for v1 and v2 MCP proxy servers.
 *
 * These functions were previously duplicated inside createGantryServer() (v1) and
 * createGantryServerV2() (v2) in server.ts. They are extracted here to eliminate
 * duplication and make each function independently testable.
 */

import { createLogger } from "../lib/logger.js";
import type { MetricsWindow } from "./instability-metrics.js";
import type { DirectiveRow } from "../services/directives.js";
export type { DirectiveRow };
import { checkToolBlocked } from "./instability-hints.js";
import { persistCallTracker } from "./cache-persistence.js";
import { getCapacityForTier } from "../services/faction-monitor.js";
import { DENIED_ACTIONS_V2 } from "./schema.js";
import { shouldAutoTriggerCombat, shouldAutoFlee, getAutoTriggerAction, isCombatAgent } from "./combat-auto-trigger.js";
import { hasSignal } from "../services/signals-db.js";
import { getSessionShutdownManager } from "./session-shutdown.js";
import type { GantryConfig } from "../config.js";
import type { AgentCallTracker, BattleState } from "./server.js";
import type { EventBuffer } from "./event-buffer.js";
import type { SessionStore } from "./session-store.js";
import type { InjectionRegistry } from "./injection-registry.js";
import type { TransitThrottle } from "./transit-throttle.js";

const log = createLogger("pipeline");

// Config-driven per-session call limits from fleet-config.json callLimits.

export interface FleetOrder {
  id: number;
  message: string;
  priority: string;
}

/**
 * Context object passed to all pipeline functions.
 * Holds shared state maps and callback functions to avoid circular imports with server.ts.
 */
// BattleState is defined in server.ts and re-exported here for convenience
export type { BattleState } from "./server.js";

export interface PipelineContext {
  config: GantryConfig;
  sessionAgentMap: Map<string, string>;
  callTrackers: Map<string, AgentCallTracker>;
  eventBuffers: Map<string, EventBuffer>;
  battleCache: Map<string, BattleState | null>;
  statusCache?: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  callLimits: Record<string, number>;
  sessionStore?: SessionStore;
  serverMetrics: MetricsWindow;
  // Callbacks to avoid circular imports with server.ts
  getFleetPendingOrders: (agentName: string) => FleetOrder[];
  markOrderDelivered: (orderId: number, agentName: string) => void;
  reformatResponse: (text: string, format: "json" | "yaml", label: string) => string;
  // Optional: active directives getter + per-agent call counter for frequency limiting
  getActiveDirectives?: (agentName: string) => DirectiveRow[];
  directivesCallCounters?: Map<string, number>;
  // Registry of pipeline injections (critical events, orders, battle status, etc.)
  injectionRegistry: InjectionRegistry;
  // Optional transit throttle for rate-limiting location checks during hyperspace
  transitThrottle?: TransitThrottle;
  // Tracks which agents have already received the shutdown warning this turn
  shutdownWarningFired?: Set<string>;
  // Optional: session manager for restart recovery (maps orphan sessions to agents)
  sessions?: { listActive: () => string[]; getClient: (name: string) => { isAuthenticated: () => boolean } | undefined };
}

// ---------------------------------------------------------------------------
// Session / agent helpers
// ---------------------------------------------------------------------------

/**
 * Look up the agent name for an MCP session ID.
 * Returns undefined if no agent is bound to this session.
 */
export function getAgentForSession(
  ctx: PipelineContext,
  sessionId?: string,
): string | undefined {
  if (!sessionId) return undefined;
  // Primary: in-memory map (fast path)
  const mapped = ctx.sessionAgentMap.get(sessionId);
  if (mapped) {
    // Touch DB session to keep rolling TTL alive — without this, the in-memory
    // map short-circuits getSession() and the DB TTL never renews, causing the
    // 60s cleanup interval to reap valid sessions after SESSION_TTL_MS.
    ctx.sessionStore?.getSession(sessionId);
    return mapped;
  }
  // Fallback: persistent session store (handles transport reap / restart)
  const session = ctx.sessionStore?.getSession(sessionId);
  if (session?.agent) {
    // Re-populate in-memory map for subsequent calls this turn
    ctx.sessionAgentMap.set(sessionId, session.agent);
    log.info("recovered agent from session store", { agent: session.agent, session: sessionId.slice(0, 8) });
    return session.agent;
  }
  // Server-restart recovery: if exactly one authenticated game client has no
  // current MCP session mapping, assume this orphaned session belongs to it.
  if (ctx.sessions) {
    const allAgents = ctx.sessions.listActive();
    const mappedAgents = new Set(ctx.sessionAgentMap.values());
    const unmapped = allAgents.filter(a => !mappedAgents.has(a) && ctx.sessions!.getClient(a)?.isAuthenticated());
    if (unmapped.length === 1) {
      const agent = unmapped[0];
      ctx.sessionAgentMap.set(sessionId, agent);
      ctx.sessionStore?.setSessionAgent?.(sessionId, agent);
      log.info(`recovered session for ${agent} (server restart recovery)`, { session: sessionId.slice(0, 8) });
      return agent;
    } else if (unmapped.length > 1) {
      log.warn("ambiguous restart recovery — multiple unmatched agents", { candidates: unmapped, session: sessionId.slice(0, 8) });
    }
  }
  return undefined;
}

/**
 * Get or create an AgentCallTracker for the given agent.
 * A fresh tracker is created (and stored) if none exists.
 */
export function getTracker(
  ctx: PipelineContext,
  agentName: string,
): AgentCallTracker {
  let tracker = ctx.callTrackers.get(agentName);
  if (!tracker) {
    tracker = { counts: {}, lastCallSig: null, calledTools: new Set() };
    ctx.callTrackers.set(agentName, tracker);
  }
  return tracker;
}

/**
 * Reset an agent's call tracker to a fresh state and persist it.
 * Called on login to start each session with clean counters.
 */
export function resetTracker(ctx: PipelineContext, agentName: string): void {
  const fresh: AgentCallTracker = {
    counts: {},
    lastCallSig: null,
    calledTools: new Set<string>(),
  };
  ctx.callTrackers.set(agentName, fresh);
  persistCallTracker(agentName, fresh);
}

/**
 * Look up the preferred tool result format ("json" | "yaml") for an agent.
 * Defaults to "json" if not configured.
 */
export function getAgentFormat(
  config: GantryConfig,
  agentName: string,
): "json" | "yaml" {
  return config.agents.find((a) => a.name === agentName)?.toolResultFormat ?? "json";
}

/**
 * Wrapper for PipelineContext-based auto-trigger check (used in gantry-v2.ts).
 */
export function getAutoTriggerActionFromContext(
  ctx: PipelineContext,
  agentName: string,
  originalAction: string,
): string {
  // Extract hull percentage if available in status cache
  let hullPercent: number | undefined;
  const cached = ctx.statusCache?.get(agentName);
  if (cached?.data?.ship) {
    const ship = cached.data.ship as Record<string, unknown>;
    const hull = Number(ship.hull);
    const maxHull = Number(ship.max_hull);
    if (!isNaN(hull) && !isNaN(maxHull) && maxHull > 0) {
      hullPercent = (hull / maxHull) * 100;
    }
  }

  return getAutoTriggerAction(ctx.config, ctx.eventBuffers, agentName, originalAction, hullPercent);
}

// ---------------------------------------------------------------------------

/**
 * Build a v1 call signature string for duplicate detection.
 * Format: "toolName:argsJSON"
 */
export function callSignatureV1(
  toolName: string,
  args?: Record<string, unknown>,
): string {
  const argStr =
    args && Object.keys(args).length > 0
      ? JSON.stringify(args, Object.keys(args).sort())
      : "";
  return `${toolName}:${argStr}`;
}

/**
 * Build a v2 call signature string for duplicate detection.
 * Includes the action field in the signature, but excludes it from argStr.
 * Format: "toolName:action:filteredArgsJSON"
 *
 * The action is sourced from (in priority order):
 *  1. The explicit `actionOverride` param (used when action is a separate parameter)
 *  2. `args.action` (used when action is embedded in the args object)
 */
export function callSignatureV2(
  toolName: string,
  args?: Record<string, unknown>,
  actionOverride?: string,
): string {
  const actionVal = actionOverride ?? (args?.action as string | undefined);
  const action = actionVal ? `:${actionVal}` : "";
  const filteredArgs = args
    ? Object.fromEntries(Object.entries(args).filter(([k]) => k !== "action"))
    : {};
  const argStr =
    Object.keys(filteredArgs).length > 0
      ? JSON.stringify(filteredArgs, Object.keys(filteredArgs).sort())
      : "";
  return `${toolName}${action}:${argStr}`;
}

// ---------------------------------------------------------------------------
// Captain's log decontamination
// ---------------------------------------------------------------------------

/**
 * Strip contaminated captain's log entries from a game response.
 * Entries containing any of the contamination words are replaced with a
 * redaction notice to prevent agents from acting on hallucinated state.
 *
 * @param result         Raw game server response (mutated in place for arrays)
 * @param contaminationWords  List of words that indicate a contaminated entry
 */
export function decontaminateLog(
  result: unknown,
  contaminationWords: string[],
): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;

  // Extract text from an entry object or string
  function getEntryText(entry: unknown): string {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.entry === "string") return e.entry;
      if (typeof e.text === "string") return e.text;
    }
    return "";
  }

  // Replace entry text in an entry object or string
  function redactEntry(entry: unknown, replacement: string): unknown {
    if (typeof entry === "string") return replacement;
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.entry === "string")
        return { ...e, entry: replacement, redacted: true };
      if (typeof e.text === "string")
        return { ...e, text: replacement, redacted: true };
      return { ...e, entry: replacement, redacted: true };
    }
    return replacement;
  }

  const REDACTED_MSG =
    "[REDACTED — old entry contained false claims. Ignore and proceed normally.]";

  // Array of entries format: { entries: [...] }
  // Filter out contaminated entries entirely — agents never see them
  if (Array.isArray(obj.entries)) {
    obj.entries = (obj.entries as unknown[]).filter((entry) => {
      const text = getEntryText(entry).toLowerCase();
      return !contaminationWords.some((w) => text.includes(w));
    });
  }

  // Single entry format: { entry: { index: 0, entry: "...", created_at: "..." } }
  if (obj.entry && typeof obj.entry === "object") {
    const text = getEntryText(obj.entry).toLowerCase();
    if (contaminationWords.some((w) => text.includes(w))) {
      obj.entry = redactEntry(obj.entry, REDACTED_MSG);
    }
  } else if (typeof obj.entry === "string") {
    const text = obj.entry.toLowerCase();
    if (contaminationWords.some((w) => text.includes(w))) {
      obj.entry = REDACTED_MSG;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Offline proxy blocking
// ---------------------------------------------------------------------------

/**
 * Check if an MCP session is currently active (not expired or offline).
 * Returns false if:
 *  - sessionId is not provided (agent not connected)
 *  - sessionStore is not available (can't validate — fail safely)
 *  - Session is expired or doesn't exist in the store
 *
 * Used in checkGuardrailsV2() to reject tool calls from disconnected agents.
 *
 * @param ctx Pipeline context (must include sessionStore for runtime)
 * @param sessionId MCP session ID from the request
 * @returns true if session is valid and active, false if offline/expired/missing
 */
export function isProxySessionActive(
  ctx: PipelineContext,
  sessionId?: string,
): boolean {
  // If no sessionId provided, agent is definitively not connected
  if (!sessionId) {
    return false;
  }

  // If sessionStore not available, fail safely (can't validate session)
  if (!ctx.sessionStore) {
    return false;
  }

  // Check if session is valid in persistent store
  return ctx.sessionStore.isValidSession(sessionId);
}

// ---------------------------------------------------------------------------
// Iteration limit guardrail (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Check if an agent's session has exceeded the max iterations per session.
 * Increments the iteration count and returns an error if exceeded.
 *
 * @param ctx Pipeline context (must include sessionStore and config)
 * @param sessionId MCP session ID
 * @returns Error message if limit exceeded, null otherwise
 */
export function checkIterationLimit(
  ctx: PipelineContext,
  sessionId?: string,
): string | null {
  if (!sessionId || !ctx.sessionStore) {
    return null; // Skip if no session store (test mode)
  }

  const maxIterations = ctx.config.maxIterationsPerSession ?? 200;
  const newCount = ctx.sessionStore.incrementIterationCount(sessionId);

  if (newCount > maxIterations) {
    log.info("blocked tool call — iteration limit exceeded", {
      session: sessionId?.slice(0, 8),
      iterations: newCount,
      maxIterations,
    });
    return `ERROR: Session iteration limit exceeded (${newCount}/${maxIterations}). Please logout and login to start a fresh session.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Turn timeout and idle monitoring guardrails (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Check if an agent's turn has exceeded the max duration.
 * Idle agents who haven't seen activity in idleTimeoutMs are disconnected.
 *
 * @param ctx Pipeline context (must include sessionStore and config)
 * @param sessionId MCP session ID
 * @returns Error message if turn timeout or idle, null otherwise
 */
export function checkTurnTimeoutAndIdle(
  ctx: PipelineContext,
  sessionId?: string,
): string | null {
  if (!sessionId || !ctx.sessionStore) {
    return null; // Skip if no session store (test mode)
  }

  const session = ctx.sessionStore.getSession(sessionId);
  if (!session) {
    return null; // Session already expired
  }

  const now = Date.now();
  // getSession() already updated last_seen_at to "now" in the DB, but returns
  // the OLD value. Use the current time minus a small margin to avoid false positives.
  // The real idle gap is between the PREVIOUS call's getSession() update and this one.
  const lastSeenMs = new Date(session.lastSeenAt).getTime();
  const idleTimeoutMs = ctx.config.idleTimeoutMs ?? 5 * 60 * 1000; // 5 minutes (routines can take 3+ min)

  // Check idle timeout (no activity for X minutes)
  if (now - lastSeenMs > idleTimeoutMs) {
    log.info("blocked tool call — agent idle too long", {
      session: sessionId?.slice(0, 8),
      lastSeenMinutesAgo: Math.round((now - lastSeenMs) / 1000 / 60),
      idleTimeoutMinutes: Math.round(idleTimeoutMs / 1000 / 60),
    });
    // Expire the session to force re-login
    ctx.sessionStore.expireAgentSessions(session.agent || "unknown");
    return `ERROR: Your session has been idle for too long. Please login again.`;
  }

  // Check turn timeout (turn duration exceeded)
  const turnStartedAt = ctx.sessionStore.getTurnStartedAt(sessionId);
  if (turnStartedAt) {
    const turnStartMs = new Date(turnStartedAt).getTime();
    const maxTurnDurationMs = ctx.config.maxTurnDurationMs ?? 20 * 60 * 1000; // 20 minutes default

    if (now - turnStartMs > maxTurnDurationMs) {
      // Grace period: allow cleanup actions (logout, captain's log) for 2 extra minutes
      // so agents can save their state before being fully cut off.
      const GRACE_PERIOD_MS = 2 * 60 * 1000;
      const overageMs = now - turnStartMs - maxTurnDurationMs;

      if (overageMs > GRACE_PERIOD_MS) {
        // Hard cutoff — no more grace
        log.info("blocked tool call — turn timeout exceeded (past grace period)", {
          session: sessionId?.slice(0, 8),
          turnMinutesDuration: Math.round((now - turnStartMs) / 1000 / 60),
          maxTurnMinutes: Math.round(maxTurnDurationMs / 1000 / 60),
        });
        return `ERROR: Your turn has exceeded the maximum duration (${Math.round(maxTurnDurationMs / 1000 / 60)} minutes). Please logout and login to start a new turn.`;
      }

      // In grace period — log a warning but allow the call through.
      // The error message tells the agent to wrap up immediately.
      log.info("turn timeout — grace period active, allowing cleanup", {
        session: sessionId?.slice(0, 8),
        turnMinutesDuration: Math.round((now - turnStartMs) / 1000 / 60),
        graceRemainingSeconds: Math.round((GRACE_PERIOD_MS - overageMs) / 1000),
      });
      // Don't block — return null to let the call through, but the next
      // pipeline stage will prepend a warning via server_notice.
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// validateCaptainsLogFormat
// ---------------------------------------------------------------------------

/**
 * Count sentence boundaries in text, ignoring periods in decimals/versions/percentages.
 * A sentence boundary is [.!?;] that is NOT adjacent to a digit and is followed by
 * whitespace+letter or end of string. Returns the number of sentences (>=1).
 */
export function countSentenceBoundaries(text: string): number {
  // Match sentence-ending punctuation that represents a real boundary:
  // - NOT preceded by a digit (negative lookbehind)
  // - The punctuation itself: [.!?;]
  // - NOT followed by a digit (negative lookahead)
  // - Followed by whitespace+letter OR end of string
  const boundaryPattern = /(?<!\d)[.!?;](?!\d)(?=\s+[A-Za-z]|$)/g;
  const boundaries = text.match(boundaryPattern);
  // Number of sentences = number of boundaries, minimum 1 (the text itself is at least 1 sentence)
  return Math.max(1, boundaries ? boundaries.length : 0);
}

/**
 * Validate captain's log format compliance.
 *
 * The agent must write EXACTLY 4 lines with the format:
 *   LOC: [system] [poi_id] [docked/undocked]
 *   CR: [credits] | FUEL: [cur/max] | CARGO: [used/max]
 *   DID: [1 sentence]
 *   NEXT: [1 sentence with POI IDs]
 *
 * Returns { valid: true } if format is correct.
 * Returns { valid: false, error: string } if format is incorrect.
 *
 * @param entry The captain's log entry text (full content)
 */
export function validateCaptainsLogFormat(entry: string): { valid: true } | { valid: false; error: string } {
  if (!entry || typeof entry !== "string") {
    return { valid: false, error: "Captain's log entry must be a non-empty string." };
  }

  const trimmed = entry.trim();
  const lines = trimmed.split("\n").map(l => l.trimEnd());

  // Must be exactly 4 lines
  if (lines.length !== 4) {
    return {
      valid: false,
      error: `Captain's log must be EXACTLY 4 lines (you wrote ${lines.length}). Format: LOC / CR / DID / NEXT.`,
    };
  }

  // Validate line 1: LOC: [system] [poi] [docked/undocked]
  const loc = lines[0].trim();
  if (!loc.startsWith("LOC:")) {
    return {
      valid: false,
      error: `Line 1 must start with "LOC:" (you wrote: "${loc.slice(0, 30)}...").`,
    };
  }
  const locContent = loc.slice(4).trim();
  const locParts = locContent.split(/\s+/);
  if (!locContent || locParts.length < 3) {
    return {
      valid: false,
      error: `Line 1 (LOC) must include system, POI ID, and dock status (e.g., "LOC: sol main_belt undocked"). You wrote "${locContent}"`,
    };
  }

  // Validate line 2: CR: [amount] | FUEL: [cur/max] | CARGO: [used/max]
  const cr = lines[1].trim();
  if (!cr.startsWith("CR:")) {
    return {
      valid: false,
      error: `Line 2 must start with "CR:" (you wrote: "${cr.slice(0, 30)}...").`,
    };
  }
  // Must have exactly 2 pipes separating 3 sections: CR | FUEL | CARGO
  const crParts = cr.split("|").map(p => p.trim());
  if (crParts.length !== 3 || !crParts[1].startsWith("FUEL:") || !crParts[2].startsWith("CARGO:")) {
    return {
      valid: false,
      error: `Line 2 (CR) must have format: "CR: [amount] | FUEL: [cur/max] | CARGO: [used/max]"`,
    };
  }

  // Validate line 3: DID: [1 sentence]
  const did = lines[2].trim();
  if (!did.startsWith("DID:")) {
    return {
      valid: false,
      error: `Line 3 must start with "DID:" (you wrote: "${did.slice(0, 30)}...").`,
    };
  }
  const didContent = did.slice(4).trim();
  if (!didContent) {
    return {
      valid: false,
      error: `Line 3 (DID) must contain 1 sentence describing what you did this session.`,
    };
  }
  // DID can be multiple sentences — no sentence count restriction

  // Validate line 4: NEXT: [plan with POI IDs]
  const next = lines[3].trim();
  if (!next.startsWith("NEXT:")) {
    return {
      valid: false,
      error: `Line 4 must start with "NEXT:" (you wrote: "${next.slice(0, 30)}...").`,
    };
  }
  const nextContent = next.slice(5).trim();
  if (!nextContent) {
    return {
      valid: false,
      error: `Line 4 (NEXT) must contain 1 sentence describing your next plan (include POI IDs if relevant).`,
    };
  }
  // NEXT can be multiple sentences — no sentence count restriction

  // Success
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

/**
 * Check guardrails for a v1 tool call.
 * Returns an error message string if blocked, or null if the call is allowed.
 *
 * Checks (in order):
 *  1. Instability gate — blocks risky tools during degradation
 *  2. Per-agent denied tools (global "*" and agent-specific)
 *  3. Duplicate detection — blocks identical consecutive calls
 *  4. Per-session call limits (hardcoded + config-driven)
 */
export function checkGuardrailsV1(
  ctx: PipelineContext,
  agentName: string,
  toolName: string,
  args?: Record<string, unknown>,
): string | null {
  // Check for shutdown signal — return immediately if pending.
  // IMPORTANT: Do NOT consume the signal here. The runner process also polls
  // for this signal to abort the turn. If we consume it, the runner never sees
  // it and the agent process won't stop until the 180s hard kill timeout.
  if (hasSignal(agentName, "shutdown")) {
    log.info("shutdown signal detected", { agent: agentName });
    return "SHUTDOWN_SIGNAL: You have been requested to stop. Write your captain's log and logout immediately.";
  }

  // Check shutdown state from session manager
  const shutdownManager = getSessionShutdownManager();
  if (shutdownManager.isShuttingDown(agentName)) {
    const state = shutdownManager.getShutdownState(agentName);
    if (state === "draining") {
      // In draining phase: only allow cleanup tools
      if (!shutdownManager.isAllowedToolDuringShutdown(toolName)) {
        log.info("blocked tool during shutdown draining", {
          agent: agentName,
          tool: toolName,
          state,
        });
        return shutdownManager.getShutdownMessage();
      }
    }
    // If state is 'shutdown_waiting': allow all tools (combat still in progress)
  }

  // Instability gate
  const instabilityBlock = checkToolBlocked(
    toolName,
    ctx.serverMetrics.getMetrics().status,
  );
  if (instabilityBlock) {
    log.info("blocked by instability", {
      agent: agentName,
      tool: toolName,
      status: ctx.serverMetrics.getMetrics().status,
    });
    return instabilityBlock;
  }

  // Transit throttle — rate-limit location checks during hyperspace
  if (ctx.transitThrottle && ctx.statusCache) {
    const transitBlock = ctx.transitThrottle.check(agentName, toolName, ctx.statusCache);
    if (transitBlock) {
      return transitBlock;
    }
  }

  // Block self_destruct while in transit — exponential fees have bankrupted agents
  if (toolName === "self_destruct" && ctx.statusCache) {
    const cached = ctx.statusCache.get(agentName);
    const player = cached
      ? ((cached.data.player ?? cached.data) as Record<string, unknown>)
      : null;
    const system = player?.current_system;
    if (!system || (typeof system === "string" && system.trim() === "")) {
      log.warn("blocked self_destruct in transit", { agent: agentName });
      return "self_destruct is BLOCKED while in transit (empty location). " +
        "Self-destruct fees double each time and can bankrupt you. " +
        "Instead: logout, wait 2 minutes, then login to reset your session.";
    }
  }

  const tracker = getTracker(ctx, agentName);

  // Per-agent tool denial — global "*" bucket
  const globalDenied = ctx.config.agentDeniedTools["*"];
  if (globalDenied && toolName in globalDenied) {
    const hint = globalDenied[toolName];
    log.info("blocked globally denied tool", { agent: agentName, tool: toolName });
    return `${toolName} is not available. Hint: ${hint}`;
  }
  // Per-agent tool denial — agent-specific bucket
  const agentDenied = ctx.config.agentDeniedTools[agentName];
  if (agentDenied && toolName in agentDenied) {
    const hint = agentDenied[toolName];
    log.info("blocked agent-specific denied tool", { agent: agentName, tool: toolName });
    return `${toolName} is not available for you. Hint: ${hint}`;
  }

  // Duplicate detection
  const sig = callSignatureV1(toolName, args);
  if (sig === tracker.lastCallSig) {
    log.info("blocked duplicate call", { agent: agentName, tool: toolName });
    return `Duplicate call blocked — you just called ${toolName} with the same arguments. Try a different action.`;
  }
  tracker.lastCallSig = sig;

  // Deposit guard: warn (but allow) non-crystal deposits so mission deliveries work
  if (toolName === "deposit_items" && args?.item_id) {
    const itemId = String(args.item_id).toLowerCase();
    if (itemId !== "crystal_ore") {
      log.debug("non-crystal deposit", { agent: agentName, itemId });
    }
  }

  // Per-session call limits (config-driven)
  const limit = ctx.callLimits[toolName];
  if (limit !== undefined) {
    const count = (tracker.counts[toolName] ?? 0) + 1;
    tracker.counts[toolName] = count;
    if (count > limit) {
      log.info("blocked by call limit", {
        agent: agentName,
        tool: toolName,
        count,
        limit,
      });
      return `Limit reached for ${toolName} (${limit}/session). Use a different tool.`;
    }
  }

  tracker.calledTools.add(toolName);
  persistCallTracker(agentName, tracker);
  return null;
}

/**
 * Check guardrails for a v2 tool:action call.
 * Returns an error message string if blocked, or null if the call is allowed.
 *
 * Extends v1 guardrails with:
 *  - Offline proxy blocking — rejects calls when proxy session is not active
 *  - Iteration limit checking — prevents runaway sessions
 *  - Turn timeout and idle monitors — disconnects stale sessions
 *  - `tool:action` composite key checks for denied tools and call limits
 *  - DENIED_ACTIONS_V2 (schema-level action blocklist)
 *  - V1-compat action name checks so configs like `"sell": "hint"` work for v2 agents
 */
export function checkGuardrailsV2(
  ctx: PipelineContext,
  agentName: string,
  toolName: string,
  action: string | undefined,
  args?: Record<string, unknown>,
  sessionId?: string,
): string | null {
  // Offline proxy blocking — reject tool calls when proxy session is not active.
  // Only enforces in runtime mode (when sessionStore is present).
  // In test mode (no sessionStore), skip this check for backward compatibility.
  if (ctx.sessionStore && !isProxySessionActive(ctx, sessionId)) {
    log.info("blocked tool call — proxy session offline", {
      agent: agentName,
      tool: toolName,
      action,
      session: sessionId?.slice(0, 8),
    });
    return "ERROR: Proxy session has expired or is offline. Please login again.";
  }

  // Check iteration limit (Phase 2)
  const iterationBlock = checkIterationLimit(ctx, sessionId);
  if (iterationBlock) {
    return iterationBlock;
  }

  // Check turn timeout and idle activity (Phase 3)
  const timeoutBlock = checkTurnTimeoutAndIdle(ctx, sessionId);
  if (timeoutBlock) {
    return timeoutBlock;
  }

  // Check for shutdown signal — return immediately if pending.
  // Do NOT consume — the runner process also needs to see it to abort the turn.
  if (hasSignal(agentName, "shutdown")) {
    log.info("shutdown signal detected (v2)", { agent: agentName });
    return "SHUTDOWN_SIGNAL: You have been requested to stop. Write your captain's log and logout immediately.";
  }

  // Check shutdown state from session manager
  const shutdownManager = getSessionShutdownManager();
  if (shutdownManager.isShuttingDown(agentName)) {
    const state = shutdownManager.getShutdownState(agentName);
    if (state === "draining") {
      // In draining phase: only allow cleanup tools
      if (!shutdownManager.isAllowedToolDuringShutdown(toolName)) {
        log.info("v2 blocked tool during shutdown draining", {
          agent: agentName,
          tool: toolName,
          state,
        });
        return shutdownManager.getShutdownMessage();
      }
    }
    // If state is 'shutdown_waiting': allow all tools (combat still in progress)
  }

  // Instability gate — use action name (actual game command) not wrapper tool name
  const effectiveTool = action ?? toolName;
  const instabilityBlock = checkToolBlocked(
    effectiveTool,
    ctx.serverMetrics.getMetrics().status,
  );
  if (instabilityBlock) {
    log.info("v2 blocked by instability", {
      agent: agentName,
      effectiveTool,
      status: ctx.serverMetrics.getMetrics().status,
    });
    return instabilityBlock;
  }

  // Transit throttle — rate-limit location checks during hyperspace
  // For v2, check the action name (e.g. "get_location") not the wrapper tool name
  if (ctx.transitThrottle && ctx.statusCache) {
    const transitCheckTool = action ?? toolName;
    const transitBlock = ctx.transitThrottle.check(agentName, transitCheckTool, ctx.statusCache);
    if (transitBlock) {
      return transitBlock;
    }
  }

  // Block self_destruct while in transit — exponential fees have bankrupted agents
  const effectiveAction = action ?? toolName;
  if (effectiveAction === "self_destruct" && ctx.statusCache) {
    const cached = ctx.statusCache.get(agentName);
    const player = cached
      ? ((cached.data.player ?? cached.data) as Record<string, unknown>)
      : null;
    const system = player?.current_system;
    if (!system || (typeof system === "string" && system.trim() === "")) {
      log.warn("blocked self_destruct in transit (v2)", { agent: agentName });
      return "self_destruct is BLOCKED while in transit (empty location). " +
        "Self-destruct fees double each time and can bankrupt you. " +
        "Instead: logout, wait 2 minutes, then login to reset your session.";
    }
  }

  const tracker = getTracker(ctx, agentName);
  const actionKey = action ? `${toolName}:${action}` : toolName;

  // Per-agent tool denial — check tool:action, v1 action name, and plain tool name
  const globalDenied = ctx.config.agentDeniedTools["*"];
  if (globalDenied) {
    if (actionKey in globalDenied) {
      log.info("v2 blocked globally denied key", {
        agent: agentName,
        actionKey,
      });
      return `${actionKey} is not available. Hint: ${globalDenied[actionKey]}`;
    }
    if (action && action in globalDenied) {
      log.info("v2 blocked globally denied action (v1 compat)", {
        agent: agentName,
        action,
      });
      return `${action} is not available. Hint: ${globalDenied[action]}`;
    }
    if (toolName in globalDenied) {
      log.info("v2 blocked globally denied tool", { agent: agentName, toolName });
      return `${toolName} is not available. Hint: ${globalDenied[toolName]}`;
    }
  }
  const agentDenied = ctx.config.agentDeniedTools[agentName];
  if (agentDenied) {
    if (actionKey in agentDenied) {
      log.info("v2 blocked agent-specific key", { agent: agentName, actionKey });
      return `${actionKey} is not available for you. Hint: ${agentDenied[actionKey]}`;
    }
    if (action && action in agentDenied) {
      log.info("v2 blocked agent-specific action (v1 compat)", {
        agent: agentName,
        action,
      });
      return `${action} is not available for you. Hint: ${agentDenied[action]}`;
    }
    if (toolName in agentDenied) {
      log.info("v2 blocked agent-specific tool", { agent: agentName, toolName });
      return `${toolName} is not available for you. Hint: ${agentDenied[toolName]}`;
    }
  }

  // DENIED_ACTIONS_V2 — schema-level blocklist (e.g. jettison, self_destruct)
  if (action) {
    const deniedActions = DENIED_ACTIONS_V2[toolName];
    if (deniedActions?.has(action)) {
      log.info("v2 blocked schema-level denied action", {
        agent: agentName,
        actionKey,
      });
      return `Action "${action}" is not available on ${toolName}.`;
    }
  }

  // Duplicate detection (action included in signature).
  // Pass action as override so it's included even when args doesn't contain it.
  const sig = callSignatureV2(toolName, args, action);
  if (sig === tracker.lastCallSig) {
    log.info("v2 blocked duplicate call", { agent: agentName, actionKey });
    return `Duplicate call blocked — you just called ${actionKey} with the same arguments. Try a different action.`;
  }
  tracker.lastCallSig = sig;

  // Deposit guard for v2
  if (toolName === "spacemolt_storage" && action === "deposit" && args?.item_id) {
    const itemId = String(args.item_id).toLowerCase();
    if (itemId !== "crystal_ore") {
      log.debug("v2 non-crystal deposit", { agent: agentName, itemId });
    }
  }

  // Per-session call limits — tool:action > action (v1 compat) > toolName
  const allLimits = ctx.callLimits;
  const limit =
    allLimits[actionKey] ??
    (action ? allLimits[action] : undefined) ??
    allLimits[toolName];
  if (limit !== undefined) {
    const countKey = actionKey;
    const count = (tracker.counts[countKey] ?? 0) + 1;
    tracker.counts[countKey] = count;
    if (count > limit) {
      log.info("v2 blocked by call limit", {
        agent: agentName,
        actionKey,
        count,
        limit,
      });
      return `Limit reached for ${actionKey} (${limit}/session). Use a different action.`;
    }
  }

  tracker.calledTools.add(actionKey);
  if (action) tracker.calledTools.add(action);
  persistCallTracker(agentName, tracker);
  return null;
}

// ---------------------------------------------------------------------------
// Response injection
// ---------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };
type ToolResponse = { content: TextContent[] };

/**
 * Wrap a tool response with injected data (critical events, fleet orders, battle status, etc.).
 *
 * Delegates to ctx.injectionRegistry.run() which executes all registered injections
 * in priority order. Each injection decides whether to fire and what data to add.
 *
 * If nothing is injected: reformats the response for the agent's preferred format (JSON/YAML).
 * Otherwise: parses the response JSON, merges all injections, and reformats.
 */
export async function withInjections(
  ctx: PipelineContext,
  agentName: string,
  response: ToolResponse,
  versionLabel = "",
): Promise<ToolResponse> {
  const injections = ctx.injectionRegistry.run(ctx, agentName);
  const agentFormat = getAgentFormat(ctx.config, agentName);

  // Nothing to inject — reformat if the agent wants YAML
  if (injections.size === 0) {
    const text = ctx.reformatResponse(
      response.content[0].text,
      agentFormat,
      "response",
    );
    if (text === response.content[0].text) return response;
    return { content: [{ type: "text" as const, text }] };
  }

  // Parse existing response — guard against non-JSON text
  let original: unknown;
  try {
    original = JSON.parse(response.content[0].text);
  } catch {
    log.warn("failed to parse response text, skipping injection", {
      agent: agentName,
      versionLabel,
    });
    return response;
  }
  const injected: Record<string, unknown> =
    typeof original === "object" && original !== null
      ? (original as Record<string, unknown>)
      : { result: original };

  for (const [key, value] of injections) {
    injected[key] = value;
  }

  return {
    content: [
      {
        type: "text" as const,
        text: ctx.reformatResponse(
          JSON.stringify(injected),
          agentFormat,
          "response+injections",
        ),
      },
    ],
  };
}
