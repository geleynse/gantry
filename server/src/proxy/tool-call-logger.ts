import { randomBytes } from "node:crypto";
import { queryInsert, queryRun } from "../services/database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tool-call-logger");

/**
 * Generate a trace ID for request correlation.
 * Format: <agent-prefix-4chars>-<timestamp-ms>-<random-4hex>
 * Example: drft-1741267200123-a3f2
 */
export function generateTraceId(agentName: string): string {
  const prefix = agentName.replace(/-/g, "").slice(0, 4);
  const ts = Date.now();
  const rand = randomBytes(2).toString("hex");
  return `${prefix}-${ts}-${rand}`;
}

const RING_BUFFER_SIZE = 200;

export interface ToolCallRecord {
  id: number;
  agent: string;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  duration_ms: number | null;
  is_compound: number;
  status: string; // 'pending' | 'complete' | 'error'
  assistant_text: string | null;
  trace_id: string | null;
  parent_id: number | null;
  timestamp: string;
  created_at: string;
}

// In-memory ring buffer for SSE streaming — shared with tool-calls route
const ringBuffer: ToolCallRecord[] = [];
let ringSeq = 0;

function pushToRing(record: ToolCallRecord): void {
  if (ringBuffer.length >= RING_BUFFER_SIZE) {
    ringBuffer.shift();
  }
  ringBuffer.push(record);
  ringSeq++;
  notifySubscribers(record);
}

export function getRingBuffer(): ToolCallRecord[] {
  return ringBuffer;
}

export function getRingSeq(): number {
  return ringSeq;
}

// Subscriber pattern for SSE push (alternative to polling)
type Subscriber = (record: ToolCallRecord) => void;
const subscribers = new Set<Subscriber>();

const MAX_SUBSCRIBERS = 50;

export function subscribe(cb: Subscriber): boolean {
  if (subscribers.size >= MAX_SUBSCRIBERS) {
    return false;
  }
  subscribers.add(cb);
  return true;
}

export function unsubscribe(cb: Subscriber): void {
  subscribers.delete(cb);
}

function notifySubscribers(record: ToolCallRecord): void {
  for (const cb of subscribers) {
    try {
      cb(record);
    } catch {
      // Individual subscriber errors must not break the logger
    }
  }
}

