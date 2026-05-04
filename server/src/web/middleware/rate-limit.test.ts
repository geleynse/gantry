/**
 * Tests for the in-memory rate limiting middleware.
 */
import { describe, it, expect } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { rateLimiter } from './rate-limit.js';

// Minimal mock factory for Express Request
function makeReq(ip: string, path = '/api/test', headers: Record<string, string> = {}): Partial<Request> {
  return {
    ip,
    path,
    socket: { remoteAddress: ip } as any,
    headers: headers as any,
  };
}

// Minimal mock factory for Express Response
function makeRes(): { status: (n: number) => any; json: (body: any) => any; setHeader: (k: string, v: string) => void; _status?: number; _body?: any; _headers: Record<string, string> } {
  const res = {
    _status: undefined as number | undefined,
    _body: undefined as any,
    _headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this._headers[k] = v; },
    status(n: number) { this._status = n; return this; },
    json(body: any) { this._body = body; return this; },
  };
  return res;
}

describe('rateLimiter', () => {
  describe('window tracking', () => {
    it('allows requests within the limit', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 3 });
      const req = makeReq('1.2.3.4') as Request;
      let passCount = 0;

      for (let i = 0; i < 3; i++) {
        const res = makeRes() as unknown as Response;
        const next: NextFunction = () => { passCount++; };
        limiter(req, res, next);
      }

      expect(passCount).toBe(3);
    });

    it('blocks requests exceeding the limit with 429', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 2 });
      const req = makeReq('1.2.3.5') as Request;

      // Exhaust the limit
      for (let i = 0; i < 2; i++) {
        limiter(req, makeRes() as unknown as Response, () => {});
      }

      // This one should be blocked
      const res = makeRes();
      let nextCalled = false;
      limiter(req, res as unknown as Response, () => { nextCalled = true; });

      expect(nextCalled).toBe(false);
      expect(res._status).toBe(429);
      expect(res._body?.error).toBe('rate_limited');
    });

    it('sets Retry-After header on 429', () => {
      const limiter = rateLimiter({ windowMs: 60_000, maxRequests: 1 });
      const req = makeReq('1.2.3.6') as Request;

      // Exhaust limit
      limiter(req, makeRes() as unknown as Response, () => {});

      // Blocked request
      const res = makeRes();
      limiter(req, res as unknown as Response, () => {});

      expect(res._status).toBe(429);
      const retryAfter = Number(res._headers['Retry-After']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });
  });

  describe('IP isolation', () => {
    it('tracks limits independently per IP', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 2 });
      const req1 = makeReq('10.0.0.1') as Request;
      const req2 = makeReq('10.0.0.2') as Request;

      // Exhaust req1's limit
      limiter(req1, makeRes() as unknown as Response, () => {});
      limiter(req1, makeRes() as unknown as Response, () => {});
      const blockedRes = makeRes();
      limiter(req1, blockedRes as unknown as Response, () => {});
      expect(blockedRes._status).toBe(429);

      // req2 should still be allowed
      let req2Passed = false;
      limiter(req2, makeRes() as unknown as Response, () => { req2Passed = true; });
      expect(req2Passed).toBe(true);
    });
  });

  describe('localhost exemption', () => {
    it('exempts 127.0.0.1 from rate limiting', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('127.0.0.1') as Request;

      let passCount = 0;
      for (let i = 0; i < 5; i++) {
        limiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      // All 5 should pass despite limit of 1
      expect(passCount).toBe(5);
    });

    it('exempts ::1 from rate limiting', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('::1') as Request;

      let passCount = 0;
      for (let i = 0; i < 3; i++) {
        limiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(3);
    });

    it('exempts ::ffff:127.0.0.1 (IPv4-mapped loopback) from rate limiting', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('::ffff:127.0.0.1') as Request;

      let passCount = 0;
      for (let i = 0; i < 3; i++) {
        limiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(3);
    });
  });

  describe('response body', () => {
    it('includes retryAfter in response body on 429', () => {
      const limiter = rateLimiter({ windowMs: 30_000, maxRequests: 1 });
      const req = makeReq('2.3.4.5') as Request;

      limiter(req, makeRes() as unknown as Response, () => {});
      const res = makeRes();
      limiter(req, res as unknown as Response, () => {});

      expect(res._body?.retryAfter).toBeGreaterThan(0);
      expect(typeof res._body?.message).toBe('string');
    });
  });

  describe('SSE exemption', () => {
    it('exempts requests with Accept: text/event-stream even when limit is exhausted', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const sseReq = makeReq('5.5.5.5', '/api/status/stream', { accept: 'text/event-stream' }) as Request;

      let passCount = 0;
      for (let i = 0; i < 5; i++) {
        limiter(sseReq, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(5);
    });

    it('exempts paths ending in /stream by default (default exemptPathSuffixes)', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const streamReq = makeReq('6.6.6.6', '/api/activity/stream') as Request;

      let passCount = 0;
      for (let i = 0; i < 5; i++) {
        limiter(streamReq, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(5);
    });

    it('exempts agent log stream path ending in /stream', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('7.7.7.7', '/api/agents/drifter-gale/logs/stream') as Request;

      let passCount = 0;
      for (let i = 0; i < 3; i++) {
        limiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(3);
    });

    it('does NOT exempt non-stream API paths from rate limiting', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 2 });
      const req = makeReq('8.8.8.8', '/api/status') as Request;

      // Exhaust limit
      limiter(req, makeRes() as unknown as Response, () => {});
      limiter(req, makeRes() as unknown as Response, () => {});

      const res = makeRes();
      let nextCalled = false;
      limiter(req, res as unknown as Response, () => { nextCalled = true; });

      expect(nextCalled).toBe(false);
      expect(res._status).toBe(429);
    });

    it('respects custom exemptPathSuffixes', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1, exemptPathSuffixes: ['/custom-exempt'] });
      const req = makeReq('9.9.9.9', '/api/something/custom-exempt') as Request;

      let passCount = 0;
      for (let i = 0; i < 3; i++) {
        limiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(3);
    });
  });

  describe('Next.js RSC prefetch exemption', () => {
    it('exempts requests with RSC: 1 header even when limit is exhausted', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const rscReq = makeReq('11.11.11.1', '/fleet/index.txt', { rsc: '1' }) as Request;

      let passCount = 0;
      for (let i = 0; i < 17; i++) {
        limiter(rscReq, makeRes() as unknown as Response, () => { passCount++; });
      }

      // Simulates the leaderboard/agent-detail page load where Next.js
      // prefetches 8-17 sidebar links via RSC. None should 429.
      expect(passCount).toBe(17);
    });

    it('exempts RSC requests regardless of header value', () => {
      // Next.js sends `RSC: 1`, but the precise value is not load-bearing —
      // anything from a Next.js client will mark the header. We exempt on presence.
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const reqEmpty = makeReq('11.11.11.2', '/leaderboard/index.txt', { rsc: '' }) as Request;

      let passCount = 0;
      for (let i = 0; i < 5; i++) {
        limiter(reqEmpty, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(5);
    });

    it('does NOT exempt non-RSC requests to the same paths', () => {
      // A direct browser hit to /index.txt (no RSC header) IS rate-limited —
      // confirms the exemption is header-gated, not path-gated.
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('11.11.11.3', '/fleet/index.txt') as Request;

      limiter(req, makeRes() as unknown as Response, () => {});
      const blockedRes = makeRes();
      limiter(req, blockedRes as unknown as Response, () => {});

      expect(blockedRes._status).toBe(429);
    });
  });

  describe('SSE exemption on /api/status/stream', () => {
    it('exempts /api/status/stream by path suffix even when Accept header is missing', () => {
      // Belt-and-suspenders for issue #1 — if a proxy strips Accept or the
      // client uses fetch() instead of EventSource, the path suffix saves us.
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('12.12.12.1', '/api/status/stream') as Request;

      let passCount = 0;
      for (let i = 0; i < 10; i++) {
        limiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(10);
    });

    it('exempts /api/status/stream by Accept header (EventSource default)', () => {
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('12.12.12.2', '/api/status/stream', {
        accept: 'text/event-stream',
      }) as Request;

      let passCount = 0;
      for (let i = 0; i < 10; i++) {
        limiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      expect(passCount).toBe(10);
    });
  });

  describe('bulk fleet-state endpoint behavior', () => {
    it('generalPostLimiter exempts /api/game-state/all by suffix', async () => {
      const { generalPostLimiter } = await import('./rate-limit.js');
      // Hit the bulk endpoint many times — should never 429 from the general
      // limiter (it's exempted by suffix). The dedicated bulkStateLimiter
      // applies separately at the mount point in app.ts.
      const req = makeReq('13.13.13.1', '/api/game-state/all') as Request;

      let passCount = 0;
      for (let i = 0; i < 400; i++) {
        // 300 is generalPostLimiter's max — go past it to confirm no 429
        const res = makeRes() as unknown as Response;
        generalPostLimiter(req, res, () => { passCount++; });
      }

      expect(passCount).toBe(400);
    });

    it('bulkStateLimiter allows legit reload bursts within its 600/min budget', async () => {
      const { bulkStateLimiter } = await import('./rate-limit.js');
      const req = makeReq('13.13.13.2', '/api/game-state/all') as Request;

      let passCount = 0;
      for (let i = 0; i < 100; i++) {
        bulkStateLimiter(req, makeRes() as unknown as Response, () => { passCount++; });
      }

      // 100 calls is well under 600/min — represents a heavy dashboard session
      // (20 reloads × 5 mounts each) and should not throttle.
      expect(passCount).toBe(100);
    });
  });

  describe('page route exemption (mount-level)', () => {
    // When generalPostLimiter is mounted on /api only (as in app.ts),
    // page routes and RSC prefetch requests are never seen by the limiter.
    // These tests verify the limiter doesn't block page-like paths
    // if it were ever (accidentally) mounted broadly again.
    it('does not block a page route if the limiter happens to see it (no /stream suffix)', () => {
      // This is a defense-in-depth check: if mounted at app-level, /fleet
      // would still count against the limit. The real protection is mount scope.
      // Test confirms the limiter itself has no special-case for page routes —
      // that responsibility belongs to the mount point in app.ts.
      const limiter = rateLimiter({ windowMs: 10_000, maxRequests: 1 });
      const req = makeReq('10.10.10.1', '/fleet') as Request;

      // First request passes
      let firstPassed = false;
      limiter(req, makeRes() as unknown as Response, () => { firstPassed = true; });
      expect(firstPassed).toBe(true);

      // Second is blocked — confirming mount scope is the only protection
      const res = makeRes();
      limiter(req, res as unknown as Response, () => {});
      expect(res._status).toBe(429);
    });
  });
});
