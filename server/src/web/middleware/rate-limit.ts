/**
 * In-memory rate limiting middleware.
 *
 * Uses a Map keyed by client IP with sliding window tracking.
 * Localhost connections (127.0.0.1/::1) are exempt from all rate limits —
 * agent-to-server calls run on the same host and must never be throttled.
 *
 * SSE connections (Accept: text/event-stream, or paths ending in /stream)
 * are also exempt — they are long-lived single connections, not per-request
 * traffic, and rate-limiting them causes reconnect storms.
 *
 * Next.js RSC prefetch requests (RSC: 1 header, fetched via <Link> sidebar
 * prefetch on every page load) are also exempt — a single navigation can
 * trigger 8-17 of these and they would otherwise drown the bucket.
 *
 * The bulk fleet-state endpoint (/api/game-state/all) gets a higher per-IP
 * limit because it is hit on every dashboard reload + agent detail mount,
 * so a normal browsing burst can briefly exceed the general default.
 */
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import { createLogger } from '../../lib/logger.js';
import { isLocalhost } from '../auth/middleware.js';

const log = createLogger("rate-limit");

export interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number;
  /** Maximum number of requests per window per IP */
  maxRequests: number;
  /** Optional name for logging */
  name?: string;
  /**
   * Path suffixes to exempt from rate limiting.
   * Matched against req.path with String.endsWith().
   * Default: ['/stream'] — exempts all SSE stream endpoints.
   */
  exemptPathSuffixes?: string[];
}

interface WindowEntry {
  count: number;
  resetAt: number;
}

/** Per-limiter metrics tracked for the stats endpoint. */
interface LimiterMetrics {
  name: string;
  windowMs: number;
  maxRequests: number;
  store: Map<string, WindowEntry>;
  rejections: number;
}

/** Snapshot of one limiter for the stats endpoint. */
export interface RateLimitLimiterStats {
  name: string;
  windowMs: number;
  maxRequests: number;
  activeIps: number;
  requestsInWindow: number;
  rejections: number;
}

/** All limiter stats returned by getRateLimitStats(). */
export interface RateLimitStats {
  limiters: RateLimitLimiterStats[];
}

/** Registry of all named limiters (populated as they are created). */
const limiterRegistry: LimiterMetrics[] = [];

/**
 * Return a snapshot of current state for all registered rate limiters.
 * Active IPs and requests in window are computed at call time (excludes
 * entries whose window has already expired).
 */
export function getRateLimitStats(): RateLimitStats {
  const now = Date.now();
  const limiters: RateLimitLimiterStats[] = limiterRegistry.map((m) => {
    let activeIps = 0;
    let requestsInWindow = 0;
    for (const entry of m.store.values()) {
      if (now <= entry.resetAt) {
        activeIps++;
        requestsInWindow += entry.count;
      }
    }
    return {
      name: m.name,
      windowMs: m.windowMs,
      maxRequests: m.maxRequests,
      activeIps,
      requestsInWindow,
      rejections: m.rejections,
    };
  });
  return { limiters };
}

/**
 * Create a rate limiter middleware with the given config.
 * Expired entries are cleaned up once per window period to avoid unbounded memory growth.
 */
export function rateLimiter(config: RateLimitConfig): RequestHandler {
  const store = new Map<string, WindowEntry>();
  let lastCleanup = Date.now();

  // Register this limiter so getRateLimitStats() can report on it
  const metrics: LimiterMetrics = {
    name: config.name ?? 'unnamed',
    windowMs: config.windowMs,
    maxRequests: config.maxRequests,
    store,
    rejections: 0,
  };
  limiterRegistry.push(metrics);

  const exemptSuffixes = config.exemptPathSuffixes ?? ['/stream'];

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Localhost is always exempt
    if (isLocalhost(req)) {
      next();
      return;
    }

    // SSE connections are long-lived single connections — never bucket-count them.
    // Exempt by Accept header (EventSource always sends Accept: text/event-stream)
    // and by path suffix (catches direct fetches without the header, e.g. when
    // fetch() is used instead of EventSource and Accept gets normalized).
    const acceptHeader = req.headers['accept'] ?? '';
    if (acceptHeader.includes('text/event-stream')) {
      next();
      return;
    }
    if (exemptSuffixes.some((suffix) => req.path.endsWith(suffix))) {
      next();
      return;
    }

    // Next.js RSC prefetch — every <Link> in the sidebar prefetches RSC data
    // on page load, which can fire 8-17 requests in <100ms and trip the bucket.
    // The Next.js client tags these with `RSC: 1`. Page navigation by humans
    // never sends this header, so exempting it doesn't open an abuse vector.
    if (req.headers['rsc'] !== undefined) {
      next();
      return;
    }

    const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const now = Date.now();

    // Periodic cleanup of expired entries (once per window)
    if (now - lastCleanup > config.windowMs) {
      for (const [key, entry] of store.entries()) {
        if (now > entry.resetAt) store.delete(key);
      }
      lastCleanup = now;
    }

    const existing = store.get(ip);

    if (!existing || now > existing.resetAt) {
      // New window
      store.set(ip, { count: 1, resetAt: now + config.windowMs });
      next();
      return;
    }

    existing.count++;

    if (existing.count > config.maxRequests) {
      const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000);
      log.warn(`Rate limit exceeded`, { ip, path: req.path, limit: config.name ?? 'default' });
      metrics.rejections++;
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'rate_limited',
        message: 'Too many requests, please try again later.',
        retryAfter: retryAfterSec,
      });
      return;
    }

    next();
  };
}

/**
 * Sensitive session endpoints — 10 req/min per IP.
 * Applied to POST /sessions (login attempts) and secret rotation.
 */
export const sessionLimiter: RequestHandler = rateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  name: 'session',
});

/**
 * Agent control endpoints — 30 req/min per IP.
 * Applied to POST /:name/inject, POST /:name/order, POST /:name/shutdown.
 */
export const agentControlLimiter: RequestHandler = rateLimiter({
  windowMs: 60_000,
  maxRequests: 30,
  name: 'agent-control',
});

/**
 * Secret rotation endpoint — 3 req/min per IP.
 */
export const secretRotationLimiter: RequestHandler = rateLimiter({
  windowMs: 60_000,
  maxRequests: 3,
  name: 'secret-rotation',
});

/**
 * General API limiter — 300 req/min per IP.
 * Applied as a generous default to all API routes.
 *
 * Path exemptions:
 *   /stream             — SSE long-poll endpoints (per defaults).
 *   /game-state/all     — bulk fleet-state endpoint; bounded separately by
 *                          bulkStateLimiter to allow legit dashboard bursts
 *                          (every reload + agent-detail mount hits this).
 */
export const generalPostLimiter: RequestHandler = rateLimiter({
  windowMs: 60_000,
  maxRequests: 300,
  name: 'general',
  exemptPathSuffixes: ['/stream', '/game-state/all'],
});

/**
 * Bulk fleet-state endpoint limiter — 600 req/min per IP.
 *
 * `/api/game-state/all` is the per-agent state aggregator hit on every dashboard
 * reload, every agent-detail mount, and on a 5s polling cadence by useGameState.
 * A reload while clicking through agent pages can burst well past the general
 * 300/min default in <60s.
 *
 * Choice: higher limit (rather than full exempt) — it's still a heavy endpoint
 * worth bounding, but the legit burst is real. 600/min = 10/sec sustained,
 * which comfortably covers normal browsing without unbounded traffic.
 */
export const bulkStateLimiter: RequestHandler = rateLimiter({
  windowMs: 60_000,
  maxRequests: 600,
  name: 'bulk-state',
});
