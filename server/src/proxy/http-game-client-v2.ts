// http-game-client-v2.ts — MCP Streamable HTTP transport for game server (v2 endpoint)
//
// Differences from v1 (`HttpGameClient`):
//  - MCP URL is `${mcpUrl}/v2?preset=${preset}` instead of `${mcpUrl}`
//  - Login goes through `spacemolt_auth(action="login", username, password, session_id)`
//    instead of the v1 `login(username, password)` tool, and we parse a fresh
//    `session_id` out of the greeting text — that's the canonical game session id
//    the server now expects on every subsequent tool call as an argument.
//  - `execute()` auto-injects `args.session_id` for every tool except
//    `spacemolt_catalog`, which the v2 schema does not require it on.
//  - Throttling keys are `${toolName}/${action}` against the v2 tool/action set.
//  - `refreshStatus()` parses the v2 `spacemolt(get_status)` text dashboard and
//    `spacemolt(get_location)` JSON, stitches a v1-compatible shape (and emits
//    BOTH `max_fuel`/`fuel_max` + `max_hull`/`hull_max` so routine code that
//    reads `fuel_max` stops being silently broken).
//
// The v1 client stays unchanged. Both clients implement `GameTransport` and
// can coexist behind the per-agent `mcpClientVersion` flag (Chunk B).
import { CircuitBreaker } from "./circuit-breaker.js";
import type { MetricsWindow } from "./instability-metrics.js";
import { createLogger } from "../lib/logger.js";
import packageJson from "../../package.json" with { type: "json" };
import type {
  GameTransport,
  GameResponse,
  ExecuteOpts,
  ConnectionHealthMetrics,
  GameEvent,
} from "./game-transport.js";
import {
  ACTION_PENDING_MAX_RETRIES,
  ACTION_PENDING_DEFAULT_WAIT_S,
  RATE_LIMITED_MAX_RETRIES,
  RATE_LIMITED_WAIT_S,
  COMMAND_TIMEOUT_MS,
} from "./game-transport.js";
import { dispatchV1ToV2 } from "./dispatch-v1-to-v2.js";

const log = createLogger("mcp-game-client-v2");
const CLIENT_VERSION = `Gantry/${packageJson.version}`;

/** Error codes that indicate server-level instability (for metrics tracking). */
const SERVER_ERROR_CODES = new Set([
  "connection_timeout", "connection_refused", "connection_lost", "connection_retry_failed",
  "timeout", "rate_limited",
  "server_error", "internal_error", "503", "502", "504", "429",
]);

/** Error codes that signal session/auth expiry — trigger re-login. */
const SESSION_EXPIRED_CODES = new Set([
  "session_expired", "unauthorized", "token_expired", "invalid_session",
  "session_invalid", "not_logged_in",
]);

function isNotLoggedInError(error: { code: string; message: string }): boolean {
  if (SESSION_EXPIRED_CODES.has(error.code)) return true;
  if (error.message && error.message.toLowerCase().includes("not logged in")) return true;
  return false;
}

interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

const ACTION_THROTTLE_MS = 8_000;

/**
 * Throttled v2 tool/action pairs. Key format: `${toolName}/${action}`.
 * Game server queues actions per character; firing too fast causes
 * "another action already in progress" errors.
 */
const THROTTLED_COMMANDS = new Set([
  "spacemolt/mine",
  "spacemolt/travel",
  "spacemolt/jump",
  "spacemolt/dock",
  "spacemolt/undock",
  "spacemolt/refuel",
  "spacemolt/repair",
  "spacemolt/sell",
  "spacemolt/buy",
  "spacemolt_storage/deposit",
  "spacemolt_storage/withdraw",
  "spacemolt/craft",
  "spacemolt_battle/engage",
  "spacemolt_salvage/loot",
  "spacemolt_salvage/salvage",
]);

export type McpPreset = "standard" | "full";

export class HttpGameClientV2 implements GameTransport {
  private readonly mcpUrl: string;       // Full v2 URL with preset query string
  private readonly apiBaseUrl: string;   // For /api/v1/session
  private readonly preset: McpPreset;
  label = "unknown";
  readonly breaker: CircuitBreaker;
  credentialsPath?: string;
  lastArrivalTick: number | null = null;

