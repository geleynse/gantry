import { describe, it, expect } from "bun:test";
import {
  classifyHttpError,
  classifyNetworkError,
  classifyMcpError,
  classifyGameError,
} from "./error-classifier.js";

describe("classifyHttpError", () => {
  it("classifies 504 as gateway_timeout, retryable", () => {
    const result = classifyHttpError(504, "Gateway Timeout");
    expect(result.category).toBe("gateway_timeout");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
    expect(result.code).toBe(504);
  });

  it("classifies 503 as service_unavailable, retryable with backoff", () => {
    const result = classifyHttpError(503);
    expect(result.category).toBe("service_unavailable");
    expect(result.action).toBe("backoff");
    expect(result.retryable).toBe(true);
  });

  it("classifies 502 as bad_gateway, retryable", () => {
    const result = classifyHttpError(502);
    expect(result.category).toBe("bad_gateway");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies 409 as conflict, retryable with wait", () => {
    const result = classifyHttpError(409, "action_pending");
    expect(result.category).toBe("conflict");
    expect(result.action).toBe("wait_retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies 429 as rate_limited, retryable with backoff", () => {
    const result = classifyHttpError(429);
    expect(result.category).toBe("rate_limited");
    expect(result.action).toBe("backoff");
    expect(result.retryable).toBe(false); // rate_limited is NOT in RETRYABLE set
  });

  it("classifies 408 as request_timeout, retryable", () => {
    const result = classifyHttpError(408);
    expect(result.category).toBe("request_timeout");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies unknown 5xx as server_error, not retryable", () => {
    const result = classifyHttpError(500, "Internal Server Error");
    expect(result.category).toBe("server_error");
    expect(result.action).toBe("log");
    expect(result.retryable).toBe(false);
  });

  it("classifies 4xx (non-mapped) as client_error, not retryable", () => {
    const result = classifyHttpError(404, "Not Found");
    expect(result.category).toBe("client_error");
    expect(result.action).toBe("log");
    expect(result.retryable).toBe(false);
  });

  it("preserves the message in the result", () => {
    const result = classifyHttpError(504, "Server overloaded");
    expect(result.message).toBe("Server overloaded");
  });
});

describe("classifyNetworkError", () => {
  it("classifies ECONNREFUSED as connection_refused, mark_down", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const result = classifyNetworkError(err);
    expect(result.category).toBe("connection_refused");
    expect(result.action).toBe("mark_down");
    expect(result.retryable).toBe(false);
  });

  it("classifies ECONNRESET as connection_reset, retryable", () => {
    const err = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const result = classifyNetworkError(err);
    expect(result.category).toBe("connection_reset");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies ETIMEDOUT as network_timeout, retryable", () => {
    const err = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const result = classifyNetworkError(err);
    expect(result.category).toBe("network_timeout");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies EHOSTUNREACH as host_unreachable, mark_down", () => {
    const err = Object.assign(new Error("host unreachable"), { code: "EHOSTUNREACH" });
    const result = classifyNetworkError(err);
    expect(result.category).toBe("host_unreachable");
    expect(result.action).toBe("mark_down");
    expect(result.retryable).toBe(false);
  });

  it("classifies ENOTFOUND as dns_error, mark_down", () => {
    const err = Object.assign(new Error("dns failed"), { code: "ENOTFOUND" });
    const result = classifyNetworkError(err);
    expect(result.category).toBe("dns_error");
    expect(result.action).toBe("mark_down");
    expect(result.retryable).toBe(false);
  });

  it("classifies unknown error code as unknown", () => {
    const err = new Error("something weird");
    const result = classifyNetworkError(err);
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
  });
});

describe("classifyMcpError", () => {
  it("classifies request_timeout as mcp_timeout, retryable", () => {
    const result = classifyMcpError("request_timeout", "timed out");
    expect(result.category).toBe("mcp_timeout");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies toolUseBlocked as mcp_blocked, pass-through", () => {
    const result = classifyMcpError("toolUseBlocked", "tool blocked");
    expect(result.category).toBe("mcp_blocked");
    expect(result.action).toBe("pass");
    expect(result.retryable).toBe(false);
  });

  it("classifies unknown MCP error as mcp_error", () => {
    const result = classifyMcpError("protocol_mismatch", "version mismatch");
    expect(result.category).toBe("mcp_error");
    expect(result.action).toBe("log");
    expect(result.retryable).toBe(false);
  });
});

describe("classifyGameError", () => {
  it("classifies action_pending as conflict, retryable", () => {
    const result = classifyGameError("action_pending", "busy");
    expect(result.category).toBe("conflict");
    expect(result.action).toBe("wait_retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies timeout as request_timeout, retryable", () => {
    const result = classifyGameError("timeout", "timed out");
    expect(result.category).toBe("request_timeout");
    expect(result.retryable).toBe(true);
  });

  it("classifies connection_lost as retryable", () => {
    const result = classifyGameError("connection_lost");
    expect(result.category).toBe("connection_lost");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies connection_timeout as retryable", () => {
    const result = classifyGameError("connection_timeout");
    expect(result.category).toBe("connection_timeout");
    expect(result.action).toBe("retry");
    expect(result.retryable).toBe(true);
  });

  it("classifies connection_refused as non-retryable mark_down", () => {
    const result = classifyGameError("connection_refused");
    expect(result.category).toBe("connection_refused");
    expect(result.action).toBe("mark_down");
    expect(result.retryable).toBe(false);
  });

  it("classifies connection_retry_failed as non-retryable mark_down", () => {
    const result = classifyGameError("connection_retry_failed");
    expect(result.category).toBe("connection_retry_failed");
    expect(result.action).toBe("mark_down");
    expect(result.retryable).toBe(false);
  });

  it("classifies rate_limited as rate_limited, retryable", () => {
    const result = classifyGameError("rate_limited");
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("classifies cooldown as rate_limited", () => {
    const result = classifyGameError("cooldown");
    expect(result.category).toBe("rate_limited");
  });

  it("classifies unknown game error as unknown", () => {
    const result = classifyGameError("not_docked", "must be docked");
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
  });
});
