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
import { checkChangelogForBreaking } from "../services/changelog-watch.js";
import { parseGetStatusText, type ParsedGetStatus } from "./game-text-parser.js";
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
  // JSON-RPC level -32001 is what the game server returns for "Session expired
  // (server may have restarted)" — it arrives as rpc.error.code (numeric -32001
  // stringified to "-32001") rather than a tool-level isError result. Without
  // this entry execute() never attempts renewal on turn-1 stale sessions.
  "-32001",
]);

function isNotLoggedInError(error: { code: string; message: string }): boolean {
  if (SESSION_EXPIRED_CODES.has(error.code)) return true;
  if (error.message && error.message.toLowerCase().includes("not logged in")) return true;
  // The game server sometimes returns human-readable -32001 messages — catch
  // "session expired" wording even when the numeric code doesn't match the set.
  if (error.message && error.message.toLowerCase().includes("session expired")) return true;
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

/**
 * Class-level coordinator for /api/v1/session creation across all instances
 * in this process.
 *
 * Why: after a gantry server restart, all running agents discover their MCP
 * sessions are stale and trigger mcpInitialize() near-simultaneously. The
 * game server rate-limits /api/v1/session per IP, and all gantry agents
 * share the same outbound IP — the burst causes a cascade of "rate_limited
 * — try again in N seconds" errors and exhausts login retries.
 *
 * Mitigation: enforce a minimum spacing (plus small randomization) between
 * session creations. Cheap, doesn't change happy-path behavior, eliminates
 * lockstep bursts.
 *
 * Exported and writable for testing only.
 */
export const SessionCreateSpacing = {
  lastCreateAtMs: 0,
  /**
   * Process-wide IP-block gate. When the game returns a rate_limited /
   * "temporarily blocked" response on /api/v1/session, this is set to the wall
   * time the block is expected to clear. NO instance POSTs /api/v1/session until
   * now >= blockedUntilMs.
   *
   * Why this exists: the game's per-IP block is a SECONDARY "excessive rate
   * limit violations" penalty that is RE-EXTENDED by every request made during
   * the window. With all agents sharing one outbound IP, even spaced retries
   * form a steady drip that keeps the block alive indefinitely (a self-
   * sustaining wedge). Gating every instance to zero POSTs during the window is
   * what lets the block actually expire and the fleet recover.
   */
  blockedUntilMs: 0,
  /** Hard minimum spacing between sessions to stay under game-server burst limit. */
  minSpacingMs: 600,
  /** Extra randomized fuzz added to spacing (0..jitterMs). */
  jitterMs: 600,
  /** Disable (set to 0) during tests so they don't sleep. */
  enabled: true,
};

/** Default block (seconds) when the game omits retry_after on a rate_limited
 * session response. Conservative — better to over-wait than re-trip the block. */
const SESSION_BLOCK_DEFAULT_SEC = 5;

/**
 * Record a rate_limited / temporarily-blocked /api/v1/session response so EVERY
 * instance in this process (and this instance's own retries) backs off until the
 * block clears. Monotonic: never shortens an already-recorded window — a later,
 * shorter retry_after must not let us start POSTing again early. `retry_after`
 * is in seconds; we add a 1s safety margin.
 */
export function noteSessionRateLimited(retryAfterSec?: number, nowMs: number = Date.now()): void {
  const sec = retryAfterSec != null && retryAfterSec >= 0 ? retryAfterSec : SESSION_BLOCK_DEFAULT_SEC;
  const until = nowMs + (sec + 1) * 1000;
  if (until > SessionCreateSpacing.blockedUntilMs) {
    SessionCreateSpacing.blockedUntilMs = until;
  }
}

/**
 * Pure: how many ms a caller must wait before POSTing /api/v1/session, taking
 * the larger of (a) the process-wide IP-block window and (b) the inter-create
 * spacing window. The caller supplies the random fuzz (0..jitterMs) so this
 * stays deterministic and unit-testable.
 */
export function sessionCreateWaitMs(nowMs: number, randomFuzzMs: number): number {
  const blockWait = SessionCreateSpacing.blockedUntilMs - nowMs;
  const spacingEarliest =
    SessionCreateSpacing.lastCreateAtMs + SessionCreateSpacing.minSpacingMs + randomFuzzMs;
  const spacingWait = spacingEarliest - nowMs;
  return Math.max(0, blockWait, spacingWait);
}

/** Keys of the game's standard response envelope (see OpenAPI `APIResponse`). */
const ENVELOPE_KEYS = new Set(["result", "notifications", "session", "error"]);

/**
 * Pure, idempotent defensive unwrap of the game's standard response envelope.
 *
 * The game's documented `APIResponse` is `{ result, notifications?, session?, error? }`
 * with the command payload under `result`. Historically the MCP transport handed
 * gantry the BARE payload as tool-call text, so parseToolCallResponse just JSON-parsed
 * it and returned it as `result`. If the game (or MCP layer) instead wraps the payload
 * in the full envelope — the "delta-wrapped mutation response envelope" that peer
 * clients (SpaceMolt/www play client, SpaceMolt/admiral) began unwrapping 2026-07-01 —
 * the bare-payload assumption double-nests it (`resp.result.result.total_cost`), and
 * every downstream field read silently misses.
 *
 * This unwraps ONLY when `data` is unmistakably that envelope: a plain object that owns
 * a `result` key and whose keys are all envelope keys (notifications/session/error) —
 * a shape no command payload has (they all carry command-specific fields). So it is a
 * no-op on today's bare payloads and self-heals if the envelope shows up. Notifications
 * are intentionally dropped here: gantry receives events via the EventBuffer's separate
 * MCP notification channel, not this synchronous return path.
 */
export function unwrapGameEnvelope(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const obj = data as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, "result")) return data;
  for (const k of Object.keys(obj)) {
    if (!ENVELOPE_KEYS.has(k)) return data; // has a non-envelope key → a real payload, leave it
  }
  return obj.result;
}

