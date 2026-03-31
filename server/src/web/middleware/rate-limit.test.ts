/**
 * Tests for the in-memory rate limiting middleware.
 */
import { describe, it, expect } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { rateLimiter } from './rate-limit.js';

// Minimal mock factory for Express Request
function makeReq(ip: string, path = '/api/test'): Partial<Request> {
  return {
    ip,
    path,
    socket: { remoteAddress: ip } as any,
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
});
