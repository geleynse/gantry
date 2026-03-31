/**
 * MarketReservationCache — Prevents fleet agents from racing for the same market inventory.
 *
 * When an agent calls analyze_market/buy/sell, reservations are created or consumed.
 * Other agents see adjusted quantities in market responses, with hints about who reserved what.
 * Reservations auto-expire after a configurable TTL (default 10 minutes).
 *
 * Advisory only — agents are never blocked from buying if a reservation fails.
 */

import { createLogger } from "../lib/logger.js";

const log = createLogger("market-reservations");

export interface Reservation {
  agent: string;
  station: string;
  itemId: string;
  quantity: number;
  createdAt: number;
  expiresAt: number;
}

export interface MarketReservationDeps {
  /** TTL for reservations in milliseconds (default 10 minutes). */
  ttlMs?: number;
  /** Interval for pruning expired reservations in milliseconds (default 60s). */
  pruneIntervalMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 1000; // 60 seconds

export class MarketReservationCache {
  /** Key: `${station}::${itemId}::${agent}` */
  private reservations = new Map<string, Reservation>();
  private readonly ttlMs: number;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: MarketReservationDeps = {}) {
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
    const pruneIntervalMs = deps.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.pruneTimer = setInterval(() => this.pruneExpired(), pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  private key(agent: string, station: string, itemId: string): string {
    return `${station}::${itemId}::${agent}`;
  }

  /**
   * Create or update a reservation. If the same agent already has a reservation
   * for this station+item, the quantity and expiry are updated (not duplicated).
   * Returns true if the reservation was created/updated.
   */
  reserve(agent: string, station: string, itemId: string, quantity: number): boolean {
    if (quantity <= 0) return false;

    const k = this.key(agent, station, itemId);
    const now = Date.now();
    const existing = this.reservations.get(k);

    if (existing) {
      // Update existing reservation
      existing.quantity = quantity;
      existing.expiresAt = now + this.ttlMs;
      log.debug("reservation updated", { agent, station, itemId, quantity });
    } else {
      this.reservations.set(k, {
        agent,
        station,
        itemId,
        quantity,
        createdAt: now,
        expiresAt: now + this.ttlMs,
      });
      log.debug("reservation created", { agent, station, itemId, quantity });
    }
    return true;
  }

  /**
   * Release a specific reservation for an agent at a station+item.
   */
  release(agent: string, station: string, itemId: string): void {
    const k = this.key(agent, station, itemId);
    if (this.reservations.delete(k)) {
      log.debug("reservation released", { agent, station, itemId });
    }
  }

  /**
   * Release all reservations for a given agent (e.g., on logout or error).
   */
  releaseAll(agent: string): void {
    const count = this.deleteMatching(r => r.agent === agent);
    if (count > 0) {
      log.info("released all reservations", { agent, count });
    }
  }

  /**
   * Release all reservations for a given agent at a specific station.
   * Used when an agent travels away from a station.
   */
  releaseStation(agent: string, station: string): void {
    const count = this.deleteMatching(r => r.agent === agent && r.station === station);
    if (count > 0) {
      log.debug("released station reservations", { agent, station, count });
    }
  }

  /** Delete all reservations matching predicate, return count deleted. */
  private deleteMatching(predicate: (r: Reservation) => boolean): number {
    let count = 0;
    for (const [k, r] of this.reservations) {
      if (predicate(r)) {
        this.reservations.delete(k);
        count++;
      }
    }
    return count;
  }

  /**
   * Get all active (non-expired) reservations for a station.
   */
  getReservations(station: string): Reservation[] {
    return this.activeReservations(r => r.station === station);
  }

  /**
   * Get all active (non-expired) reservations across all stations.
   */
  getAllReservations(): Reservation[] {
    return this.activeReservations();
  }

  /**
   * Calculate available quantity for an item at a station, subtracting
   * reservations from other agents. The requesting agent's own reservations
   * are not subtracted (they already "own" that inventory).
   */
  getAvailable(station: string, itemId: string, totalQuantity: number, requestingAgent?: string): number {
    const reserved = this.activeReservations(
      r => r.station === station && r.itemId === itemId && r.agent !== requestingAgent,
    ).reduce((sum, r) => sum + r.quantity, 0);
    return Math.max(0, totalQuantity - reserved);
  }

  /**
   * Get reservation details for other agents at a station+item.
   * Returns a summary string like "(30 reserved by cinder-wake)".
   */
  getReservationHint(station: string, itemId: string, requestingAgent: string): string | null {
    const others = this.activeReservations(
      r => r.station === station && r.itemId === itemId && r.agent !== requestingAgent,
    );
    if (others.length === 0) return null;
    return `(${others.map(o => `${o.quantity} reserved by ${o.agent}`).join(", ")})`;
  }

  /** Return shallow copies of all active (non-expired) reservations matching an optional predicate. */
  private activeReservations(predicate?: (r: Reservation) => boolean): Reservation[] {
    const now = Date.now();
    const result: Reservation[] = [];
    for (const r of this.reservations.values()) {
      if (r.expiresAt > now && (!predicate || predicate(r))) {
        result.push({ ...r });
      }
    }
    return result;
  }

  /**
   * Remove all expired reservations.
   */
  pruneExpired(): number {
    const now = Date.now();
    const pruned = this.deleteMatching(r => r.expiresAt <= now);
    if (pruned > 0) {
      log.debug("pruned expired reservations", { count: pruned });
    }
    return pruned;
  }

  /**
   * Stop the periodic prune timer (for graceful shutdown).
   */
  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  /**
   * Total number of active (non-expired) reservations.
   */
  get size(): number {
    return this.activeReservations().length;
  }
}
