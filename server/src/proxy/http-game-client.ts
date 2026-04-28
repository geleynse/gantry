// http-game-client.ts — MCP Streamable HTTP transport for game server
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

const log = createLogger("mcp-game-client");
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

/**
 * Check if a game error response indicates the player is not logged in.
 * The game server may return this as a structured code ("not_logged_in")
 * or as a generic game_error with "not logged in" in the message text.
 */
function isNotLoggedInError(error: { code: string; message: string }): boolean {
  if (SESSION_EXPIRED_CODES.has(error.code)) return true;
  if (error.message && error.message.toLowerCase().includes("not logged in")) return true;
  return false;
}

/** JSON-RPC response shape from MCP server. */
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

/** Minimum gap between state-changing actions to avoid game server action queue locks.
 *  Game ticks are ~10s — actions must resolve within a tick before the next fires. */
const ACTION_THROTTLE_MS = 8_000;

/** State-changing commands that need throttling (subset — just the high-frequency ones). */
const THROTTLED_COMMANDS = new Set([
  "mine", "travel", "jump", "dock", "undock", "refuel", "repair",
  "sell", "buy", "deposit_items", "withdraw_items",
  "craft", "attack", "loot_wreck", "salvage_wreck",
  "install_mod", "uninstall_mod", "jettison",
]);

export class HttpGameClient implements GameTransport {
  private readonly mcpUrl: string;
  private readonly apiBaseUrl: string; // For /api/v1/session
  label = "unknown";
  readonly breaker: CircuitBreaker;
  credentialsPath?: string;
  lastArrivalTick: number | null = null;

  private socksPort: number | undefined;
  private gameSessionId: string | null = null;
  private mcpSessionId: string | null = null;
  private sessionExpiresAt: number | null = null;
  private authenticated = false;
  private credentials: { username: string; password: string } | null = null;
  private serverMetrics: MetricsWindow | null;
  private loginTime = 0;
  private nextRequestId = 1;
  private lastActionTime = 0;
  private reconnectCount = 0;

  // Event wiring
  onEvent: ((event: GameEvent) => void) | null = null;
  onStateUpdate: ((data: Record<string, unknown>) => void) | null = null;
  onReconnect: (() => void) | null = null;

