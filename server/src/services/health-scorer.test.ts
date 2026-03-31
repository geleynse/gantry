import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import * as procManager from './process-manager.js';
import * as logParser from './log-parser.js';
import * as config from '../config.js';
import { getHealthScore } from './health-scorer.js';
import { createDatabase, closeDb } from './database.js';

describe('health-scorer', () => {
  let hasSessionSpy: any;
  let parseAgentLogSpy: any;
  let getAgentSpy: any;

  beforeEach(() => {
    createDatabase(':memory:');
    
    // We can't easily spyOn exported constants like AGENTS, but we can spyOn the getAgent function
    getAgentSpy = spyOn(config, 'getAgent').mockImplementation((name: string) => {
      const agents = [
        { name: 'drifter-gale', backend: 'claude', model: 'sonnet' },
        { name: 'rust-vane', backend: 'claude', model: 'sonnet' },
        { name: 'sable-thorn', backend: 'claude', model: 'sonnet' },
        { name: 'lumen-shoal', backend: 'claude', model: 'sonnet' },
        { name: 'cinder-wake', backend: 'claude', model: 'sonnet' },
      ];
      return agents.find(a => a.name === name) as any;
    });

    hasSessionSpy = spyOn(procManager, 'hasSession').mockResolvedValue(false);
    parseAgentLogSpy = spyOn(logParser, 'parseAgentLog').mockResolvedValue(null);
  });

  afterEach(() => {
    closeDb();
    hasSessionSpy.mockRestore();
    parseAgentLogSpy.mockRestore();
    getAgentSpy.mockRestore();
  });

  it('returns score 0 for unknown agent', async () => {
    // getAgent returns undefined for unknown-agent
    getAgentSpy.mockReturnValue(undefined);
    const result = await getHealthScore('unknown-agent', null);
    expect(result.score).toBe(0);
    expect(result.issues).toContain('unknown agent');
  });

  it('returns score 0 with NOT RUNNING issue when agent not running', async () => {
    hasSessionSpy.mockResolvedValue(false);

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(0);
    expect(result.issues).toContain('NOT RUNNING');
  });

  it('returns score 80 with no-log issue when log missing', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue(null);

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(80);
    expect(result.issues).toContain('no-log');
  });

  it('returns score 100 for healthy agent', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue({
      turnCount: 20,
      quotaHits: 0,
      authHits: 0,
      lastTurnAgeSeconds: 100,
      lastTurnTime: '2026-02-14 10:00:00',
      state: 'running',
      lastGameOutput: [],
    });

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(100);
    expect(result.issues).toEqual([]);
  });

  it('penalizes -30 for quotaHits > 5', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue({
      turnCount: 20,
      quotaHits: 6,
      authHits: 0,
      lastTurnAgeSeconds: 100,
      lastTurnTime: '2026-02-14 10:00:00',
      state: 'running',
      lastGameOutput: [],
    });

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(70);
  });

  it('applies multiple penalties for stale and low turns', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue({
      turnCount: 3,
      quotaHits: 0,
      authHits: 0,
      lastTurnAgeSeconds: 2000,
      lastTurnTime: '2026-02-14 10:00:00',
      state: 'stale',
      lastGameOutput: [],
    });

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(40); // 100 - 40 (stale) - 20 (low turns)
    expect(result.issues.some(i => i.startsWith('stale:'))).toBe(true);
    expect(result.issues.some(i => i.startsWith('low-turns:'))).toBe(true);
  });

  it('does not allow score to go below 0', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue({
      turnCount: 2,
      quotaHits: 10,
      authHits: 0,
      lastTurnAgeSeconds: 2000,
      lastTurnTime: '2026-02-14 10:00:00',
      state: 'stale',
      lastGameOutput: [],
    });

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('penalizes -10 for quotaHits > 0 but <= 5', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue({
      turnCount: 20,
      quotaHits: 2,
      authHits: 0,
      lastTurnAgeSeconds: 100,
      lastTurnTime: '2026-02-14 10:00:00',
      state: 'running',
      lastGameOutput: [],
    });

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(90); // 100 - 10
  });

  it('penalizes -50 for authHits > 0', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue({
      turnCount: 20,
      quotaHits: 0,
      authHits: 2,
      lastTurnAgeSeconds: 100,
      lastTurnTime: '2026-02-14 10:00:00',
      state: 'running',
      lastGameOutput: [],
    });

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(50); // 100 - 50
  });

  it('applies auth penalty combined with quota penalty', async () => {
    hasSessionSpy.mockResolvedValue(true);
    parseAgentLogSpy.mockResolvedValue({
      turnCount: 20,
      quotaHits: 6,
      authHits: 1,
      lastTurnAgeSeconds: 100,
      lastTurnTime: '2026-02-14 10:00:00',
      state: 'running',
      lastGameOutput: [],
    });

    const result = await getHealthScore('drifter-gale', null);
    expect(result.score).toBe(20); // 100 - 50 (auth) - 30 (quota)
  });
});
