/**
 * Instability metrics — sliding-window error rate and latency tracking.
 *
 * Tracks game server health over a configurable time window and derives
 * an overall status: healthy | degraded | unstable | down.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("instability-metrics");

/**
 * Server health status progression:
 * - healthy: all requests succeeding
 * - degraded: 3-10% error rate, agents warned but can continue
 * - unstable: >10% error rate, circuit breaker open, agents should logout
 * - recovering: was down, now probing for recovery, transitional state
 * - down: no successful requests for 2+ minutes, server unreachable
 */
export type ServerStatus = "healthy" | "degraded" | "unstable" | "recovering" | "down";

export interface HealthMetrics {
  window: {
    startTime: number; // epoch ms
    durationMs: number;
  };
  errors: {
    total: number;
    count504: number;
    count503: number;
    count502: number;
    count409: number;
    countTimeout: number;
    countRateLimit: number;
    countConnection: number;
    countOther: number;
  };

  requests: {
    total: number;
    successful: number;
  };
  circuitBreaker: {
    state: string;
    consecutiveErrors: number;
  };
  status: ServerStatus;
  reason: string;
}

interface ErrorRecord {
  time: number; // epoch ms
  code: number | string;
}

interface RequestRecord {
  time: number;
  success: boolean;
}

export interface MetricsConfig {
  windowMs: number;
  /** Error rate threshold for "degraded" */
  degradedErrorRate: number;
  /** Error rate threshold for "unstable" */
  unstableErrorRate: number;

  /** No successful calls for this long → "down" */
  downTimeoutMs: number;
}

const DEFAULT_CONFIG: MetricsConfig = {
  windowMs: 10 * 60 * 1000, // 10 minutes
  degradedErrorRate: 0.03,   // 3% — 1% was too sensitive; login/sell hit tick boundaries naturally
  unstableErrorRate: 0.10,   // 10%

  downTimeoutMs: 2 * 60 * 1000, // 2 minutes
};

/**
 * Interval between recovery probes when server is unstable/down (ms).
 * Reduced from 30s to 10s for faster recovery detection.
 * Recovery callback should be fast (cache-only health check, <100ms).
 */
const RECOVERY_PROBE_INTERVAL_MS = 10_000;

export class MetricsWindow {
  private errors: ErrorRecord[] = [];
  private requests: RequestRecord[] = [];
  private consecutiveErrors = 0;
  private lastSuccessTime = Date.now();
  private cbState: "open" | "closed" | "half-open" = "closed";
  private lastStatus: ServerStatus = "healthy";
  private recoveryProbeTimer: ReturnType<typeof setInterval> | null = null;
  private probeCallback: (() => Promise<void>) | null = null;

  readonly config: MetricsConfig;

