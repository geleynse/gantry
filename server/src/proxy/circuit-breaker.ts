/**
 * Circuit breaker for the game server WebSocket connection.
 *
 * Tracks consecutive connection failures across all agents. When failures
 * exceed the threshold, the circuit "opens" and rejects new connections
 * immediately for a cooldown period — saving agents from burning retries
 * against a down server.
 *
 * States:
 *   closed    → normal operation, connections allowed
 *   open      → server is down, connections rejected immediately
 *   half-open → cooldown expired, probe connections allowed to test recovery
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("circuit-breaker");

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failureThreshold: number;    // consecutive errors → OPEN
  successThreshold: number;    // successes in HALF_OPEN → CLOSED
  cooldownMs: number;          // time before trying HALF_OPEN
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  consecutiveSuccesses: number;
  lastStateChange: number; // epoch ms
  cooldown_remaining_ms?: number;
  totalTransitions: number;
}

export type StateChangeListener = (from: CircuitState, to: CircuitState) => void;

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  successThreshold: 2,
  cooldownMs: 60_000, // 1 minute
};

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;
  private lastStateChange = Date.now();
  private totalTransitions = 0;
  private listeners: StateChangeListener[] = [];
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Subscribe to state transitions */
  onStateChange(listener: StateChangeListener): void {
    this.listeners.push(listener);
  }

  /** Record a successful connection/call. May close the breaker from half-open. */
  recordSuccess(): void {
    if (this.state === "half-open") {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        log.info(`Circuit breaker: half-open → closed (${this.consecutiveSuccesses}/${this.config.successThreshold} probes succeeded)`);
        this.transitionTo("closed");
        this.failures = 0;
        this.consecutiveSuccesses = 0;
      } else {
        log.debug(`Circuit breaker: probe succeeded (${this.consecutiveSuccesses}/${this.config.successThreshold})`);
      }
    } else if (this.state === "closed") {
      this.failures = 0;
      this.consecutiveSuccesses = 0;
    } else {
      // Open state — shouldn't normally get success, but reset if we do
      log.info(`Circuit breaker: open → closed (early recovery)`);
      this.transitionTo("closed");
      this.failures = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  /** Record a connection/call failure. May trip the breaker. */
  recordFailure(): void {
    this.failures++;
    this.consecutiveSuccesses = 0;

    if (this.state === "half-open") {
      // Probe failed — go back to open with a fresh cooldown
      log.warn(`Circuit breaker: half-open → open (probe failed)`);
      this.transitionTo("open");
      this.openedAt = Date.now();
    } else if (this.state === "closed") {
      if (this.failures >= this.config.failureThreshold) {
        log.warn(`Circuit breaker: closed → open (${this.failures}/${this.config.failureThreshold} consecutive failures)`);
        this.transitionTo("open");
        this.openedAt = Date.now();
      } else {
        log.debug(`Circuit breaker: failure recorded (${this.failures}/${this.config.failureThreshold})`);
      }
    }
  }

  /** Force reset to closed state (admin override). */
  forceReset(): void {
    log.info(`Circuit breaker: force reset to closed`);
    this.transitionTo("closed");
    this.failures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = 0;
  }

  /**
   * Check if a connection attempt is allowed.
   * Returns true if allowed, false if the circuit is open.
   */
  allowConnection(): boolean {
    if (this.state === "closed") return true;

    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.config.cooldownMs) {
        this.transitionTo("half-open");
        this.consecutiveSuccesses = 0;
        return true; // Allow probe
      }
      return false; // Still in cooldown
    }

    // half-open: allow probes (the success/failure tracking handles convergence)
    return true;
  }

  /** Get current state for health/API endpoints. */
  getStatus(): CircuitBreakerStatus {
    const result: CircuitBreakerStatus = {
      state: this.state,
      failures: this.failures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      lastStateChange: this.lastStateChange,
      totalTransitions: this.totalTransitions,
    };
    if (this.state === "open") {
      result.cooldown_remaining_ms = Math.max(0, this.config.cooldownMs - (Date.now() - this.openedAt));
    }
    return result;
  }

  /** Get the raw state string */
  getState(): CircuitState {
    return this.state;
  }

  /** Get consecutive failure count */
  getFailures(): number {
    return this.failures;
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    if (oldState === newState) return;

    this.state = newState;
    this.lastStateChange = Date.now();
    this.totalTransitions++;

    log.info(`Circuit breaker: ${oldState} → ${newState}`);

    for (const listener of this.listeners) {
      try {
        listener(oldState, newState);
      } catch (err) {
        log.error(`Circuit breaker listener error: ${err}`);
      }
    }
  }
}

/**
 * Registry of per-agent circuit breakers.
 * Each GameClient gets its own breaker so one agent's SOCKS failure
 * doesn't block all agents.
 */
export class BreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  /** Get or create a breaker for the given label. */
  getOrCreate(label: string, config?: Partial<CircuitBreakerConfig>): CircuitBreaker {
    let breaker = this.breakers.get(label);
    if (!breaker) {
      breaker = new CircuitBreaker(config);
      this.breakers.set(label, breaker);
    }
    return breaker;
  }

  /** Register an externally-created breaker. */
  register(label: string, breaker: CircuitBreaker): void {
    this.breakers.set(label, breaker);
  }

  /** Remove a breaker (agent disconnected). */
  remove(label: string): void {
    this.breakers.delete(label);
  }

  /** Get all registered breakers. */
  getAll(): Map<string, CircuitBreaker> {
    return this.breakers;
  }

  /**
   * Aggregate status across all breakers for backwards compat.
   * Returns worst-case: any open → open, any half-open → half-open, else closed.
   */
  getAggregateStatus(): CircuitBreakerStatus {
    let worstState: CircuitState = "closed";
    let totalFailures = 0;
    let totalSuccesses = 0;
    let latestStateChange = 0;
    let totalTransitions = 0;
    let maxCooldown: number | undefined;

    for (const breaker of this.breakers.values()) {
      const s = breaker.getStatus();
      totalFailures += s.failures;
      totalSuccesses += s.consecutiveSuccesses;
      totalTransitions += s.totalTransitions;
      if (s.lastStateChange > latestStateChange) latestStateChange = s.lastStateChange;

      if (s.state === "open") {
        worstState = "open";
        if (s.cooldown_remaining_ms !== undefined) {
          maxCooldown = Math.max(maxCooldown ?? 0, s.cooldown_remaining_ms);
        }
      } else if (s.state === "half-open" && worstState !== "open") {
        worstState = "half-open";
      }
    }

    const result: CircuitBreakerStatus = {
      state: worstState,
      failures: totalFailures,
      consecutiveSuccesses: totalSuccesses,
      lastStateChange: latestStateChange || Date.now(),
      totalTransitions,
    };
    if (maxCooldown !== undefined) {
      result.cooldown_remaining_ms = maxCooldown;
    }
    return result;
  }

  /** Per-agent status breakdown for health endpoint. */
  getPerAgentStatus(): Record<string, CircuitBreakerStatus> {
    const result: Record<string, CircuitBreakerStatus> = {};
    for (const [label, breaker] of this.breakers) {
      result[label] = breaker.getStatus();
    }
    return result;
  }
}