  private socksPort: number | undefined;
  /** Game session id — what the v2 server now wants threaded into every tool call's args. */
  private gameSessionId: string | null = null;
  /** MCP transport session id from the `Mcp-Session-Id` header. */
  private mcpSessionId: string | null = null;
  private sessionExpiresAt: number | null = null;
  private authenticated = false;
  private credentials: { username: string; password: string } | null = null;
  private serverMetrics: MetricsWindow | null;
  private loginTime = 0;
  private nextRequestId = 1;
  private lastActionTime = 0;
  private reconnectCount = 0;
  /** Have we logged the raw get_status text yet? Plan §debug-logging — first call only. */
  private rawStatusLogged = false;

  // Event wiring
  onEvent: ((event: GameEvent) => void) | null = null;
  onStateUpdate: ((data: Record<string, unknown>) => void) | null = null;
  onReconnect: (() => void) | null = null;

  /**
   * @param mcpUrl     Base game-server MCP URL (e.g. `https://game.spacemolt.com/mcp`).
   *                   The `/v2?preset=…` suffix is appended internally.
   * @param apiBaseUrl REST base URL for `/api/v1/session`. If omitted, derived
   *                   from `mcpUrl` (strips trailing `/mcp`).
   * @param agentName  Logical agent name, used for the `label` field and log lines.
   * @param preset     `"standard"` (9 tools) or `"full"` (16 tools, includes
   *                   spacemolt_battle / spacemolt_facility / etc).
   * @param serverMetrics Optional metrics-window for instability tracking.
   * @param socksPort  Optional SOCKS proxy hint (carried through; not enforced here).
   */
  constructor(
    mcpUrl: string,
    apiBaseUrl: string | undefined,
    agentName: string,
    preset: McpPreset,
    serverMetrics?: MetricsWindow,
    socksPort?: number,
  ) {
    const baseMcp = mcpUrl.replace(/\/$/, "");
    this.mcpUrl = `${baseMcp}/v2?preset=${preset}`;
    this.apiBaseUrl = (apiBaseUrl ?? baseMcp.replace(/\/mcp$/, "")).replace(/\/$/, "");
    this.preset = preset;
    this.label = agentName;
    this.socksPort = socksPort;
    this.breaker = new CircuitBreaker();
    this.serverMetrics = serverMetrics ?? null;
  }

  private log(msg: string): void {
    log.info(`[${this.label}] ${msg}`);
  }

  private logError(msg: string): void {
    log.error(`[${this.label}] ${msg}`);
  }

  get hasSocksProxy(): boolean {
    return this.socksPort !== undefined;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  /** This is the v2 client — used by passthrough/compound-tool dispatch to
   * pick v2 tool names + actions instead of v1 flat names. */
  isV2(): boolean {
    return true;
  }

  getCredentials(): { username: string; password: string } | null {
    return this.credentials;
  }

  restoreCredentials(creds: { username: string; password: string }): void {
    this.credentials = creds;
  }

  // ---------------------------------------------------------------------------
  // MCP Protocol — low-level
  // ---------------------------------------------------------------------------

  /**
   * Create a game session via /api/v1/session, then perform MCP handshake on the
   * v2 endpoint (initialize + notifications/initialized) to capture
   * Mcp-Session-Id.
   */
  private async mcpInitialize(): Promise<void> {
    // Step 1: Create game session (REST endpoint stays v1; both v1 and v2 REST
    // session endpoints return the same shape, no breaking change forces a switch).
    const sessionUrl = `${this.apiBaseUrl}/api/v1/session`;
    const sessionResp = await this.rawPost(sessionUrl, {});
    let sessionData: { session?: { id?: string; expires_at?: string } };
    try {
      sessionData = JSON.parse(sessionResp.body);
    } catch (err) {
      log.error("Session creation: response not JSON", {
        agent: this.label,
        url: sessionUrl,
        body: sessionResp.body.slice(0, 200),
      });
      throw new Error(`Session creation failed: response not JSON: ${sessionResp.body.slice(0, 100)}`);
    }
    const session = sessionData.session;
    if (!session?.id) {
      log.error("Session creation: missing session.id", {
        agent: this.label,
        url: sessionUrl,
        body: sessionResp.body.slice(0, 300),
      });
      throw new Error(`Session creation failed: no session ID in response (body: ${sessionResp.body.slice(0, 100)})`);
    }
    this.gameSessionId = session.id;
    if (session.expires_at) {
      this.sessionExpiresAt = new Date(session.expires_at).getTime();
    }

    // Step 2: MCP initialize on the v2 endpoint
    const initResp = await this.rawPost(this.mcpUrl, {
      jsonrpc: "2.0",
      id: this.nextRequestId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "gantry", version: packageJson.version },
      },
    });