  constructor(config: Partial<MetricsConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Register a probe callback for recovery checks.
   * When the server is unstable/down, this callback fires every 30s.
   * If the probe records a success (via recordSuccess), status transitions back.
   */
  setProbeCallback(cb: () => Promise<void>): void {
    this.probeCallback = cb;
  }

  /** Start the recovery probe timer (call after setting probeCallback) */
  startRecoveryProbe(): void {
    if (this.recoveryProbeTimer) return;
    const interval = setInterval(async () => {
      const status = this.getMetrics().status;
      if (status === "unstable" || status === "down") {
        log.info("recovery probe firing", { status });
        try {
          await this.probeCallback?.();
        } catch (err) {
          log.debug("recovery probe failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
    }, RECOVERY_PROBE_INTERVAL_MS);
    interval.unref?.();
    this.recoveryProbeTimer = interval;
  }

  /** Stop the recovery probe timer */
  stopRecoveryProbe(): void {
    if (this.recoveryProbeTimer) {
      clearInterval(this.recoveryProbeTimer);
      this.recoveryProbeTimer = null;
    }
  }

  /** Record a successful request. */
  recordSuccess(): void {
    const now = Date.now();
    this.requests.push({ time: now, success: true });
    this.consecutiveErrors = 0;
    this.lastSuccessTime = now;
  }

  /** Record an error with its code (HTTP status or string) */
  recordError(code: number | string): void {
    const now = Date.now();
    this.errors.push({ time: now, code });
    this.requests.push({ time: now, success: false });
    this.consecutiveErrors++;
  }

  /** Update circuit breaker state (called from CB transitions) */
  setCircuitBreakerState(state: "open" | "closed" | "half-open"): void {
    this.cbState = state;
  }

  /** Get current consecutive error count */
  getConsecutiveErrors(): number {
    return this.consecutiveErrors;
  }

  /** Prune records older than the window */
  private prune(): void {
    const cutoff = Date.now() - this.config.windowMs;
    this.errors = this.errors.filter((e) => e.time > cutoff);
    this.requests = this.requests.filter((r) => r.time > cutoff);
  }

  /** Get current health metrics snapshot */
  getMetrics(): HealthMetrics {
    this.prune();

    const now = Date.now();
    const totalRequests = this.requests.length;
    const successfulRequests = this.requests.filter((r) => r.success).length;
    const errorRate = totalRequests > 0 ? this.errors.length / totalRequests : 0;

    // Single pass over errors to compute all category counts.
    // Error codes are always strings (from game-client.ts resp.error.code),
    // so compare with String() to handle both string and numeric codes.
    let count504 = 0, count503 = 0, count502 = 0, count409 = 0, countTimeout = 0, countRateLimit = 0, countConnection = 0;
    for (const e of this.errors) {
      const code = String(e.code);
      if (code === "504") count504++;
      else if (code === "503") count503++;
      else if (code === "502") count502++;
      else if (code === "409" || code === "action_pending") count409++;
      else if (code === "timeout" || code === "408") countTimeout++;
      else if (code === "429" || code === "rate_limited") countRateLimit++;
      else if (
        code === "connection_failed" ||
        code === "connection_lost" ||
        code === "connection_timeout" ||
        code === "connection_refused" ||
        code === "connection_retry_failed"
      ) countConnection++;
    }
    const categorized = count504 + count503 + count502 + count409 + countTimeout + countRateLimit + countConnection;
    const errors = {
      total: this.errors.length,
      count504, count503, count502, count409, countTimeout, countRateLimit, countConnection,
      countOther: this.errors.length - categorized,
    };

    // Derive status
    const { status, reason } = this.deriveStatus(errorRate, now, totalRequests, successfulRequests);

    return {
      window: { startTime: now - this.config.windowMs, durationMs: this.config.windowMs },
      errors,
      requests: { total: totalRequests, successful: successfulRequests },
      circuitBreaker: {
        state: this.cbState,
        consecutiveErrors: this.consecutiveErrors,
      },
      status,
      reason,
    };
  }

  private deriveStatus(
    errorRate: number,
    now: number,
    totalRequests: number,
    successfulRequests: number,
  ): { status: ServerStatus; reason: string } {
    // Require minimum sample count before error-rate evaluation.
    // At session start with only a few calls, a single error skews the rate.
    // With 5 agents doing login+discovery, the first 10 calls complete in seconds —
    // need enough samples to avoid false positives from initial burst errors.
    const MIN_SAMPLES = 30;

    // Down: no successful calls in downTimeoutMs
    const timeSinceSuccess = now - this.lastSuccessTime;
    if (this.requests.length > 0 && timeSinceSuccess > this.config.downTimeoutMs) {
      const result = { status: "down" as ServerStatus, reason: `No successful calls in ${Math.round(timeSinceSuccess / 1000)}s` };
      if (this.lastStatus !== "down") {
        log.warn(`Server status transition: ${this.lastStatus} → down | ${result.reason}`);
        this.lastStatus = "down";
      }
      return result;
    }

    // Recovering: was down, now getting successful calls but error rate still needs improvement
    // If error rate is still elevated (>degraded threshold), stay in recovering state
    // Otherwise fall through to check degraded/healthy thresholds below
    if ((this.lastStatus === "down" || this.lastStatus === "recovering") && successfulRequests > 0 && errorRate > this.config.degradedErrorRate) {
      const result = { status: "recovering" as ServerStatus, reason: `Recovering (error rate ${(errorRate * 100).toFixed(1)}%, ${successfulRequests}/${totalRequests} successful)` };
      if (this.lastStatus !== "recovering") {
        log.info(`Server status transition: ${this.lastStatus} → recovering | ${result.reason}`);
        this.lastStatus = "recovering";
      }
      return result;
    }

    // Circuit breaker states bypass MIN_SAMPLES — they're direct indicators of problems
    if (this.cbState === "open") {
      const result = { status: "unstable" as ServerStatus, reason: "Circuit breaker is open" };
      if (this.lastStatus !== "unstable") {
        log.warn(`Server status transition: ${this.lastStatus} → unstable | ${result.reason} | errors: ${this.errors.length}, errorRate: ${(errorRate * 100).toFixed(1)}%`);
        this.lastStatus = "unstable";
      }
      return result;
    }
    if (this.cbState === "half-open") {
      const result = { status: "degraded" as ServerStatus, reason: "Circuit breaker is half-open (probing)" };
      if (this.lastStatus !== "degraded") {
        log.info(`Server status transition: ${this.lastStatus} → degraded | ${result.reason}`);
        this.lastStatus = "degraded";
      }
      return result;
    }

    // Check if we have enough samples for error-rate evaluation
    if (this.requests.length < MIN_SAMPLES) {
      if (this.lastStatus !== "healthy") {
        this.lastStatus = "healthy";
      }
      return { status: "healthy", reason: "insufficient samples" };
    }

    // Unstable: high error rate or latency
    if (errorRate > this.config.unstableErrorRate) {
      const result = { status: "unstable" as ServerStatus, reason: `Error rate ${(errorRate * 100).toFixed(1)}% > ${this.config.unstableErrorRate * 100}%` };
      if (this.lastStatus !== "unstable") {
        log.warn(`Server status transition: ${this.lastStatus} → unstable | ${result.reason} | totalErrors: ${this.errors.length}, totalRequests: ${this.requests.length}`);
        this.lastStatus = "unstable";
      }
      return result;
    }
    // Degraded: moderate error rate
    if (errorRate > this.config.degradedErrorRate) {
      const result = { status: "degraded" as ServerStatus, reason: `Error rate ${(errorRate * 100).toFixed(1)}% > ${this.config.degradedErrorRate * 100}%` };
      if (this.lastStatus !== "degraded") {
        log.info(`Server status transition: ${this.lastStatus} → degraded | ${result.reason} | totalErrors: ${this.errors.length}, totalRequests: ${this.requests.length}`);
        this.lastStatus = "degraded";
      }
      return result;
    }
    // Healthy: recovery from degraded/unstable
    if (this.lastStatus !== "healthy") {
      log.info(`Server status transition: ${this.lastStatus} → healthy | recovered | errorRate: ${(errorRate * 100).toFixed(2)}%`);
      this.lastStatus = "healthy";
    }

    return { status: "healthy", reason: "" };
  }
}