  constructor(mcpUrl: string, serverMetrics?: MetricsWindow, socksPort?: number) {
    this.mcpUrl = mcpUrl.replace(/\/$/, "");
    // Derive API base URL: https://game.spacemolt.com/mcp → https://game.spacemolt.com
    this.apiBaseUrl = this.mcpUrl.replace(/\/mcp$/, "");
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
   * Create a game session via /api/v1/session, then perform MCP handshake
   * (initialize + notifications/initialized) to get Mcp-Session-Id.
   */
  private async mcpInitialize(): Promise<void> {
    // Step 1: Create game session
    const sessionResp = await this.rawPost(`${this.apiBaseUrl}/api/v1/session`, {});
    const sessionData = JSON.parse(sessionResp.body);
    const session = sessionData.session as { id: string; expires_at?: string } | undefined;
    if (!session?.id) {
      throw new Error("Session creation failed: no session ID in response");
    }
    this.gameSessionId = session.id;
    if (session.expires_at) {
      this.sessionExpiresAt = new Date(session.expires_at).getTime();
    }

    // Step 2: MCP initialize
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

    // Capture Mcp-Session-Id from response headers
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

  /**
   * Call an MCP tool and return a GameResponse.
   * Handles JSON-RPC envelope, content block extraction, SSE parsing.
   */
  private async mcpToolCall(
    tool: string,
    args: Record<string, unknown> = {},
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<GameResponse> {
    // Instrument long-running MCP calls (e.g. jump that hung for the full 90s
    // timeout observed on cinder-wake). Without this log line, all we see is a
    // bare "Request timed out after 90000ms" with no attribution to which tool
    // triggered it or how long it actually ran before timing out.
    const tStart = Date.now();
    try {
      const resp = await this.rawPost(this.mcpUrl, {
        jsonrpc: "2.0",
        id: this.nextRequestId++,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }, timeoutMs);
      const durationMs = Date.now() - tStart;
      // Log slow MCP round-trips so stuck-server incidents leave a trail.
      // Threshold: half the timeout (45s by default) — anything slower than that
      // is almost certainly the game server hanging, not normal tick latency.
      if (durationMs > timeoutMs / 2) {
        log.warn("slow MCP tool call", { agent: this.label, tool, durationMs, timeoutMs });
      }
      return this.parseToolCallResponse(tool, resp);
    } catch (err) {
      const durationMs = Date.now() - tStart;
      if (err instanceof Error && err.message.includes("timed out")) {
        log.warn("MCP tool call timed out", { agent: this.label, tool, durationMs, timeoutMs });
        // Convert the thrown timeout into a structured GameResponse error so
        // callers (jump-route, passthrough, compound-tools) can handle it
        // gracefully instead of letting the exception escape.
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

  /**
   * Extracted from mcpToolCall so the timeout-handling wrapper stays compact.
   * Parses the raw JSON-RPC response into a GameResponse.
   */
  private parseToolCallResponse(
    _tool: string,
    resp: { body: string; headers: Headers; contentType: string },
  ): GameResponse {

    const rpc = this.parseRpcResponse(resp.body, resp.contentType);

    // JSON-RPC protocol error
    if (rpc.error) {
      return {
        error: {
          code: String(rpc.error.code),
          message: rpc.error.message,
        },
      };
    }

    // MCP tool result
    if (!rpc.result?.content?.length) {
      return { result: rpc.result ?? {} };
    }

    const text = rpc.result.content[0].text;

    // Tool-level error (game error like "not_docked")
    if (rpc.result.isError) {
      // Try to parse error text as JSON first (e.g. {"code":"...","message":"...","wait_seconds":0})
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
      // Try to parse error text as "Error: code: message"
      const match = text.match(/^Error:\s*(\w+):\s*(.+)/s);
      if (match) {
        return { error: { code: match[1], message: match[2] } };
      }
      return { error: { code: "game_error", message: text } };
    }

    // Parse inner JSON from content text
    try {
      const data = JSON.parse(text);
      return { result: data };
    } catch {
      // Not JSON — return as-is (text summary)
      return { result: text };
    }
  }

  /**
   * Parse an MCP response body that may be JSON or SSE format.
   */
  private parseRpcResponse(body: string, contentType: string): McpJsonRpcResponse {
    if (contentType.includes("text/event-stream")) {
      // SSE: extract last "data:" line
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

  /**
   * Low-level HTTP POST. Returns raw body text and content-type.
   * Includes both session headers.
   */
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

    // Login via MCP tool call
    const resp = await this.mcpToolCall("login", { username, password });
    if (resp.error) {
      this.logError(`login failed: ${resp.error.code}`);
      return resp;
    }

    this.authenticated = true;
    this.loginTime = Date.now();
    this.log("authenticated via MCP");
    return resp;
  }

  async logout(): Promise<GameResponse> {
    if (!this.authenticated) {
      return { error: { code: "not_authenticated", message: "No active session" } };
    }
    this.log("logging out");
    try {
      const resp = await this.mcpToolCall("logout");
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

  async execute(
    command: string,
    payload?: Record<string, unknown>,
    opts?: ExecuteOpts,
  ): Promise<GameResponse> {
    if (!this.authenticated || !this.mcpSessionId) {
      return { error: { code: "not_authenticated", message: "Not authenticated. Call login first." } };
    }

    // Throttle state-changing actions to prevent game server action queue locks.
    // The game queues actions per-character; firing too fast causes "another action
    // is already in progress" errors that persist across sessions.
    if (THROTTLED_COMMANDS.has(command)) {
      const elapsed = Date.now() - this.lastActionTime;
      if (elapsed < ACTION_THROTTLE_MS) {
        const wait = ACTION_THROTTLE_MS - elapsed;
        this.log(`throttling ${command} for ${wait}ms (action spacing)`);
        await new Promise((r) => setTimeout(r, wait));
      }
      this.lastActionTime = Date.now();
    }

    for (let attempt = 0; attempt <= ACTION_PENDING_MAX_RETRIES; attempt++) {
      const resp = await this.mcpToolCall(command, payload ?? {}, opts?.timeoutMs);

      // action_pending retry (also catch game_error with "action" in message — same root cause)
      const isActionPending = resp.error?.code === "action_pending";
      const isGameErrorActionLock = resp.error?.code === "game_error"
        && typeof resp.error.message === "string"
        && resp.error.message.toLowerCase().includes("action");
      if ((isActionPending || isGameErrorActionLock) && attempt < ACTION_PENDING_MAX_RETRIES) {
        const waitSec = resp.error!.wait_seconds != null ? resp.error!.wait_seconds : ACTION_PENDING_DEFAULT_WAIT_S;
        this.log(`${resp.error!.code} for ${command}, waiting ${waitSec}s before retry ${attempt + 1}/${ACTION_PENDING_MAX_RETRIES}${isGameErrorActionLock ? " (game_error action lock)" : ""}`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      // combat_interrupt — do NOT retry; combat takes priority over the interrupted action.
      // Reset throttle so combat commands (scan_and_attack, flee) fire immediately.
      if (resp.error?.code === "combat_interrupt") {
        this.log(`combat_interrupt for ${command} — returning immediately, agent must handle combat first`);
        this.lastActionTime = 0;
        return {
          error: {
            code: "combat_interrupt",
            message: "Combat interrupted your action. Handle combat first (scan_and_attack or flee), then retry your planned action.",
          },
        };
      }

      // rate_limited retry
      if ((resp.error?.code === "rate_limited" || resp.error?.code === "cooldown") && attempt < RATE_LIMITED_MAX_RETRIES) {
        const waitSec = resp.error.retry_after || resp.error.wait_seconds || RATE_LIMITED_WAIT_S;
        this.log(`${resp.error.code} for ${command}, waiting ${waitSec}s before retry ${attempt + 1}/${RATE_LIMITED_MAX_RETRIES}`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }

      // session/auth expiry auto-renewal (includes "not logged in" from game server)
      if (resp.error && isNotLoggedInError(resp.error) && this.credentials) {
        this.log(`session expired (${resp.error.code}: ${resp.error.message}) — auto-re-login for ${this.label}`);
        log.info(`[proxy] auto-re-login for ${this.label} after "${resp.error.message}"`);
        const renewed = await this.renewSession();
        if (renewed) {
          const retryResp = await this.mcpToolCall(command, payload ?? {}, opts?.timeoutMs);
          if (!opts?.skipMetrics && this.serverMetrics) {
            if (retryResp.error && SERVER_ERROR_CODES.has(retryResp.error.code)) {
              this.serverMetrics.recordError(retryResp.error.code);
            } else if (!retryResp.error) {
              this.serverMetrics.recordSuccess();
            }
          }
          return retryResp;
        }
        return resp; // renewal failed — return original error
      }

      // Record metrics
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
    // MCP mutations block until the game tick resolves.
    // Refresh status cache so downstream has fresh data.
    const data = await this.refreshStatus();
    if (data) this.onStateUpdate?.(data);
  }

  async waitForNextArrival(_beforeTick: number | null, _timeoutMs?: number): Promise<boolean> {
    // After a jump command, the MCP response already waited for arrival.
    // Check current status for POI data.
    const data = await this.refreshStatus();
    if (data) {
      const player = data.player as Record<string, unknown> | undefined;
      const poi = player?.current_poi ?? (data as Record<string, unknown>).current_poi;
      if (poi) {
        this.lastArrivalTick = Date.now(); // approximate
        this.onStateUpdate?.(data);
        return true;
      }
    }
    return false;
  }

  async waitForTickToReach(_targetTick: number, _timeoutMs?: number): Promise<boolean> {
    // MCP mutations already block. Just do a status refresh.
    await this.refreshStatus();
    return true;
  }

  async refreshStatus(): Promise<Record<string, unknown> | null> {
    if (!this.authenticated || !this.mcpSessionId) return null;
    try {
      const resp = await this.mcpToolCall("get_status");
      if (resp.error) return null;
      const result = resp.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
      return result as Record<string, unknown>;
    } catch {
      return null;
    }
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

  private async renewSession(): Promise<boolean> {
    if (!this.credentials) return false;
    try {
      await this.mcpInitialize();
      const resp = await this.mcpToolCall("login", {
        username: this.credentials.username,
        password: this.credentials.password,
      });
      if (resp.error) return false;
      this.authenticated = true;
      this.reconnectCount++;
      log.info("[proxy] session auto-reconnect succeeded", { agent: this.label, reconnectCount: this.reconnectCount });
      this.log("MCP session renewed successfully");
      return true;
    } catch {
      this.logError("MCP session renewal failed");
      return false;
    }
  }
}