    const mcpSid = initResp.headers.get("mcp-session-id");
    if (!mcpSid) {
      throw new Error("MCP initialize failed: no Mcp-Session-Id header in response");
    }
    this.mcpSessionId = mcpSid;

    // Step 3: Send initialized notification
    await this.rawPost(this.mcpUrl, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
  }

  private async mcpToolCall(
    tool: string,
    args: Record<string, unknown> = {},
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<GameResponse> {
    const tStart = Date.now();
    try {
      const resp = await this.rawPost(this.mcpUrl, {
        jsonrpc: "2.0",
        id: this.nextRequestId++,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }, timeoutMs);
      const durationMs = Date.now() - tStart;
      if (durationMs > timeoutMs / 2) {
        log.warn("slow MCP tool call", { agent: this.label, tool, durationMs, timeoutMs });
      }
      return this.parseToolCallResponse(tool, resp);
    } catch (err) {
      const durationMs = Date.now() - tStart;
      if (err instanceof Error && err.message.includes("timed out")) {
        log.warn("MCP tool call timed out", { agent: this.label, tool, durationMs, timeoutMs });
        return {
          error: {
            code: "timeout",
            message: `Game server did not respond to ${tool} within ${timeoutMs}ms — tool call aborted.`,
          },
        };
      }
      throw err;
    }
  }

  private parseToolCallResponse(
    _tool: string,
    resp: { body: string; headers: Headers; contentType: string },
  ): GameResponse {
    const rpc = this.parseRpcResponse(resp.body, resp.contentType);

    if (rpc.error) {
      return {
        error: {
          code: String(rpc.error.code),
          message: rpc.error.message,
        },
      };
    }

    if (!rpc.result?.content?.length) {
      return { result: rpc.result ?? {} };
    }

    const text = rpc.result.content[0].text;

    if (rpc.result.isError) {
      // Try structured JSON error first (e.g. {"code":"...","message":"...","wait_seconds":0})
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed.code === "string") {
          return {
            error: {
              code: parsed.code,
              message: typeof parsed.message === "string" ? parsed.message : text,
              ...(typeof parsed.wait_seconds === "number" ? { wait_seconds: parsed.wait_seconds } : {}),
              ...(typeof parsed.retry_after === "number" ? { retry_after: parsed.retry_after } : {}),
            },
          };
        }
      } catch {
        // not JSON, fall through
      }
      const match = text.match(/^Error:\s*(\w+):\s*(.+)/s);
      if (match) {
        return { error: { code: match[1], message: match[2] } };
      }
      return { error: { code: "game_error", message: text } };
    }

