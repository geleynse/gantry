import { describe, it, expect } from 'bun:test';
import type { Request } from 'express';
import { queryString, queryInt } from './query-helpers.js';

function makeReq(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe('queryString', () => {
  it('returns the string value for a valid string param', () => {
    const req = makeReq({ agent: 'drifter-gale' });
    expect(queryString(req, 'agent')).toBe('drifter-gale');
  });

  it('returns undefined for a missing param', () => {
    const req = makeReq({});
    expect(queryString(req, 'agent')).toBeUndefined();
  });

  it('returns undefined for an array param', () => {
    const req = makeReq({ agent: ['a', 'b'] });
    expect(queryString(req, 'agent')).toBeUndefined();
  });

  it('returns undefined for an object param (ParsedQs)', () => {
    const req = makeReq({ agent: { nested: 'value' } });
    expect(queryString(req, 'agent')).toBeUndefined();
  });

  it('returns an empty string for an empty string param', () => {
    const req = makeReq({ agent: '' });
    expect(queryString(req, 'agent')).toBe('');
  });
});

describe('queryInt', () => {
  it('returns a number for a valid numeric string', () => {
    const req = makeReq({ limit: '50' });
    expect(queryInt(req, 'limit')).toBe(50);
  });

  it('returns undefined for a non-numeric string', () => {
    const req = makeReq({ limit: 'abc' });
    expect(queryInt(req, 'limit')).toBeUndefined();
  });

  it('returns undefined for a missing param', () => {
    const req = makeReq({});
    expect(queryInt(req, 'limit')).toBeUndefined();
  });

  it('returns undefined for an array param', () => {
    const req = makeReq({ limit: ['10', '20'] });
    expect(queryInt(req, 'limit')).toBeUndefined();
  });

  it('handles zero correctly', () => {
    const req = makeReq({ offset: '0' });
    expect(queryInt(req, 'offset')).toBe(0);
  });

  it('returns undefined for NaN-producing input like empty string', () => {
    const req = makeReq({ limit: '' });
    expect(queryInt(req, 'limit')).toBeUndefined();
  });
});
