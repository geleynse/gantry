import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
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

    it('counts quota hits in last 50 lines', async () => {
      const lines = Array(100).fill('normal output');
      lines[60] = 'rate limit error';
      lines[70] = 'CLI rate limit hit';
      lines[80] = 'Server overload detected';
      lines[90] = 'backing off';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.quotaHits).toBe(4);
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

    it('counts auth hits in last 50 lines', async () => {
      const lines = Array(100).fill('normal output');
      lines[60] = 'unauthorized access denied';
      lines[75] = 'token expired please re-auth';
      lines[85] = 'Auth error detected in session';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.authHits).toBe(3);
    });

    it('auth hits don\'t count as quota hits', async () => {
      const lines = Array(100).fill('normal output');
      lines[70] = 'unauthorized access';
      lines[80] = 'token expired';
      lines[90] = 'forbidden resource';
      const logContent = lines.join('\n');
      readFileSpy.mockResolvedValue(logContent);

      const result = await parseAgentLog('test-agent');
      expect(result?.quotaHits).toBe(0);
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
