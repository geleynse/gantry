import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fsPromises from 'node:fs/promises';
import { parseAgentLog, readFullLog, formatAge } from './log-parser.js';

describe('log-parser', () => {
  let readFileSpy: any;

  beforeEach(() => {
    readFileSpy = spyOn(fsPromises, 'readFile').mockImplementation((() => Promise.resolve('')) as unknown as typeof fsPromises.readFile);
  });

  afterEach(() => {
    readFileSpy.mockRestore();
  });

  describe('parseAgentLog', () => {
    it('counts turn lines correctly', async () => {
      const logContent = `[2026-02-14 10:00:00] Starting [turn 1]
some output
[2026-02-14 10:01:30] Starting [turn 2]
more output
[2026-02-14 10:03:00] Starting [turn 3]`;
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.turnCount).toBe(3);
    });

    it('extracts lastTurnTime correctly', async () => {
      const logContent = `[2026-02-14 10:00:00] Starting [turn 1]
some output
[2026-02-14 10:05:30] Starting [turn 2]`;
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.lastTurnTime).toBe('2026-02-14 10:05:30');
    });

    it('counts quota hits in last 50 lines — runner-generated lines only', async () => {
      const lines = Array(100).fill('normal output');
      lines[60] = '[turn 5] Error detected (rate_limit), backing off 300s';
      lines[70] = "You've hit your limit · resets 9pm (UTC)";
      lines[80] = 'Server overload detected';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.quotaHits).toBe(3);
    });

    it('ignores agent narrative that mentions "rate limit"', async () => {
      // Agents (esp. overseer) sometimes narrate fleet-control events using the
      // words "rate limit". That must NOT inflate the quota counter.
      const lines = Array(100).fill('normal output');
      lines[60] = 'Rust-vane hit lifecycle rate limit on restart';
      lines[70] = 'Rate limited. Will start next turn.';
      lines[80] = 'Checking rate limit status.';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.quotaHits).toBe(0);
    });

    it('detects backed-off state when last 5 lines contain backing off', async () => {
      const lines = Array(10).fill('normal output');
      lines[5] = 'backing off';
      lines[6] = 'backing off';
      lines[7] = 'backing off';
      lines[8] = 'backing off';
      lines[9] = 'backing off';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.state).toBe('backed-off');
    });

    it('detects stale state when lastTurnAgeSeconds > 1800', async () => {
      const oldTime = new Date(Date.now() - 2000 * 1000).toISOString();
      const logContent = `[${oldTime}] Starting [turn 1]
output`;
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.state).toBe('stale');
    });

    it('returns running state for normal log', async () => {
      const recentTime = new Date(Date.now() - 100 * 1000).toISOString();
      const logContent = `[${recentTime}] Starting [turn 1]
output`;
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.state).toBe('running');
    });

    it('returns null for missing log', async () => {
      readFileSpy.mockRejectedValue(new Error('ENOENT'));

      const result = await parseAgentLog('test-agent');
      expect(result).toBeNull();
    });

    it('filters game output correctly', async () => {
      const logContent = `[2026-02-14 10:00:00] Starting [turn 1]
metadata line
---

Game output line 1
[metadata with brackets]
Game output line 2
Game output line 3
Game output line 4`;
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.lastGameOutput).toEqual([
        'Game output line 2',
        'Game output line 3',
        'Game output line 4',
      ]);
    });

    it('counts auth hits in last 50 lines — runner-generated lines only', async () => {
      const lines = Array(100).fill('normal output');
      lines[60] = '[turn 3] Error detected (auth), backing off 300s';
      lines[75] = "You're not logged in to Claude Code";
      lines[85] = 'invalid API key provided';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.authHits).toBe(3);
    });

    it('auth hits don\'t count as quota hits and vice versa', async () => {
      const lines = Array(100).fill('normal output');
      lines[70] = '[turn 3] Error detected (auth), backing off 300s';
      lines[80] = 'invalid API key';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.quotaHits).toBe(0);
      expect(result?.authHits).toBe(2);
    });

    it('returns authHits: 0 for normal log', async () => {
      const recentTime = new Date(Date.now() - 100 * 1000).toISOString();
      const logContent = `[${recentTime}] Starting [turn 1]
normal game output
mining complete
travel to next system`;
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.authHits).toBe(0);
    });
  });

  describe('readFullLog', () => {
    it('returns full log content', async () => {
      const logContent = 'full log content here';
      readFileSpy.mockResolvedValue(logContent);

      const result = await readFullLog('test-agent');
      expect(result).toBe(logContent);
    });

    it('returns empty string on error', async () => {
      readFileSpy.mockRejectedValue(new Error('read error'));

      const result = await readFullLog('test-agent');
      expect(result).toBe('');
    });
  });

  describe('formatAge', () => {
    it('formats hours and minutes for >= 3600 seconds', () => {
      expect(formatAge(3661)).toBe('1h1m');
    });

    it('formats minutes for >= 60 seconds', () => {
      expect(formatAge(125)).toBe('2m');
    });

    it('formats seconds for < 60 seconds', () => {
      expect(formatAge(45)).toBe('45s');
    });

    it('formats hours with zero minutes correctly', () => {
      expect(formatAge(7200)).toBe('2h0m');
    });
  });
});
