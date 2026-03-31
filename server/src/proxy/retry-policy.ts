/**
 * Retry with exponential backoff for game server calls.
 *
 * Wraps async operations with configurable retry logic including
 * jitter to prevent thundering herds.
 */

import { classifyGameError, type ClassifiedError } from "./error-classifier.js";
import type { GameResponse } from "./game-client.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("retry");

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFraction: number;
}

/**
 * Default retry policy: aggressive backoff for transient game server errors.
 * Sequence: 1s, 2s, 4s, 8s, 16s (5 retries max)
 * Jitter: ±20% to prevent thundering herd
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 16000,
  backoffMultiplier: 2.0,
  jitterFraction: 0.2,
};

/**
 * Faster retry policy for action_pending (409) and rate limits (429).
 * These are game tick timing issues, not server failures — faster retries help.
 * Sequence: 500ms, 1s, 2s, 4s (4 retries max)
 */
export const FAST_RETRY_POLICY: RetryPolicy = {
  maxRetries: 4,
  initialDelayMs: 500,
  maxDelayMs: 4000,
  backoffMultiplier: 2.0,
  jitterFraction: 0.2,
};

/**
 * Retryable error codes from game server WebSocket responses (handled by withRetry).
 *
 * Note: action_pending, rate_limited, and cooldown are NOT retried here — they are
 * handled at a higher level in GameClient.execute() with their own wait-and-retry logic.
 *
 * - timeout: command timed out, may succeed on retry with exponential backoff
 * - connection_reset: WebSocket connection reset, likely recoverable
 * - connection_lost: WS dropped mid-command, may recover on reconnect
 * - connection_retry_failed: all reconnect attempts exhausted, not retryable at this layer
 */
const RETRYABLE_CODES = new Set([
  "timeout",
  "connection_reset",
  "connection_lost",
]);

/**
 * Calculate delay for a given attempt using exponential backoff + jitter.
 * Exported for testing.
 */
export function calculateDelay(attempt: number, policy: RetryPolicy): number {
  const baseDelay = Math.min(
    policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt),
    policy.maxDelayMs,
  );
  const jitter = baseDelay * policy.jitterFraction * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(baseDelay + jitter));
}

/**
 * Determine if a game response error is retryable.
 * Does NOT include action_pending (handled separately by game-client execute()).
 */
export function isRetryableError(resp: GameResponse): boolean {
  if (!resp.error) return false;
  return RETRYABLE_CODES.has(resp.error.code);
}

export interface RetryResult {
  response: GameResponse;
  attempts: number;
  /** Classified error from last failed attempt, if any */
  lastError?: ClassifiedError;
}

/**
 * Execute a game call with retry logic.
 *
 * The `fn` should be a function that performs a single game server call
 * and returns the response. This wrapper handles retries on transient errors.
 *
 * Note: action_pending (409) is NOT retried here — it's handled by
 * GameClient.execute() which has its own wait-and-retry logic.
 */
export async function withRetry(
  fn: () => Promise<GameResponse>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  label = "unknown",
): Promise<RetryResult> {
  let lastError: ClassifiedError | undefined;

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    const resp = await fn();

    // Success — no error
    if (!resp.error) {
      return { response: resp, attempts: attempt + 1 };
    }

    // Classify the error
    const classified = classifyGameError(resp.error.code, resp.error.message);
    lastError = classified;

    // Not retryable or out of retries — return as-is
    if (!isRetryableError(resp) || attempt >= policy.maxRetries) {
      return { response: resp, attempts: attempt + 1, lastError };
    }

    // Calculate delay and wait
    const delay = calculateDelay(attempt, policy);
    log.info(`[${label}] Retryable error (${resp.error.code}), attempt ${attempt + 1}/${policy.maxRetries}, waiting ${delay}ms`);
    await new Promise((r) => setTimeout(r, delay));
  }

  // Should never reach here, but satisfy TypeScript
  return {
    response: { error: { code: "retry_exhausted", message: "All retries failed" } },
    attempts: policy.maxRetries + 1,
    lastError,
  };
}
