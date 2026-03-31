/**
 * Error classifier for game server responses.
 *
 * Categorizes HTTP status codes, network errors, and MCP errors into
 * actionable types so retry/circuit-breaker logic can decide what to do.
 */

export type ErrorCategory =
  | "gateway_timeout"    // 504
  | "service_unavailable" // 503
  | "bad_gateway"        // 502
  | "conflict"           // 409 action_pending
  | "rate_limited"       // 429
  | "request_timeout"    // 408
  | "server_error"       // other 5xx
  | "connection_refused" // ECONNREFUSED
  | "connection_reset"   // ECONNRESET
  | "connection_lost"    // WS dropped mid-command
  | "connection_timeout" // connection timed out
  | "connection_retry_failed" // all reconnect attempts exhausted
  | "network_timeout"    // ETIMEDOUT
  | "host_unreachable"   // EHOSTUNREACH
  | "dns_error"          // DNS resolution failure
  | "mcp_timeout"        // MCP request_timeout
  | "mcp_blocked"        // toolUseBlocked
  | "mcp_error"          // other MCP errors
  | "client_error"       // 4xx (non-retryable)
  | "unknown";

export type ErrorAction =
  | "retry"       // retry with exponential backoff
  | "wait_retry"  // wait (action_pending), then retry
  | "backoff"     // longer backoff (503, rate limit)
  | "mark_down"   // server unreachable, mark as down
  | "log"         // log only, don't retry
  | "pass";       // pass through to agent

export interface ClassifiedError {
  category: ErrorCategory;
  action: ErrorAction;
  retryable: boolean;
  /** Original status code if HTTP, or error code string */
  code: number | string;
  message: string;
}

/** HTTP status → category mapping */
const STATUS_MAP: Record<number, { category: ErrorCategory; action: ErrorAction }> = {
  504: { category: "gateway_timeout", action: "retry" },
  503: { category: "service_unavailable", action: "backoff" },
  502: { category: "bad_gateway", action: "retry" },
  409: { category: "conflict", action: "wait_retry" },
  429: { category: "rate_limited", action: "backoff" },
  408: { category: "request_timeout", action: "retry" },
};

/** Network error code → category mapping */
const NETWORK_ERROR_MAP: Record<string, { category: ErrorCategory; action: ErrorAction }> = {
  ECONNREFUSED: { category: "connection_refused", action: "mark_down" },
  ECONNRESET: { category: "connection_reset", action: "retry" },
  ETIMEDOUT: { category: "network_timeout", action: "retry" },
  EHOSTUNREACH: { category: "host_unreachable", action: "mark_down" },
  ENOTFOUND: { category: "dns_error", action: "mark_down" },
  EAI_AGAIN: { category: "dns_error", action: "mark_down" },
};

/** MCP error code → category mapping */
const MCP_ERROR_MAP: Record<string, { category: ErrorCategory; action: ErrorAction }> = {
  request_timeout: { category: "mcp_timeout", action: "retry" },
  toolUseBlocked: { category: "mcp_blocked", action: "pass" },
};

/** Retryable categories */
const RETRYABLE: Set<ErrorCategory> = new Set([
  "gateway_timeout",
  "service_unavailable",
  "bad_gateway",
  "conflict",
  "request_timeout",
  "connection_reset",
  "connection_lost",
  "connection_timeout",
  "network_timeout",
  "mcp_timeout",
]);

/** Classify an HTTP status code error */
export function classifyHttpError(status: number, message = ""): ClassifiedError {
  const mapping = STATUS_MAP[status];
  if (mapping) {
    return {
      ...mapping,
      retryable: RETRYABLE.has(mapping.category),
      code: status,
      message,
    };
  }

  if (status >= 500) {
    return {
      category: "server_error",
      action: "log",
      retryable: false,
      code: status,
      message,
    };
  }

  return {
    category: "client_error",
    action: "log",
    retryable: false,
    code: status,
    message,
  };
}

/** Classify a network-level error (ECONNREFUSED, ETIMEDOUT, etc.) */
export function classifyNetworkError(err: Error): ClassifiedError {
  const code = (err as NodeJS.ErrnoException).code ?? "";
  const mapping = NETWORK_ERROR_MAP[code];
  if (mapping) {
    return {
      ...mapping,
      retryable: RETRYABLE.has(mapping.category),
      code,
      message: err.message,
    };
  }

  return {
    category: "unknown",
    action: "log",
    retryable: false,
    code: code || "unknown",
    message: err.message,
  };
}

/** Classify an MCP protocol error */
export function classifyMcpError(code: string, message = ""): ClassifiedError {
  const mapping = MCP_ERROR_MAP[code];
  if (mapping) {
    return {
      ...mapping,
      retryable: RETRYABLE.has(mapping.category),
      code,
      message,
    };
  }

  return {
    category: "mcp_error",
    action: "log",
    retryable: false,
    code,
    message,
  };
}

/** Game error code → category mapping (action_pending = 409-equivalent) */
const GAME_ERROR_MAP: Record<string, { category: ErrorCategory; action: ErrorAction; retryable?: boolean }> = {
  action_pending:        { category: "conflict",              action: "wait_retry" },
  timeout:               { category: "request_timeout",       action: "retry" },
  connection_lost:       { category: "connection_lost",       action: "retry" },
  connection_timeout:    { category: "connection_timeout",    action: "retry" },
  connection_refused:    { category: "connection_refused",    action: "mark_down" },
  connection_retry_failed: { category: "connection_retry_failed", action: "mark_down" },
  rate_limited:          { category: "rate_limited",          action: "backoff", retryable: true },
  cooldown:              { category: "rate_limited",          action: "backoff", retryable: true },
};

/** Classify a game-client response error code (from WebSocket protocol) */
export function classifyGameError(code: string, message = ""): ClassifiedError {
  const mapping = GAME_ERROR_MAP[code];
  if (mapping) {
    return {
      ...mapping,
      retryable: mapping.retryable ?? RETRYABLE.has(mapping.category),
      code,
      message,
    };
  }

  return {
    category: "unknown",
    action: "log",
    retryable: false,
    code,
    message,
  };
}