function truncate(str: unknown, maxLen: number): string | null {
  if (str == null) return null;
  const s = typeof str === "string" ? str : JSON.stringify(str);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

function insertRecord(rec: {
  agent: string;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: boolean;
  error_code: string | null;
  duration_ms: number | null;
  is_compound: boolean;
  status?: string;
  assistant_text?: string | null;
  trace_id?: string | null;
  parent_id?: number | null;
}): number {
  try {
    const status = rec.status ?? "complete";
    const traceId = rec.trace_id ?? null;
    const parentId = rec.parent_id ?? null;
    const id = queryInsert(`
      INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, error_code, duration_ms, is_compound, status, assistant_text, trace_id, parent_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
      rec.agent,
      rec.tool_name,
      rec.args_summary,
      rec.result_summary,
      rec.success ? 1 : 0,
      rec.error_code,
      rec.duration_ms,
      rec.is_compound ? 1 : 0,
      status,
      rec.assistant_text ?? null,
      traceId,
      parentId,
    );

    const now = new Date().toISOString();

    pushToRing({
      id,
      agent: rec.agent,
      tool_name: rec.tool_name,
      args_summary: rec.args_summary,
      result_summary: rec.result_summary,
      success: rec.success ? 1 : 0,
      error_code: rec.error_code,
      duration_ms: rec.duration_ms,
      is_compound: rec.is_compound ? 1 : 0,
      status,
      assistant_text: rec.assistant_text ?? null,
      trace_id: traceId,
      parent_id: parentId,
      timestamp: now,
      created_at: now,
    });

    return id;
  } catch (err) {
    log.warn(`Failed to insert tool call record: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Log assistant text (narrative commentary between tool calls).
 * Stored as a special record with tool_name = '__assistant_text'.
 */
export function logAssistantText(
  agent: string,
  text: string,
  traceId?: string | null,
): void {
  if (!text.trim()) return;
  insertRecord({
    agent,
    tool_name: "__assistant_text",
    args_summary: null,
    result_summary: null,
    success: true,
    error_code: null,
    duration_ms: 0,
    is_compound: false,
    status: "complete",
    assistant_text: truncate(text, 2000) ?? text,
    trace_id: traceId ?? null,
  });
}

/**
 * Log extended thinking/reasoning blocks from Claude's internal reasoning.
 * Stored as a special record with tool_name = '__reasoning'.
 * These precede subsequent tool calls and help explain WHY an agent acts.
 */
export function logAgentReasoning(
  agent: string,
  reasoning: string,
  traceId?: string | null,
): void {
  if (!reasoning.trim()) return;
  insertRecord({
    agent,
    tool_name: "__reasoning",
    args_summary: null,
    result_summary: null,
    success: true,
    error_code: null,
    duration_ms: 0,
    is_compound: false,
    status: "complete",
    assistant_text: truncate(reasoning, 2000) ?? reasoning,
    trace_id: traceId ?? null,
  });
}

/** Event types too noisy / internal to log */
const SKIP_EVENT_TYPES = new Set([
  "state_update",
  "tick",
  "welcome",
  "_reconnected",
]);

export function logWsEvent(agent: string, type: string, payload: unknown): void {
  if (SKIP_EVENT_TYPES.has(type)) return;

  insertRecord({
    agent,
    tool_name: `ws:${type}`,
    args_summary: null,
    result_summary: truncate(payload, 300),
    success: type !== "player_died",
    error_code: null,
    duration_ms: 0,
    is_compound: false,
  });
}

export function logToolCall(
  agent: string,
  toolName: string,
  args: unknown,
  result: unknown,
  durationMs: number,
  opts?: {
    success?: boolean;
    errorCode?: string;
    isCompound?: boolean;
    assistantText?: string | null;
    traceId?: string | null;
    parentId?: number | null;
  },
): void {
  insertRecord({
    agent,
    tool_name: toolName,
    args_summary: truncate(args, 1000),
    result_summary: truncate(result, 2000),
    success: opts?.success !== false,
    error_code: opts?.errorCode ?? null,
    duration_ms: Math.round(durationMs),
    is_compound: opts?.isCompound ?? false,
    status: "complete",
    assistant_text: opts?.assistantText,
    trace_id: opts?.traceId,
    parent_id: opts?.parentId,
  });
}

/**
 * Log the start of a tool call (pending state).
 * Returns the record ID for later update via logToolCallComplete().
 */
export function logToolCallStart(
  agent: string,
  toolName: string,
  args: unknown,
  opts?: { isCompound?: boolean; assistantText?: string | null; traceId?: string | null; parentId?: number | null },
): number {
  return insertRecord({
    agent,
    tool_name: toolName,
    args_summary: truncate(args, 1000),
    result_summary: null,
    success: true,
    error_code: null,
    duration_ms: null,
    is_compound: opts?.isCompound ?? false,
    status: "pending",
    assistant_text: opts?.assistantText,
    trace_id: opts?.traceId,
    parent_id: opts?.parentId,
  });
}

/**
 * Complete a pending tool call record with result, duration, and final status.
 */
export function logToolCallComplete(
  pendingId: number,
  agent: string,
  toolName: string,
  result: unknown,
  durationMs: number,
  opts?: { success?: boolean; errorCode?: string; isCompound?: boolean },
): void {
  if (!pendingId) return; // insertRecord returned 0 on failure

  const success = opts?.success !== false;
  const status = success ? "complete" : "error";
  const resultSummary = truncate(result, 2000);
  const errorCode = opts?.errorCode ?? null;

  try {
    queryRun(`
      UPDATE proxy_tool_calls
      SET result_summary = ?, duration_ms = ?, success = ?, error_code = ?, status = ?
      WHERE id = ?
    `,
      resultSummary,
      Math.round(durationMs),
      success ? 1 : 0,
      errorCode,
      status,
      pendingId,
    );

    // Update ring buffer entry in-place (search from end — most recent entry with this ID)
    let existing: ToolCallRecord | undefined;
    for (let i = ringBuffer.length - 1; i >= 0; i--) {
      if (ringBuffer[i].id === pendingId) { existing = ringBuffer[i]; break; }
    }
    if (existing) {
      existing.result_summary = resultSummary;
      existing.duration_ms = Math.round(durationMs);
      existing.success = success ? 1 : 0;
      existing.error_code = errorCode;
      existing.status = status;
    }

    // Notify subscribers with the completed record
    const now = new Date().toISOString();
    const completedRecord: ToolCallRecord = existing ?? {
      id: pendingId,
      agent,
      tool_name: toolName,
      args_summary: null,
      result_summary: resultSummary,
      success: success ? 1 : 0,
      error_code: errorCode,
      duration_ms: Math.round(durationMs),
      is_compound: opts?.isCompound ? 1 : 0,
      status,
      assistant_text: null,
      trace_id: null,
      parent_id: null,
      timestamp: now,
      created_at: now,
    };
    notifySubscribers(completedRecord);
  } catch {
    // Non-fatal
  }
}
