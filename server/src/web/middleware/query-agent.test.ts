/**
 * Tests for extractQueryAgent / getQueryAgent / requireQueryAgent utilities.
 *
 * Mocks validateAgentName so tests are not coupled to a live fleet config.
 */
import { describe, it, expect, mock } from 'bun:test';
import type { Request, Response } from 'express';

// ── Mock config dependency before importing the module under test ─────────────

const KNOWN_AGENTS = new Set(['drifter-gale', 'sable-thorn', 'rust-vane']);

mock.module('../config.js', () => ({
  validateAgentName: (name: string) => KNOWN_AGENTS.has(name),
}));

import { extractQueryAgent, getQueryAgent, requireQueryAgent } from './query-agent.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(agent?: string | string[] | undefined): Partial<Request> {
  return {
    query: agent !== undefined ? { agent } : {},
  };
}

function makeRes() {
  const res = {
    _status: undefined as number | undefined,
    _body: undefined as unknown,
    status(n: number) { this._status = n; return this; },
    json(body: unknown) { this._body = body; return this; },
  };
  return res;
}

// ── extractQueryAgent ─────────────────────────────────────────────────────────

describe('extractQueryAgent', () => {
  it('returns the agent name when param is a string', () => {
    const req = makeReq('drifter-gale') as Request;
    expect(extractQueryAgent(req)).toBe('drifter-gale');
  });

  it('returns undefined when agent param is absent', () => {
    const req = makeReq() as Request;
    expect(extractQueryAgent(req)).toBeUndefined();
  });

  it('returns the string even for unknown agent names (no config validation)', () => {
    const req = makeReq('ghost-ship') as Request;
    expect(extractQueryAgent(req)).toBe('ghost-ship');
  });

  it('returns undefined when agent is an empty string', () => {
    const req = makeReq('') as Request;
    expect(extractQueryAgent(req)).toBeUndefined();
  });

  it('returns undefined when agent is an array', () => {
    const req = makeReq(['drifter-gale', 'sable-thorn']) as Request;
    expect(extractQueryAgent(req)).toBeUndefined();
  });

  it('returns undefined when agent is an object', () => {
    const req = { query: { agent: { val: 'drifter-gale' } } } as unknown as Request;
    expect(extractQueryAgent(req)).toBeUndefined();
  });
});

// ── getQueryAgent ─────────────────────────────────────────────────────────────

describe('getQueryAgent', () => {
  it('returns the agent name for a known fleet agent', () => {
    const req = makeReq('drifter-gale') as Request;
    expect(getQueryAgent(req)).toBe('drifter-gale');
  });

  it('returns undefined when agent param is absent', () => {
    const req = makeReq() as Request;
    expect(getQueryAgent(req)).toBeUndefined();
  });

  it('returns undefined for an unknown agent name', () => {
    const req = makeReq('unknown-agent') as Request;
    expect(getQueryAgent(req)).toBeUndefined();
  });

  it('returns undefined when agent is an empty string', () => {
    const req = makeReq('') as Request;
    expect(getQueryAgent(req)).toBeUndefined();
  });

  it('returns undefined when agent is an array', () => {
    const req = makeReq(['drifter-gale', 'sable-thorn']) as Request;
    expect(getQueryAgent(req)).toBeUndefined();
  });
});

// ── requireQueryAgent ─────────────────────────────────────────────────────────

describe('requireQueryAgent', () => {
  it('returns the agent name for a known fleet agent', () => {
    const req = makeReq('rust-vane') as Request;
    const res = makeRes() as unknown as Response;
    expect(requireQueryAgent(req, res)).toBe('rust-vane');
    expect((res as any)._status).toBeUndefined();
  });

  it('returns null and sends 400 when agent param is absent', () => {
    const req = makeReq() as Request;
    const res = makeRes() as unknown as Response;
    const result = requireQueryAgent(req, res);
    expect(result).toBeNull();
    expect((res as any)._status).toBe(400);
    expect((res as any)._body).toMatchObject({ error: expect.stringContaining('required') });
  });

  it('returns null and sends 400 for an empty string', () => {
    const req = makeReq('') as Request;
    const res = makeRes() as unknown as Response;
    const result = requireQueryAgent(req, res);
    expect(result).toBeNull();
    expect((res as any)._status).toBe(400);
  });

  it('returns null and sends 400 for an unknown agent', () => {
    const req = makeReq('ghost-ship') as Request;
    const res = makeRes() as unknown as Response;
    const result = requireQueryAgent(req, res);
    expect(result).toBeNull();
    expect((res as any)._status).toBe(400);
    expect((res as any)._body).toMatchObject({ error: expect.stringContaining('ghost-ship') });
  });

  it('returns null and sends 400 when agent is an array', () => {
    const req = makeReq(['drifter-gale', 'sable-thorn']) as Request;
    const res = makeRes() as unknown as Response;
    const result = requireQueryAgent(req, res);
    expect(result).toBeNull();
    expect((res as any)._status).toBe(400);
  });

  it('does not set a status when returning a valid agent', () => {
    const req = makeReq('sable-thorn') as Request;
    const res = makeRes() as unknown as Response;
    requireQueryAgent(req, res);
    expect((res as any)._status).toBeUndefined();
  });
});