/**
 * Wait until the global session-create slot is available, then claim it.
 *
 * Called once at the top of every mcpInitialize attempt (including rate-limit
 * retries). Honors both the IP-block gate and inter-create spacing, plus a small
 * random jitter so N concurrent callers don't unblock at the same instant.
 *
 * The slot is claimed eagerly (lastCreateAtMs is set before the network call)
 * so concurrent callers serialize correctly. If the actual call ends up failing
 * or being retried, the spacing still applies.
 */
async function awaitSessionCreateSlot(): Promise<void> {
  if (!SessionCreateSpacing.enabled) return;
  const fuzz = Math.random() * SessionCreateSpacing.jitterMs;
  const waitMs = sessionCreateWaitMs(Date.now(), fuzz);
  if (waitMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, waitMs));
  }
  SessionCreateSpacing.lastCreateAtMs = Date.now();
}

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
  /**
   * Timestamps (ms) of recent SUCCESSFUL session renewals, used by a sliding-window
   * circuit breaker. We trip only when MAX_RECONNECTS renewals land within
   * RENEWAL_WINDOW_MS — i.e. genuine thrash (renew → still expired → renew …) — not
   * when legitimate session churn accumulates renewals over a long healthy run.
   * Counting LIFETIME renewals (the old behavior) wedged agents into
   * session_renewal_exhausted after ~30-45 min, freezing statusCache (stale nav/cargo).
   */
  private renewalTimestamps: number[] = [];
  /** Have we logged the raw get_status text yet? Plan §debug-logging — first call only. */
  private rawStatusLogged = false;

  /**
   * Single-flight lock: non-null while a renewSession() is in progress. Concurrent
   * callers (e.g. the refreshStatus() get_status + get_location fan-out both hitting
   * session_expired) await this same promise instead of each kicking off a fresh
   * mcpInitialize(), which would clobber each other's game session. Cleared in a
   * finally so a failed renewal never permanently wedges the lock.
   */
  private reauthPromise: Promise<boolean> | null = null;
  /** Timer handle for proactive pre-expiry session refresh (cleared on logout/close). */
  private sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Refresh this many ms before the game session's reported expiry. */
  private static readonly REFRESH_LEAD_MS = 90_000;
  /** Max renewals within RENEWAL_WINDOW_MS before tripping the breaker. */
  private static readonly MAX_RECONNECTS = 5;
  /**
   * Sliding window for the renewal circuit breaker. Healthy renewals are spaced
   * minutes apart (session TTL), so they never accumulate to MAX_RECONNECTS within
   * this window; pathological renew-loops fire back-to-back and trip it.
   */
  private static readonly RENEWAL_WINDOW_MS = 180_000;

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
    // Stagger concurrent session creations across instances so we don't burst
    // through the game-server per-IP rate limit after a gantry restart.
    const sessionUrl = `${this.apiBaseUrl}/api/v1/session`;
    let sessionData: { session?: { id?: string; expires_at?: string }; error?: { code?: string; message?: string; retry_after?: number } };
    let attempt = 0;
    const MAX_RATE_LIMIT_RETRIES = 2;
    while (true) {
      await awaitSessionCreateSlot();
      const sessionResp = await this.rawPost(sessionUrl, {});
      try {
        sessionData = JSON.parse(sessionResp.body);
      } catch {
        log.error("Session creation: response not JSON", {
          agent: this.label,
          url: sessionUrl,
          body: sessionResp.body.slice(0, 200),
        });
        throw new Error(`Session creation failed: response not JSON: ${sessionResp.body.slice(0, 100)}`);
      }

      // Honor an explicit rate_limited response. Record the block PROCESS-WIDE so
      // that every instance (and our own retry below) parks until it clears —
      // POSTing during the window re-extends the game's per-IP block, so spaced
      // retries would otherwise keep it alive forever. awaitSessionCreateSlot()
      // at the top of the loop does the actual waiting against blockedUntilMs.
      const err = sessionData.error;
      if (err?.code === "rate_limited") {
        noteSessionRateLimited(err.retry_after);
        if (attempt < MAX_RATE_LIMIT_RETRIES) {
          log.warn("Session creation: rate-limited, backing off (process-wide gate)", {
            agent: this.label,
            retry_after: err.retry_after,
            attempt: attempt + 1,
            maxAttempts: MAX_RATE_LIMIT_RETRIES,
            blockedForMs: Math.max(0, SessionCreateSpacing.blockedUntilMs - Date.now()),
          });
          attempt++;
          continue;
        }
      }
      break;
    }
    const session = sessionData.session;
    if (!session?.id) {
      log.error("Session creation: missing session.id", {
        agent: this.label,
        url: sessionUrl,
        body: JSON.stringify(sessionData).slice(0, 300),
      });
      throw new Error(`Session creation failed: no session ID in response (body: ${JSON.stringify(sessionData).slice(0, 100)})`);
    }
    this.gameSessionId = session.id;
    if (session.expires_at) {
      this.sessionExpiresAt = new Date(session.expires_at).getTime();
    } else {
      this.sessionExpiresAt = null;
    }
    // Schedule proactive refresh ~90s before the game session expires so a busy
    // agent never trips over a mid-turn expiry. Re-arms on every (re)auth.
    this.scheduleSessionRefresh();

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
      return { result: unwrapGameEnvelope(data) };
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

    // v2: login via spacemolt_auth(action=login). Do NOT send session_id here:
    // the game server's login endpoint accepts only username + password and now
    // rejects any session_id with "Unknown parameter(s): session_id", which broke
    // re-auth fleet-wide on session expiry (2026-06-02). Login establishes the
    // canonical session — we parse it from the greeting below.
    const resp = await this.mcpToolCall("spacemolt_auth", {
      action: "login",
      username,
      password,
    });
    if (resp.error) {
      this.logError(`login failed: ${resp.error.code}`);
      return resp;
    }

    log.debug("login response", { agent: this.label, raw: typeof resp.result === "string" ? resp.result : JSON.stringify(resp.result) });
    this.watchChangelog(resp.result);
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

  /**
   * Pre-warm / validate the game session immediately after a successful login.
   *
   * A freshly-created game session can become stale before turn 1 if the game
   * server restarts between /api/v1/session creation and the first real tool
   * call. The symptom: the agent's very first tool call returns
   * `-32001 Session expired (server may have restarted)`, which burns the 180s
   * turn timer and triggers login/logout thrash.
   *
   * This method issues a lightweight `get_location` probe via the normal
   * `execute()` path. If the session is stale, `execute()` recognises the
   * -32001 code (now in SESSION_EXPIRED_CODES) and performs ONE clean renewal
   * before returning. The result is not used — the side-effect (renewed session)
   * is what matters.
   *
   * Called from handleLogin() in auth-handlers.ts, after client.login() returns
   * success, so that the agent's first tool call is guaranteed to hit a live
   * session.
   *
   * @returns true  if the probe succeeded (session is live)
   *          false if renewal failed (the execute() error path already logged it)
   */
  async prewarmSession(): Promise<boolean> {
    if (!this.authenticated || !this.gameSessionId) return false;
    this.log("pre-warming session (turn-1 validation probe)");
    const resp = await this.execute("spacemolt", { action: "get_location" }, { skipMetrics: true });
    if (resp.error) {
      // If renewal was attempted (session_renewal_failed / session_renewal_exhausted),
      // or if there's a non-session error, log and signal failure. The caller
      // (handleLogin) will still return a login-success response — normal execute()
      // renewal will handle any subsequent errors on the agent's first real tool call.
      this.log(`pre-warm probe returned error: ${resp.error.code} — ${resp.error.message}`);
      return false;
    }
    this.log("pre-warm session probe succeeded — session validated");
    return true;
  }

  async logout(): Promise<GameResponse> {
    if (!this.authenticated) {
      return { error: { code: "not_authenticated", message: "No active session" } };
    }
    this.clearSessionRefreshTimer();
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
      this.sessionExpiresAt = null;
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
        // Circuit-breaker: after too many reconnects the game server is likely
        // genuinely down. Stop hammering it and return a message that explicitly
        // tells the agent NOT to thrash logout/login itself.
        if (this.renewalsInWindow() >= HttpGameClientV2.MAX_RECONNECTS) {
          this.log(`session renewal limit reached (${this.renewalsInWindow()}/${HttpGameClientV2.MAX_RECONNECTS} in ${HttpGameClientV2.RENEWAL_WINDOW_MS / 1000}s) — not retrying`);
          return {
            error: {
              code: "session_renewal_exhausted",
              message: "Session renewal limit reached. Do NOT call logout or login — wait 60 seconds, then retry your action.",
            },
          };
        }
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
        // Renewal failed — return a synthesized error that suppresses the agent's
        // own logout/login thrash loop (that loop burns whole turns). Do NOT leak
        // the raw session_expired code, which Sonnet treats as "go re-login".
        return {
          error: {
            code: "session_renewal_failed",
            message: "Session renewal failed. Do NOT call logout or login — retry your action in 30 seconds.",
          },
        };
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
    this.clearSessionRefreshTimer();
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

    // get_status is the primary source (ship stats, cargo, dock, credits). If IT
    // failed we can't build a useful update. But if ONLY get_location failed
    // (common under the shared-IP -32029 rate cap — the two fan-out calls race
    // the cap), we still emit a PARTIAL update from the get_status text: cargo /
    // fuel / hull / dock all refresh, and current_system/current_poi are omitted
    // so onStateUpdate preserves the prior values. This stops a single
    // rate-limited get_location from freezing the WHOLE cache for days
    // (refreshStatus was all-or-nothing → caches stuck stale for a week).
    if (statusResp.error) {
      log.debug("refreshStatus got error from get_status", {
        agent: this.label,
        statusError: statusResp.error?.code,
        locationError: locationResp.error?.code,
      });
      return null;
    }
    const locationFailed = !!locationResp.error;
    if (locationFailed) {
      log.debug("refreshStatus: get_location failed, emitting partial from get_status text", {
        agent: this.label,
        locationError: locationResp.error?.code,
      });
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
      // current_system/current_poi come from get_location. When it failed, OMIT
      // them so onStateUpdate preserves the prior values (rather than nulling
      // position). When it succeeded, set them as usual.
      ...(locationFailed ? {} : { current_system: locInner.system_id, current_poi: locInner.poi_id }),
      // Prefer the get_status text's "Docked at:" line (always present in the
      // status fan-out call) over get_location's field, which is easier to miss
      // on a partial/renamed response. Falls back to get_location.
      docked_at_base: parsed.dockedAt ?? locInner.docked_at,
      // Include skills from the status text so they update on every status refresh.
      // This supplements (and can replace) the separate get_skills fetch at login.
      ...(parsed.skills.length > 0 ? { skills: skillsFromText } : {}),
      // Include standings if parsed (v0.280+). Omit the key entirely when absent
      // so downstream consumers can distinguish "not emitted" from "all zeroes".
      ...(Object.keys(parsed.standings).length > 0 ? { standings: parsed.standings } : {}),
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
    // current_system/current_poi are required only when get_location succeeded;
    // on a partial (location-failed) update they're intentionally omitted and
    // onStateUpdate preserves the prior position.
    const missing: string[] = [];
    if (!locationFailed && player.current_system === undefined) missing.push("player.current_system");
    if (!locationFailed && player.current_poi === undefined) missing.push("player.current_poi");
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

  /**
   * Scan the login/renewal greeting's release notes for breaking-change keywords
   * and file a deduped alert. Best-effort — never let it disrupt the login path.
   */
  private watchChangelog(result: unknown): void {
    try {
      const text = typeof result === "string" ? result : JSON.stringify(result);
      checkChangelogForBreaking(text);
    } catch { /* non-fatal */ }
  }

  /**
   * Single-flight session renewal. If a renewal is already in progress, every
   * other caller awaits that same promise rather than starting a second
   * mcpInitialize() — concurrent renewals would each mint a fresh game session
   * and orphan the others, which is the root cause of the mid-turn -32001 errors.
   *
   * The in-flight promise is cleared in a finally so a renewal that throws or
   * returns false does not permanently wedge the lock — the next caller retries.
   */
  private async renewSession(): Promise<boolean> {
    if (this.reauthPromise) {
      this.log("renewSession: awaiting in-progress renewal");
      return this.reauthPromise;
    }
    this.reauthPromise = this._doRenewSession();
    try {
      return await this.reauthPromise;
    } finally {
      this.reauthPromise = null;
    }
  }

  private async _doRenewSession(): Promise<boolean> {
    if (!this.credentials) return false;
    try {
      await this.mcpInitialize();
      // Do NOT send session_id on login — the game rejects it with
      // "Unknown parameter(s): session_id" and the whole renewal fails (matches
      // the primary login() path; sending it here flooded agents with
      // session_renewal_failed mid-turn, observed live 2026-06-21). The canonical
      // session is parsed from the greeting below.
      const resp = await this.mcpToolCall("spacemolt_auth", {
        action: "login",
        username: this.credentials.username,
        password: this.credentials.password,
      });
      if (resp.error) return false;

      this.watchChangelog(resp.result);
      this.gameSessionId = this.parseSessionIdFromGreeting(resp.result) ?? this.mcpSessionId;

      this.authenticated = true;
      this.reconnectCount++;
      this.renewalTimestamps.push(Date.now());
      log.info("[proxy] session auto-reconnect succeeded (v2)", {
        agent: this.label,
        reconnectCount: this.reconnectCount,
      });
      this.log("MCP v2 session renewed successfully");
      // mcpInitialize() already re-armed the proactive refresh timer off the new
      // expires_at; nothing else to do here.
      return true;
    } catch {
      this.logError("MCP v2 session renewal failed");
      return false;
    }
  }

  /**
   * Prune renewal timestamps older than the sliding window and return how many
   * remain. The breaker trips when this reaches MAX_RECONNECTS — i.e. only on
   * rapid renew-thrash, never on legitimate session churn spread over a long run.
   */
  private renewalsInWindow(): number {
    const cutoff = Date.now() - HttpGameClientV2.RENEWAL_WINDOW_MS;
    this.renewalTimestamps = this.renewalTimestamps.filter((t) => t >= cutoff);
    return this.renewalTimestamps.length;
  }

  /** Cancel any pending proactive refresh timer. Idempotent. */
  private clearSessionRefreshTimer(): void {
    if (this.sessionRefreshTimer) {
      clearTimeout(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
  }

  /**
   * Arm a one-shot timer to proactively renew the game session ~90s before its
   * reported expiry. Called after every successful mcpInitialize() (login +
   * renewal). No-ops if expiry is unknown, we have no credentials, or the refresh
   * point is already in the past (the on-demand path in execute() handles that).
   */
  private scheduleSessionRefresh(): void {
    this.clearSessionRefreshTimer();
    if (!this.sessionExpiresAt || !this.credentials) return;
    const msUntilExpiry = this.sessionExpiresAt - Date.now();
    const msUntilRefresh = msUntilExpiry - HttpGameClientV2.REFRESH_LEAD_MS;
    if (msUntilRefresh <= 0) return; // Already near/past expiry — let execute() renew on demand.
    this.sessionRefreshTimer = setTimeout(() => {
      this.sessionRefreshTimer = null;
      if (!this.authenticated || !this.credentials) return;
      this.log(`proactive session refresh (~${Math.round(msUntilExpiry / 1000)}s before expiry)`);
      // Fire-and-forget; renewSession() never rejects (it returns false on failure),
      // but guard anyway so a thrown error can't surface as an unhandled rejection.
      this.renewSession().catch((err) => {
        this.logError(`proactive session refresh threw: ${err}`);
      });
    }, msUntilRefresh);
    // Don't keep the event loop alive solely for this timer.
    (this.sessionRefreshTimer as { unref?: () => void }).unref?.();
  }
}

// ---------------------------------------------------------------------------
// get_status text parser — moved to ./game-text-parser.ts (the single home for
// all game-response TEXT parsing). Re-exported here so existing importers and
// tests keep working; the implementation lives in exactly one place now.
// ---------------------------------------------------------------------------
export { parseGetStatusText, type ParsedGetStatus };
