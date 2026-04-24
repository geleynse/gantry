/**
 * Shared login/logout business logic for the MCP proxy.
 *
 * Both v1 (createGantryServer) and v2 (createGantryServerV2) register identical login/logout
 * tools. This module extracts the shared logic so it can be called from both without
 * duplication.
 */

import { createLogger } from "../lib/logger.js";
import { EventBuffer } from "./event-buffer.js";
import type { GameEvent } from "./game-transport.js";
import type { GantryConfig } from "../config.js";
import type { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import type { AgentCallTracker, BattleState } from "./server.js";
import { getCredentialsFilePath, decryptCredentials, isAuthFailureCode, type RawCredentialsFile } from "../services/credentials-crypto.js";
import { readFileSync, statSync } from "node:fs";
import { FLEET_DIR } from "../config.js";
import { recordCredentialAuthFailure, recordCredentialSuccess } from "../services/credential-health.js";

// Cached decrypted credentials — loaded once on first login, avoids per-request file I/O + decryption
let _credentialsCache: RawCredentialsFile | null = null;
let _credentialsCacheLoaded = false;
let _credentialsCachePath: string | null = null;
let _credentialsCacheMtimeMs: number | null = null;

function getCachedCredentials(agentName: string): { username: string; password: string } | null {
  let shouldLoad = !_credentialsCacheLoaded;
  let credsPath = "";
  try {
    credsPath = getCredentialsFilePath(FLEET_DIR);
    const mtimeMs = statSync(credsPath).mtimeMs;
    shouldLoad = shouldLoad || credsPath !== _credentialsCachePath || mtimeMs !== _credentialsCacheMtimeMs;
    if (shouldLoad) {
      _credentialsCachePath = credsPath;
      _credentialsCacheMtimeMs = mtimeMs;
    }
  } catch {
    shouldLoad = !_credentialsCacheLoaded;
  }

  if (shouldLoad) {
    _credentialsCacheLoaded = true;
    try {
      const raw = JSON.parse(readFileSync(credsPath, "utf-8")) as RawCredentialsFile;
      _credentialsCache = decryptCredentials(raw);
      log.info("fleet-credentials loaded", { agents: Object.keys(_credentialsCache).length });
    } catch (err) {
      log.warn("Failed to load fleet-credentials", { error: (err as Error).message });
    }
  }
  return _credentialsCache?.[agentName] ?? null;
}
import type { GameResponse } from "./game-client.js";
import { getSessionShutdownManager } from "./session-shutdown.js";
import { persistGameState } from "./cache-persistence.js";
import { runDiscovery } from "./discovery-service.js";

const log = createLogger("auth");

// Re-export types used in the interface so callers don't need to import from server.ts
export type { AgentCallTracker, BattleState };

export interface LoginDeps {
  sessions: SessionManager;
  sessionStore: SessionStore;
  sessionAgentMap: Map<string, string>;
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  battleCache: Map<string, BattleState | null>;
  eventBuffers: Map<string, EventBuffer>;
  callTrackers: Map<string, AgentCallTracker>;
  config: GantryConfig;
  // Callbacks
  throttledPersistGameState: (agentName: string, state: { data: Record<string, unknown>; fetchedAt: number }) => void;
  persistBattleState: (agentName: string, bs: BattleState | null) => void;
  resetTracker: (agentName: string) => void;
  logToolCall: (agentName: string, tool: string, args: unknown, result: unknown, durationMs: number) => void;
  logWsEvent: (agentName: string, type: string, payload: unknown) => void;
  getUnconsumedHandoff: (agentName: string) => HandoffRecord | null | undefined;
  consumeHandoff: (id: number) => void;
  createHandoff: (data: HandoffData) => void;
  marketReservations?: import("./market-reservations.js").MarketReservationCache;
  overseerEventLog?: import("../services/overseer-event-log.js").OverseerEventLog | null;
  /**
   * Close any MCP transports bound to this agent *other than* the provided
   * current sessionId. Called after a successful login / session reuse to
   * prevent stale transports from accumulating (watchdog restart loops were
   * leaving 2-3 transports per agent for hours).
   * Optional for backward compat — tests can omit it.
   */
  closeStaleTransportsForAgent?: (agentName: string, currentSessionId: string | undefined) => void;
}

export interface HandoffRecord {
  id: number;
  location_system?: string;
  location_poi?: string;
  credits?: number;
  fuel?: number;
}

export interface HandoffData {
  agent: string;
  location_system?: string;
  location_poi?: string;
  credits?: number;
  fuel?: number;
  cargo_summary?: string;
  last_actions?: string;
}

export type McpTextResult = { content: Array<{ type: "text"; text: string }> };

function textResult(obj: unknown): McpTextResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

/**
 * Handle the login tool for both v1 and v2 MCP servers.
 *
 * Wires event callbacks, calls client.login(), sets session mapping,
 * primes status cache, and injects session handoff + home system.
 */
export async function handleLogin(
  deps: LoginDeps,
  sessionId: string | undefined,
  username: string,
  password: string,
  label = "v1",
): Promise<McpTextResult> {
  const {
    sessions, sessionStore, sessionAgentMap, statusCache, battleCache, eventBuffers,
    config, throttledPersistGameState, persistBattleState, resetTracker,
    logToolCall, logWsEvent, getUnconsumedHandoff, consumeHandoff,
  } = deps;

  const agentName = sessions.resolveAgentName(username);
  log.info("login requested", { agent: agentName, label, session: sessionId?.slice(0, 8) });

  // If an account pool is configured, override the provided credentials with pool credentials.
  // This allows agents to call login() without knowing their credentials — the pool supplies them.
  const poolCreds = sessions.getCredentialsFromPool(agentName);
  if (poolCreds) {
    username = poolCreds.username;
    password = poolCreds.password;
    log.info("using account pool credentials", { agent: agentName, username });
  } else if (!password) {
    // No pool — fall back to cached fleet-credentials
    const fileCreds = getCachedCredentials(agentName);
    if (fileCreds) {
      username = fileCreds.username;
      password = fileCreds.password;
      log.info("using fleet-credentials", { agent: agentName, username });
    }
  }

  const client = sessions.getOrCreateClient(agentName);

  // If the game client is already authenticated (e.g. new MCP session from same agent
  // between turns), skip the full login flow — just wire up the session mapping and
  // return cached state. This avoids unnecessary re-auth round-trips.
  if (client.isAuthenticated()) {
    log.info("reusing existing game session", { agent: agentName, label, session: sessionId?.slice(0, 8) });
    if (sessionId) {
      sessionAgentMap.set(sessionId, agentName);
      sessionStore.setSessionAgent(sessionId, agentName);
    }
    deps.closeStaleTransportsForAgent?.(agentName, sessionId);
    resetTracker(agentName);
    // Build response from cached status — refresh if cache is empty
    let cached = statusCache.get(agentName);
    if (!cached?.data) {
      const freshStatus = await client.refreshStatus();
      if (freshStatus) {
        const now = Date.now();
        statusCache.set(agentName, { data: freshStatus, fetchedAt: now });
        cached = { data: freshStatus, fetchedAt: now };
      }
    }
    const handoffData = getUnconsumedHandoff(agentName);
    const playerData = cached?.data
      ? (cached.data.player as Record<string, unknown>) ?? cached.data
      : {};
    const result: Record<string, unknown> = {
      status: "ok",
      username: (playerData as any)?.username ?? username,
      credits: (playerData as any)?.credits,
      location: (playerData as any)?.current_system ?? (playerData as any)?.location,
      session_handoff: handoffData ?? {
        location: (playerData as any)?.current_system ?? (playerData as any)?.location,
        credits: (playerData as any)?.credits,
        fuel: ((playerData as any)?.ship as any)?.fuel,
      },
      _reused_session: true,
    };
    if (handoffData && typeof (handoffData as any).id === "number") consumeHandoff((handoffData as any).id);
    logToolCall(agentName, "login", { username }, result, 0);
    return textResult(result);
  }

  // Wire event callbacks before login so we capture events from the start
  const eventBuffer = eventBuffers.get(agentName) ?? new EventBuffer();
  eventBuffers.set(agentName, eventBuffer);

  let pendingDeathEnrichment = false;

  client.onEvent = (event: GameEvent) => {
    eventBuffer.push(event);
    deps.overseerEventLog?.push(agentName, event);
    logWsEvent(agentName, event.type, event.payload);

    // Track battle state from combat_update events
    if (event.type === "combat_update" && event.payload && typeof event.payload === "object") {
      const p = event.payload as Record<string, unknown>;
      const bs: BattleState = {
        battle_id: String(p.battle_id ?? ""),
        zone: String(p.zone ?? "unknown"),
        stance: String(p.stance ?? "unknown"),
        hull: typeof p.hull === "number" ? p.hull : -1,
        shields: typeof p.shields === "number" ? p.shields : -1,
        target: p.target ?? null,
        status: String(p.status ?? "active"),
        updatedAt: Date.now(),
      };
      battleCache.set(agentName, bs);
      persistBattleState(agentName, bs);
    }

    // Log incoming trade offers
    if (event.type === "trade_offer_received" && event.payload && typeof event.payload === "object") {
      const p = event.payload as Record<string, unknown>;
      log.info("trade_offer_received", {
        agent: agentName,
        from: String(p.sender ?? p.from ?? "unknown"),
        trade_id: String(p.trade_id ?? p.id ?? "?"),
        items: JSON.stringify(p.items ?? p.offered_items ?? "?"),
      });
    }

    // Research logging: capture full pirate event payloads to understand NPC combat mechanics.
    // These logs answer open questions in spacemolt.combat-mechanics.md.
    if (event.type === "pirate_warning" || event.type === "pirate_combat") {
      const p = event.payload as Record<string, unknown> | null | undefined;
      log.debug(`[COMBAT-RESEARCH] ${event.type}`, {
        agent: agentName,
        full_payload: JSON.stringify(p ?? {}),
        // Key unknowns we're tracking:
        pirate_id: p?.pirate_id ?? p?.npc_id ?? p?.attacker_id ?? null,
        pirate_tier: p?.tier ?? p?.pirate_tier ?? p?.type ?? null,
        damage_dealt: p?.damage ?? p?.damage_dealt ?? null,
        hull_remaining: p?.hull ?? p?.hull_remaining ?? p?.your_hull ?? null,
        shields_remaining: p?.shields ?? p?.shields_remaining ?? p?.your_shields ?? null,
        location: p?.location ?? p?.system ?? p?.poi ?? null,
      });
    }

    // Research logging: capture combat_update payloads during NPC auto-combat
    if (event.type === "combat_update") {
      const p = event.payload as Record<string, unknown> | null | undefined;
      log.debug("[COMBAT-RESEARCH] combat_update", {
        agent: agentName,
        full_payload: JSON.stringify(p ?? {}),
        // Tracking: does combat_update fire for NPC auto-combat or only PvP?
        battle_id: p?.battle_id ?? null,
        attacker: p?.attacker ?? p?.attacker_name ?? null,
        target: p?.target ?? p?.target_name ?? null,
        damage: p?.damage ?? null,
        hull: p?.hull ?? null,
        is_npc: p?.is_npc ?? p?.npc ?? null,
      });
    }

    // Flag for death enrichment on next status refresh
    if (event.type === "player_died") {
      battleCache.set(agentName, null);
      persistBattleState(agentName, null);
      pendingDeathEnrichment = true;
    }
  };

  client.onStateUpdate = (rawData: Record<string, unknown>) => {
    // Deep-clone to avoid "Attempted to assign to readonly property" when mutating
    // Build a fully mutable clone — Bun's response.json() and JSON.parse can
    // return objects with readonly properties in certain code paths
    let data: Record<string, unknown>;
    try {
      const text = JSON.stringify(rawData);
      const parsed = JSON.parse(text);
      // Spread into a fresh object to ensure top-level mutability,
      // then deep-clone nested objects that we need to mutate
      data = { ...parsed };
      if (data.player && typeof data.player === "object") {
        data.player = { ...(data.player as Record<string, unknown>) };
      }
      if (data.ship && typeof data.ship === "object") {
        data.ship = { ...(data.ship as Record<string, unknown>) };
      }
    } catch (cloneErr) {
      log.error("onStateUpdate clone failed", { agent: agentName, error: String(cloneErr) });
      return;
    }
    // Preserve skills from previous cache entry — get_status doesn't return skills,
    // but get_skills merges them in on login. Without this, the next status update
    // overwrites the merged data and skills disappear from the UI.
    try {
      const prev = statusCache.get(agentName);
      if (prev?.data) {
        const prevPlayer = prev.data.player as Record<string, unknown> | undefined;
        const prevSkills = prevPlayer?.skills ?? (prev.data as Record<string, unknown>).skills;
        if (prevSkills) {
          // Clone prevSkills to avoid propagating frozen references from previous cache
          const clonedSkills = JSON.parse(JSON.stringify(prevSkills));
          const newPlayer = data.player as Record<string, unknown> | undefined;
          if (newPlayer && !newPlayer.skills) {
            newPlayer.skills = clonedSkills;
          } else if (!newPlayer && !(data as Record<string, unknown>).skills) {
            (data as Record<string, unknown>).skills = clonedSkills;
          }
        }
      }
    } catch (skillErr) {
      log.error("onStateUpdate skill preservation failed", { agent: agentName, error: String(skillErr) });
    }
    const stateEntry = { data, fetchedAt: Date.now() };
    try {
      statusCache.set(agentName, stateEntry);
    } catch (cacheErr) {
      log.error("onStateUpdate statusCache.set failed", { agent: agentName, error: String(cacheErr) });
    }
    throttledPersistGameState(agentName, stateEntry);

    // Validate expected data shape — catch nesting issues early
    const player = data.player as Record<string, unknown> | undefined;
    if (!player && data.credits !== undefined) {
      log.warn("statusCache data has flat shape (no player wrapper) — consumers expect nested { player, ship }", { agent: agentName });
    } else if (player && !player.current_system && !player.credits) {
      log.warn("statusCache player object missing expected fields (current_system, credits)", { agent: agentName, keys: Object.keys(player).slice(0, 8) });
    }

    // After death, the next status refresh shows respawn state. Inject a critical event.
    if (pendingDeathEnrichment) {
      pendingDeathEnrichment = false;
      const player = (data.player ?? data) as Record<string, unknown>;
      const ship = (data.ship ?? (player.ship as Record<string, unknown>) ?? {}) as Record<string, unknown>;
      eventBuffer.push({
        type: "respawn_state",
        payload: {
          message: `You died and respawned. New location: ${player.current_system ?? "unknown"}`
            + (player.current_poi ? ` (${player.current_poi})` : "")
            + `. Hull: ${ship.hull ?? "?"}/${ship.max_hull ?? "?"}. RECOVERY: Dock > claim_insurance > repair > buy_insurance > resume.`,
          system: player.current_system,
          poi: player.current_poi,
          hull: ship.hull,
          max_hull: ship.max_hull,
          credits: player.credits,
        },
        receivedAt: Date.now(),
      });
    }
  };

  client.onReconnect = () => {
    eventBuffer.pushReconnectMarker();
  };

  // Retry login with backoff if the WebSocket connection isn't ready.
  // This prevents agents from thinking login succeeded when the connection
  // failed, which would cause every subsequent tool call to record
  // connection_retry_failed errors and inflate the instability rate.
  const LOGIN_MAX_RETRIES = 4;
  const LOGIN_RETRY_BASE_MS = 2_000;
  // Initialized to connection_retry_failed; overwritten on success or auth error.
  // The loop always either breaks (overwriting resp) or returns early.
  let resp: GameResponse = { error: { code: "connection_retry_failed", message: "Login did not complete" } };
  for (let attempt = 0; attempt <= LOGIN_MAX_RETRIES; attempt++) {
    try {
      resp = await client.login(username, password);
      // Retry on connection_lost — WS connected briefly then dropped before game responded.
      // Without this, the resolved-but-errored response breaks out of the retry loop.
      const errCode = (resp.error as Record<string, unknown> | undefined)?.code;
      if (errCode === "connection_lost" || errCode === "connection_failed") {
        if (attempt < LOGIN_MAX_RETRIES) {
          const delay = LOGIN_RETRY_BASE_MS * Math.pow(2, attempt);
          log.warn("login connection lost, retrying", {
            agent: agentName, attempt: attempt + 1, maxRetries: LOGIN_MAX_RETRIES, delay,
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        log.error("login failed after all retries (connection unstable)", { agent: agentName, attempts: LOGIN_MAX_RETRIES + 1 });
        return textResult({
          error: { code: "connection_retry_failed", message: "Game server connection keeps dropping. Try again later." },
        });
      }
      break; // Got a real response (success or auth error like wrong password)
    } catch (err) {
      if (attempt < LOGIN_MAX_RETRIES) {
        const delay = LOGIN_RETRY_BASE_MS * Math.pow(2, attempt);
        log.warn("login connection failed, retrying", {
          agent: agentName, attempt: attempt + 1, maxRetries: LOGIN_MAX_RETRIES,
          delay, error: err instanceof Error ? err.message : String(err),
        });
        await new Promise((r) => setTimeout(r, delay));
      }
      // All retries exhausted — return a clean error instead of throwing
      log.error("login failed after all retries", { agent: agentName, attempts: LOGIN_MAX_RETRIES + 1 });
      return textResult({
        error: { code: "connection_retry_failed", message: "Could not connect to game server after retries. Try again later." },
      });
    }
  }

  if (sessionId) {
    sessionAgentMap.set(sessionId, agentName);
    sessionStore.setSessionAgent(sessionId, agentName);
  }
  deps.closeStaleTransportsForAgent?.(agentName, sessionId);

  if (!resp.error) {
    recordCredentialSuccess(agentName, username);
    sessions.persistSessions();
    sessions.recordPoolLogin(agentName);
    resetTracker(agentName);
    if (sessionId) {
      sessionStore.resetIterationCount(sessionId);
    }
    // Prime status cache so cached queries work from the first tool call.
    // The game server may need a moment to initialize the player state,
    // so we retry up to 3 times with a small delay if we get incomplete data.
    let initialStatus: Record<string, unknown> | null = null;
    const MAX_INIT_RETRIES = 3;
    const INIT_RETRY_DELAY_MS = 200;
    for (let attempt = 0; attempt < MAX_INIT_RETRIES; attempt++) {
      initialStatus = await client.refreshStatus();
      // Check if we got valid player data (current_system should be set)
      const player = (initialStatus?.player ?? initialStatus) as Record<string, unknown>;
      if (initialStatus && player.current_system) {
        break; // Got valid data, done
      }
      if (attempt < MAX_INIT_RETRIES - 1) {
        // Wait before retrying
        await new Promise((r) => setTimeout(r, INIT_RETRY_DELAY_MS));
      }
    }
    if (initialStatus) client.onStateUpdate?.(initialStatus);

    // Trigger proactive discovery (catalog fetch) — fire and forget
    runDiscovery(client).catch(err => {
      log.warn("discovery pass failed", { agent: agentName, error: err instanceof Error ? err.message : String(err) });
    });

    // Fetch skills into statusCache so the UI has them.
    // Awaited (not fire-and-forget) so skills are in the cache BEFORE any
    // waitForTick → onStateUpdate fires. Without this, the preservation logic
    // in onStateUpdate has nothing to preserve and skills vanish from the UI.
    try {
      const skillsResp = await client.execute('get_skills', {}, { skipMetrics: true });
      if (skillsResp.result && typeof skillsResp.result === 'object') {
        const skills = (skillsResp.result as Record<string, unknown>).skills as Record<string, unknown> | undefined;
        if (skills && typeof skills === 'object') {
          const cached = deps.statusCache.get(agentName);
          if (cached?.data) {
            const updatedData = {
              ...cached.data,
              player: {
                ...(cached.data.player as Record<string, unknown> ?? {}),
                skills,
              },
            };
            const entry = { data: updatedData, fetchedAt: cached.fetchedAt };
            deps.statusCache.set(agentName, entry);
            deps.throttledPersistGameState(agentName, entry);
          }
        }
      }
    } catch { /* non-fatal */ }
  }

  // Check for session handoff from previous session
  let handoffMessage = "";
  if (!resp.error) {
    try {
      const h = getUnconsumedHandoff(agentName);
      if (h) {
        handoffMessage = `\nSession handoff: You were at ${h.location_system ?? "unknown"}`
          + (h.location_poi ? ` (${h.location_poi})` : "")
          + ` with ${h.credits ?? "?"} credits, ${h.fuel ?? "?"} fuel.`
          + " Continue from where you left off.";
        consumeHandoff(h.id);
      }
    } catch { /* non-fatal */ }
  }

  const loginResult = resp.result ?? resp.error ?? { status: "ok" };
  const resultObj: Record<string, unknown> = typeof loginResult === "object" && loginResult !== null
    ? { ...(loginResult as Record<string, unknown>) }
    : { result: loginResult };
  if (handoffMessage) resultObj.session_handoff = handoffMessage.trim();
  // Inject home system from config
  const agentConfig = config.agents.find(a => a.name === agentName);
  if (agentConfig?.homeSystem) resultObj.home_system = agentConfig.homeSystem;

  logToolCall(agentName, "login", { username }, resp.error ? { error: resp.error } : { status: "ok" }, 0);
  if (resp.error) {
    const code = (resp.error as Record<string, unknown>).code;
    if (typeof code === "string" && isAuthFailureCode(code)) {
      recordCredentialAuthFailure(agentName, username);
    }
    log.error("login failed", { agent: agentName, error: resp.error });
  } else {
    log.info("login success", { agent: agentName });
  }
  return textResult(resultObj);
}

/**
 * Handle the logout tool for both v1 and v2 MCP servers.
 *
 * Stores a session handoff, disconnects the game client, and cleans up
 * session state.
 */
export async function handleLogout(
  deps: LoginDeps,
  sessionId: string | undefined,
  label = "v1",
): Promise<McpTextResult> {
  const {
    sessions, sessionStore, sessionAgentMap, statusCache, eventBuffers, callTrackers,
    logToolCall, createHandoff,
  } = deps;

  const agentName = sessionId ? sessionAgentMap.get(sessionId) : undefined;
  if (!agentName) return textResult({ error: "not logged in" });

  log.info("logout requested", { agent: agentName, label });

  // Store session handoff before disconnecting
  const cached = statusCache.get(agentName);
  if (cached) {
    const d = cached.data;
    const player = (d.player ?? d) as Record<string, unknown>;
    const ship = (d.ship ?? player.ship ?? {}) as Record<string, unknown>;
    const tracker = callTrackers.get(agentName);
    const lastActions = tracker
      ? Object.entries(tracker.counts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([tool]) => tool)
      : [];
    try {
      createHandoff({
        agent: agentName,
        location_system: player.current_system as string | undefined,
        location_poi: player.current_poi as string | undefined,
        credits: player.credits as number | undefined,
        fuel: ship.fuel as number | undefined,
        cargo_summary: JSON.stringify(ship.cargo ?? []),
        last_actions: JSON.stringify(lastActions),
      });
    } catch { /* non-fatal */ }
  }

  const client = sessions.getClient(agentName);
  if (client) {
    await client.logout();
    sessions.removeClient(agentName);
  }
  if (sessionId) {
    sessionAgentMap.delete(sessionId);
  }
  // Expire all sessions for this agent in the persistent store (offline blocking)
  sessionStore.expireAgentSessions(agentName);
  // Persist last known state before logout completes
  // This ensures the final state is saved even if the 30s throttle hasn't fired yet
  if (cached) {
    persistGameState(agentName, cached);
  }
  // Release all market reservations for this agent
  deps.marketReservations?.releaseAll(agentName);
  // Keep statusCache — last known state is useful for monitoring between sessions
  eventBuffers.delete(agentName);
  logToolCall(agentName, "logout", {}, { status: "logged out" }, 0);
  log.info("logout success", { agent: agentName });

  // Complete shutdown if agent was in any shutdown state
  const shutdownManager = getSessionShutdownManager();
  const shutdownState = shutdownManager.getShutdownState(agentName);
  if (shutdownState === "draining" || shutdownState === "shutdown_waiting") {
    shutdownManager.completeShutdown(agentName);
    log.info("agent shutdown completed via logout", { agent: agentName, previousState: shutdownState });
  }

  return textResult({ status: "logged out" });
}