    try {
      const data = JSON.parse(text);
      return { result: data };
    } catch {
      return { result: text };
    }
  }

  private parseRpcResponse(body: string, contentType: string): McpJsonRpcResponse {
    if (contentType.includes("text/event-stream")) {
      const lines = body.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith("data: ")) {
          return JSON.parse(lines[i].slice(6));
        }
      }
      throw new Error("SSE response contained no data: lines");
    }
    return JSON.parse(body);
  }

  private async rawPost(
    url: string,
    body: unknown,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<{ body: string; headers: Headers; contentType: string }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "User-Agent": CLIENT_VERSION,
    };
    if (this.gameSessionId) {
      headers["X-Session-Id"] = this.gameSessionId;
    }
    if (this.mcpSessionId) {
      headers["Mcp-Session-Id"] = this.mcpSessionId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      return {
        body: text,
        headers: response.headers,
        contentType: response.headers.get("content-type") ?? "application/json",
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle (GameTransport interface)
  // ---------------------------------------------------------------------------

  async login(username: string, password: string): Promise<GameResponse> {
    this.credentials = { username, password };

    try {
      await this.mcpInitialize();
    } catch (err) {
      this.logError(`MCP init failed: ${err}`);
      return { error: { code: "connection_failed", message: `MCP init failed: ${err}` } };
    }

    // v2: login via spacemolt_auth(action=login). The mcpSessionId is sent as
    // an arg here too — the audit established the server accepts the Mcp-Session-Id
    // header value as a session_id arg until login replaces it.
    const resp = await this.mcpToolCall("spacemolt_auth", {
      action: "login",
      username,
      password,
      session_id: this.mcpSessionId,
    });
    if (resp.error) {
      this.logError(`login failed: ${resp.error.code}`);
      return resp;
    }

    log.debug("login response", { agent: this.label, raw: typeof resp.result === "string" ? resp.result : JSON.stringify(resp.result) });
    const parsed = this.parseSessionIdFromGreeting(resp.result);
    if (parsed) {
      if (parsed !== this.mcpSessionId) {
        log.warn("login session_id != mcpSessionId — using parsed", {
          agent: this.label,
          parsed,
          mcpSessionId: this.mcpSessionId,
        });
      }
      this.gameSessionId = parsed;
    } else {
      log.warn("login greeting missing 'Session ID:' line — falling back to mcpSessionId", {
        agent: this.label,
      });
      this.gameSessionId = this.mcpSessionId;
    }

    this.authenticated = true;
    this.loginTime = Date.now();
    this.log(`authenticated via MCP v2 (preset=${this.preset})`);
    return resp;
  }

  async logout(): Promise<GameResponse> {
    if (!this.authenticated) {
      return { error: { code: "not_authenticated", message: "No active session" } };
    }
    this.log("logging out");
    try {
      const resp = await this.mcpToolCall("spacemolt_auth", {
        action: "logout",
        session_id: this.gameSessionId,
      });
      this.authenticated = false;
      this.gameSessionId = null;
      this.mcpSessionId = null;
      this.sessionExpiresAt = null;
      return resp;
    } catch (err) {
      this.authenticated = false;
      this.gameSessionId = null;
      this.mcpSessionId = null;
      return { error: { code: "logout_error", message: `Logout failed: ${err}` } };
    }
  }

  /**
   * Execute a v2 MCP tool call. The first arg is the v2 tool name (e.g.
   * `"spacemolt"`, `"spacemolt_battle"`, `"spacemolt_storage"`); the action
   * lives inside `payload.action` per the v2 schema.
   *
   * `session_id` is auto-injected for every tool except `spacemolt_catalog`,
   * which the v2 schema does not require it on.
   *
   * Throttling key is `${toolName}/${action}`.
   */
  async execute(
    toolName: string,
    payload?: Record<string, unknown>,
    opts?: ExecuteOpts,
  ): Promise<GameResponse> {
    if (!this.authenticated || !this.gameSessionId) {
      return { error: { code: "not_authenticated", message: "Not authenticated. Call login first." } };
    }

    // Translate v1-style flat tool names (e.g. "analyze_market", "survey_system",
    // "view_insurance") into v2 consolidated namespaces. Routines, compound
    // tools, and the prayer executor still use v1 names — without dispatch
    // here they would hit the v2 game server with -32602 Unknown tool.
    const dispatched = dispatchV1ToV2(toolName, payload);
    if (dispatched) {
      toolName = dispatched.tool;
      payload = dispatched.args;
    }

    // Auto-inject session_id for every tool except spacemolt_catalog.
    const args: Record<string, unknown> = { ...(payload ?? {}) };
    if (toolName !== "spacemolt_catalog" && args.session_id === undefined) {
      args.session_id = this.gameSessionId;
    }

    const action = typeof args.action === "string" ? args.action : "";
    const throttleKey = `${toolName}/${action}`;
    if (action && THROTTLED_COMMANDS.has(throttleKey)) {
      const elapsed = Date.now() - this.lastActionTime;
      if (elapsed < ACTION_THROTTLE_MS) {
        const wait = ACTION_THROTTLE_MS - elapsed;
        this.log(`throttling ${throttleKey} for ${wait}ms (action spacing)`);
        await new Promise((r) => setTimeout(r, wait));
      }
      this.lastActionTime = Date.now();
    }

    for (let attempt = 0; attempt <= ACTION_PENDING_MAX_RETRIES; attempt++) {
      const resp = await this.mcpToolCall(toolName, args, opts?.timeoutMs);

      const isActionPending = resp.error?.code === "action_pending";
      const isGameErrorActionLock = resp.error?.code === "game_error"
        && typeof resp.error.message === "string"
        && resp.error.message.toLowerCase().includes("action");
      if ((isActionPending || isGameErrorActionLock) && attempt < ACTION_PENDING_MAX_RETRIES) {
        const waitSec = resp.error!.wait_seconds != null ? resp.error!.wait_seconds : ACTION_PENDING_DEFAULT_WAIT_S;
        this.log(`${resp.error!.code} for ${throttleKey || toolName}, waiting ${waitSec}s before retry ${attempt + 1}/${ACTION_PENDING_MAX_RETRIES}${isGameErrorActionLock ? " (game_error action lock)" : ""}`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (resp.error?.code === "combat_interrupt") {
        this.log(`combat_interrupt for ${throttleKey || toolName} — returning immediately, agent must handle combat first`);
        this.lastActionTime = 0;
        return {
          error: {
            code: "combat_interrupt",
            message: "Combat interrupted your action. Handle combat first (scan_and_attack or flee), then retry your planned action.",
          },
        };
      }

      if ((resp.error?.code === "rate_limited" || resp.error?.code === "cooldown") && attempt < RATE_LIMITED_MAX_RETRIES) {
        const waitSec = resp.error.retry_after || resp.error.wait_seconds || RATE_LIMITED_WAIT_S;
        this.log(`${resp.error.code} for ${throttleKey || toolName}, waiting ${waitSec}s before retry ${attempt + 1}/${RATE_LIMITED_MAX_RETRIES}`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      if (resp.error && isNotLoggedInError(resp.error) && this.credentials) {
        this.log(`session expired (${resp.error.code}: ${resp.error.message}) — auto-re-login for ${this.label}`);
        log.info(`[proxy] auto-re-login for ${this.label} after "${resp.error.message}"`);
        const renewed = await this.renewSession();
        if (renewed) {
          // Re-inject session_id with the new gameSessionId.
          if (toolName !== "spacemolt_catalog") {
            args.session_id = this.gameSessionId;
          }
          const retryResp = await this.mcpToolCall(toolName, args, opts?.timeoutMs);
          if (!opts?.skipMetrics && this.serverMetrics) {
            if (retryResp.error && SERVER_ERROR_CODES.has(retryResp.error.code)) {
              this.serverMetrics.recordError(retryResp.error.code);
            } else if (!retryResp.error) {
              this.serverMetrics.recordSuccess();
            }
          }
          return retryResp;
        }
        return resp;
      }

      if (!opts?.skipMetrics && this.serverMetrics) {
        if (resp.error && SERVER_ERROR_CODES.has(resp.error.code)) {
          this.serverMetrics.recordError(resp.error.code);
        } else if (!resp.error) {
          this.serverMetrics.recordSuccess();
        }
      }

      if (resp.error?.code === "action_pending") {
        return { error: { code: "cooldown", message: "Action still pending after retries. Try a different action." } };
      }

      return resp;
    }

    return { error: { code: "cooldown", message: "Action still pending after retries. Try a different action." } };
  }

  async close(): Promise<void> {
    this.authenticated = false;
    this.gameSessionId = null;
    this.mcpSessionId = null;
    this.sessionExpiresAt = null;
  }

  // ---------------------------------------------------------------------------
  // Tick/arrival waiting — no-ops for MCP (mutations block until tick)
  // ---------------------------------------------------------------------------

  async waitForTick(_timeoutMs?: number): Promise<void> {
    const data = await this.refreshStatus();
    if (data) this.onStateUpdate?.(data);
  }

  async waitForNextArrival(_beforeTick: number | null, _timeoutMs?: number): Promise<boolean> {
    const data = await this.refreshStatus();
    if (data) {
      const player = data.player as Record<string, unknown> | undefined;
      const poi = player?.current_poi ?? (data as Record<string, unknown>).current_poi;
      if (poi) {
        this.lastArrivalTick = Date.now();
        this.onStateUpdate?.(data);
        return true;
      }
    }
    return false;
  }

  async waitForTickToReach(_targetTick: number, _timeoutMs?: number): Promise<boolean> {
    await this.refreshStatus();
    return true;
  }

  /**
   * Fan out `spacemolt(get_status)` + `spacemolt(get_location)` and stitch a
   * v1-compatible status object. Emits both `max_fuel`/`fuel_max` and
   * `max_hull`/`hull_max` on `ship` so routine code that reads either name works.
   *
   * Returns null (and warns) if any of the critical fields are missing.
   */
  async refreshStatus(): Promise<Record<string, unknown> | null> {
    if (!this.authenticated || !this.gameSessionId) return null;

    let statusResp: GameResponse;
    let locationResp: GameResponse;
    try {
      [statusResp, locationResp] = await Promise.all([
        this.execute("spacemolt", { action: "get_status" }, { skipMetrics: true }),
        this.execute("spacemolt", { action: "get_location" }, { skipMetrics: true }),
      ]);
    } catch (err) {
      log.warn("refreshStatus fan-out threw", { agent: this.label, err: String(err) });
      return null;
    }

    if (statusResp.error || locationResp.error) {
      log.debug("refreshStatus got error from get_status/get_location", {
        agent: this.label,
        statusError: statusResp.error?.code,
        locationError: locationResp.error?.code,
      });
      return null;
    }

    const statusText = typeof statusResp.result === "string"
      ? statusResp.result
      : JSON.stringify(statusResp.result);

    if (!this.rawStatusLogged) {
      log.debug("first get_status raw text", { agent: this.label, text: statusText });
      this.rawStatusLogged = true;
    }

    const parsed = parseGetStatusText(statusText);

    // get_location may be JSON-shaped or a JSON string of the same.
    let locationData: Record<string, unknown> | null = null;
    if (typeof locationResp.result === "object" && locationResp.result !== null && !Array.isArray(locationResp.result)) {
      locationData = locationResp.result as Record<string, unknown>;
    } else if (typeof locationResp.result === "string") {
      try {
        const maybe = JSON.parse(locationResp.result);
        if (typeof maybe === "object" && maybe !== null && !Array.isArray(maybe)) {
          locationData = maybe as Record<string, unknown>;
        }
      } catch {
        // not JSON — leave null; the warn below will flag missing fields
      }
    }

    // location may be wrapped as { location: {...} } or be the bare shape.
    const locInner: Record<string, unknown> = (() => {
      if (!locationData) return {};
      const wrapper = locationData.location;
      if (wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)) {
        return wrapper as Record<string, unknown>;
      }
      return locationData;
    })();

    // Build skills map from parsed text dashboard.
    // Keys are skill names (lowercased), values match the SkillData shape expected
    // by game-state.ts normalizeSkills() and the dashboard.
    const skillsFromText: Record<string, { name: string; level: number; xp: number; xp_to_next: number }> = {};
    for (const s of parsed.skills) {
      const key = s.name.toLowerCase().replace(/\s+/g, '_');
      skillsFromText[key] = { name: s.name, level: s.level, xp: s.xp, xp_to_next: s.xpToNext };
    }

    const player: Record<string, unknown> = {
      username: parsed.username,
      empire: parsed.empire,
      credits: parsed.credits,
      current_system: locInner.system_id,
      current_poi: locInner.poi_id,
      docked_at_base: locInner.docked_at,
      // Include skills from the status text so they update on every status refresh.
      // This supplements (and can replace) the separate get_skills fetch at login.
      ...(parsed.skills.length > 0 ? { skills: skillsFromText } : {}),
    };

    const ship: Record<string, unknown> = {
      hull: parsed.hull,
      max_hull: parsed.maxHull,
      hull_max: parsed.maxHull,            // emit both names — see plan §A
      shield: parsed.shield,
      max_shield: parsed.maxShield,
      shield_max: parsed.maxShield,
      armor: parsed.armor,
      speed: parsed.speed,
      fuel: parsed.fuel,
      max_fuel: parsed.maxFuel,
      fuel_max: parsed.maxFuel,            // emit both names — see plan §A
      cargo_used: parsed.cargoUsed,
      cargo_capacity: parsed.cargoCapacity,
      cpu_used: parsed.cpuUsed,
      cpu_capacity: parsed.cpuCapacity,
      power_used: parsed.powerUsed,
      power_capacity: parsed.powerCapacity,
      modules: parsed.modules,
      // Cargo items parsed from the status text dashboard.
      // These are the named items the game shows in the Cargo section.
      cargo: parsed.cargo.map((c) => ({ name: c.name, quantity: c.quantity })),
    };

    const stitched: Record<string, unknown> = {
      player,
      ship,
      // No in_combat sentinel in v2 status text; consumers handle undefined defensively.
      is_cloaked: false,
    };

    // Critical-field validation. Plan §A: warn + return null if any missing.
    const missing: string[] = [];
    if (player.current_system === undefined) missing.push("player.current_system");
    if (player.current_poi === undefined) missing.push("player.current_poi");
    if (ship.fuel === undefined) missing.push("ship.fuel");
    if (ship.hull === undefined) missing.push("ship.hull");
    if (ship.cargo_used === undefined) missing.push("ship.cargo_used");
    if (ship.cargo_capacity === undefined) missing.push("ship.cargo_capacity");
    if (missing.length > 0) {
      log.warn("refreshStatus: missing fields after normalization", { agent: this.label, missing });
      return null;
    }

    // Debug log of normalized object, with credentials omitted.
    log.debug("refreshStatus normalized", {
      agent: this.label,
      player: { ...player, credits: "<redacted>" },
      ship: {
        hull: ship.hull, max_hull: ship.max_hull,
        fuel: ship.fuel, max_fuel: ship.max_fuel,
        cargo_used: ship.cargo_used, cargo_capacity: ship.cargo_capacity,
        modules_count: Array.isArray(ship.modules) ? ship.modules.length : 0,
      },
    });

    return stitched;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  getConnectionHealth(): ConnectionHealthMetrics {
    const connectionDurationMs = this.loginTime > 0 && this.authenticated
      ? Date.now() - this.loginTime
      : null;
    return {
      rapidDisconnects: 0,
      reconnectsPerMinute: 0,
      totalReconnects: this.reconnectCount,
      lastConnectedAt: this.loginTime,
      connectionDurationMs,
      sessionExpiresAt: this.sessionExpiresAt ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Session renewal
  // ---------------------------------------------------------------------------

  private parseSessionIdFromGreeting(result: unknown): string | null {
    const text = typeof result === "string" ? result : JSON.stringify(result);
    const m = text.match(/Session ID:\s*([0-9a-f]+)/);
    return m ? m[1] : null;
  }

  private async renewSession(): Promise<boolean> {
    if (!this.credentials) return false;
    try {
      await this.mcpInitialize();
      const resp = await this.mcpToolCall("spacemolt_auth", {
        action: "login",
        username: this.credentials.username,
        password: this.credentials.password,
        session_id: this.mcpSessionId,
      });
      if (resp.error) return false;

      this.gameSessionId = this.parseSessionIdFromGreeting(resp.result) ?? this.mcpSessionId;

      this.authenticated = true;
      this.reconnectCount++;
      log.info("[proxy] session auto-reconnect succeeded (v2)", {
        agent: this.label,
        reconnectCount: this.reconnectCount,
      });
      this.log("MCP v2 session renewed successfully");
      return true;
    } catch {
      this.logError("MCP v2 session renewal failed");
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// get_status text parser (exported for unit testing)
// ---------------------------------------------------------------------------

export interface ParsedGetStatus {
  username?: string;
  empire?: string;
  credits?: number;
  systemDisplayName?: string;
  hull?: number;
  maxHull?: number;
  shield?: number;
  maxShield?: number;
  armor?: number;
  speed?: number;
  fuel?: number;
  maxFuel?: number;
  cargoUsed?: number;
  cargoCapacity?: number;
  cpuUsed?: number;
  cpuCapacity?: number;
  powerUsed?: number;
  powerCapacity?: number;
  modules: Array<{ id?: string; class_id?: string; slot?: string; size?: string; wear?: string }>;
  cargo: Array<{ name: string; quantity: number }>;
  skills: Array<{ name: string; level: number; xp: number; xpToNext: number }>;
}

/**
 * Parse the `spacemolt(get_status)` text dashboard into a structured shape.
 * Each regex is independent — a format change in one line doesn't break the
 * others. See plan §A for the regex contracts.
 */
export function parseGetStatusText(text: string): ParsedGetStatus {
  const out: ParsedGetStatus = { modules: [], cargo: [], skills: [] };

  // Header: "Username [Empire] | 1,234,567cr | System Display Name"
  // Empire token is \w+ (e.g. "Drifter") but the username can have arbitrary
  // characters; non-greedy match for the username up to " [".
  for (const line of text.split("\n")) {
    const headerMatch = line.match(/^(\S.*?) \[(\w+)\] \| ([\d,]+)cr \| (.+)$/);
    if (headerMatch) {
      out.username = headerMatch[1].trim();
      out.empire = headerMatch[2];
      out.credits = parseInt(headerMatch[3].replace(/,/g, ""), 10);
      out.systemDisplayName = headerMatch[4].trim();
      break;
    }
  }

  const num = (re: RegExp): number | undefined => {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : undefined;
  };
  const numPair = (re: RegExp): [number | undefined, number | undefined] => {
    const m = text.match(re);
    if (!m) return [undefined, undefined];
    return [parseInt(m[1], 10), parseInt(m[2], 10)];
  };

  [out.hull, out.maxHull] = numPair(/Hull:\s*(\d+)\/(\d+)/);
  [out.shield, out.maxShield] = numPair(/Shield:\s*(\d+)\/(\d+)/);
  out.armor = num(/Armor:\s*(\d+)/);
  out.speed = num(/Speed:\s*(\d+)/);
  [out.fuel, out.maxFuel] = numPair(/Fuel:\s*(\d+)\/(\d+)/);
  [out.cargoUsed, out.cargoCapacity] = numPair(/Cargo:\s*(\d+)\/(\d+)/);
  [out.cpuUsed, out.cpuCapacity] = numPair(/CPU:\s*(\d+)\/(\d+)/);
  [out.powerUsed, out.powerCapacity] = numPair(/Power:\s*(\d+)\/(\d+)/);

  // Section parser helper: extracts tab-delimited rows from named sections.
  // Stops at the next section header (Word (N): or Word:) or end of text.
  // Skips the header row (first row where cols[0] matches an expected header name).
  const parseSection = (sectionRe: RegExp): string[][] => {
    const m = text.match(sectionRe);
    if (!m) return [];
    const rows: string[][] = [];
    for (const row of m[1].split("\n")) {
      if (!row.includes("\t")) continue;
      const cols = row.split("\t").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cols.length < 2) continue;
      rows.push(cols);
    }
    return rows;
  };

  // Modules: tab-split rows under a "Modules (N):" header. The section ends
  // at the next "Word (...)" section header (Cargo, Skills, Active missions,
  // etc) — relying on `\n\n` was wrong because get_status uses single newlines
  // between sections, which let skill rows leak into out.modules.
  const SECTION_END = /(?:\n\n|\n[A-Za-z][\w ]*(?:\(|:)|$)/;
  const moduleSectionRe = new RegExp(`Modules\\s*(?:\\(\\d+\\))?:\\n([\\s\\S]*?)${SECTION_END.source}`);
  for (const cols of parseSection(moduleSectionRe)) {
    // Skip the header row if it's literally column names.
    if (cols[0].toLowerCase() === "id" || cols[0].toLowerCase() === "module") continue;
    if (cols.length < 4) continue;
    out.modules.push({
      id: cols[0],
      class_id: cols[1],
      slot: cols[2],
      size: cols[3],
      wear: cols[4],
    });
  }

  // Cargo: tab-split rows under "Cargo (N items):" or "Cargo:".
  // Format: "item\tqty\tsize" header, then "Gold Ore\t14\t1" rows.
  const cargoSectionRe = new RegExp(`Cargo\\s*(?:\\([^)]*\\))?:\\n([\\s\\S]*?)${SECTION_END.source}`);
  for (const cols of parseSection(cargoSectionRe)) {
    // Skip header row
    if (cols[0].toLowerCase() === "item" || cols[0].toLowerCase() === "name") continue;
    const name = cols[0];
    const quantity = parseInt(cols[1], 10);
    if (name && !isNaN(quantity) && quantity > 0) {
      out.cargo.push({ name, quantity });
    }
  }

  // Skills: tab-split rows under "Skills (N):" header.
  // Format: "skill\tlevel\txp\tnext_level" header, then "mining\t13\t478\t6885" rows.
  const skillsSectionRe = new RegExp(`Skills\\s*(?:\\([^)]*\\))?:\\n([\\s\\S]*?)${SECTION_END.source}`);
  for (const cols of parseSection(skillsSectionRe)) {
    // Skip header row
    if (cols[0].toLowerCase() === "skill" || cols[0].toLowerCase() === "name") continue;
    const name = cols[0];
    const level = parseInt(cols[1], 10);
    const xp = parseInt(cols[2], 10);
    const xpToNext = parseInt(cols[3], 10);
    if (name && !isNaN(level)) {
      out.skills.push({ name, level, xp: isNaN(xp) ? 0 : xp, xpToNext: isNaN(xpToNext) ? 0 : xpToNext });
    }
  }

  return out;
}
