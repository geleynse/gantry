import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as logParser from './log-parser.js';
import * as usageParser from './usage-parser.js';
import { getAnalytics } from './analytics-service.js';
import { setConfigForTesting } from '../config.js';
import type { GantryConfig } from '../config/types.js';

describe('analytics-service', () => {
  let readFullLogSpy: any;
  let getUsageSummarySpy: any;

  beforeEach(() => {
    // Register test agent so getAnalytics doesn't early-return with zeros
    setConfigForTesting({
      agents: [
        { name: 'drifter-gale', backend: 'claude', model: 'haiku' },
      ],
      gameUrl: 'http://localhost/mcp',
      gameApiUrl: 'http://localhost/api/v1',
      agentDeniedTools: {},
      callLimits: {},
      turnSleepMs: 90,
      staggerDelay: 20,
    } as GantryConfig);
    readFullLogSpy = spyOn(logParser, 'readFullLog').mockResolvedValue('');
    getUsageSummarySpy = spyOn(usageParser, 'getAgentUsageSummary').mockResolvedValue({ turnCount: 0 });
  });

  afterEach(() => {
    readFullLogSpy.mockRestore();
    getUsageSummarySpy.mockRestore();
  });

  it('returns zeros for unknown agent', async () => {
    const result = await getAnalytics('unknown-agent');
    expect(result.totalTurns).toBe(0);
    expect(result.quotaHits).toBe(0);
    expect(result.successRate).toBe(0);
  });

  it('returns zeros for empty log', async () => {
    readFullLogSpy.mockResolvedValue('');

    const result = await getAnalytics('drifter-gale');
    expect(result.totalTurns).toBe(0);
    expect(result.quotaHits).toBe(0);
    expect(result.successRate).toBe(0);
  });

  it('counts total turns correctly', async () => {
    const logContent = `[2026-02-14T10:00:00.000Z] [turn 1] Starting turn
output
[2026-02-14T10:01:30.000Z] [turn 2] Starting turn
output
[2026-02-14T10:03:00.000Z] [turn 3] Starting turn
output
[2026-02-14T10:04:30.000Z] [turn 4] Starting turn
output
[2026-02-14T10:06:00.000Z] [turn 5] Starting turn
output
[2026-02-14T10:07:30.000Z] [turn 6] Starting turn
output
[2026-02-14T10:09:00.000Z] [turn 7] Starting turn
output
[2026-02-14T10:10:30.000Z] [turn 8] Starting turn
output
[2026-02-14T10:12:00.000Z] [turn 9] Starting turn
output
[2026-02-14T10:13:30.000Z] [turn 10] Starting turn`;
    readFullLogSpy.mockResolvedValue(logContent);

    const result = await getAnalytics('drifter-gale');
    expect(result.totalTurns).toBe(10);
  });

  it('counts quota hits correctly', async () => {
    const logContent = `[2026-02-14T10:00:00.000Z] [turn 1] Starting turn
rate limit error
[2026-02-14T10:01:30.000Z] [turn 2] Starting turn
CLI rate limit hit
[2026-02-14T10:03:00.000Z] [turn 3] Starting turn
Server overload detected
[2026-02-14T10:04:30.000Z] [turn 4] Starting turn
backing off`;
    readFullLogSpy.mockResolvedValue(logContent);

    const result = await getAnalytics('drifter-gale');
    expect(result.quotaHits).toBe(4);
  });

  it('calculates success rate correctly', async () => {
    const logContent = `[2026-02-14T10:00:00.000Z] [turn 1] Starting turn
normal output
[2026-02-14T10:01:30.000Z] [turn 2] Starting turn
rate limit error
[2026-02-14T10:03:00.000Z] [turn 3] Starting turn
normal output
[2026-02-14T10:04:30.000Z] [turn 4] Starting turn
normal output
[2026-02-14T10:06:00.000Z] [turn 5] Starting turn`;
    readFullLogSpy.mockResolvedValue(logContent);

    const result = await getAnalytics('drifter-gale');
    expect(result.totalTurns).toBe(5);
    expect(result.quotaHits).toBe(1);
    expect(result.successRate).toBe(80); // (5-1)/5 * 100 = 80%
  });

  it('formats uptime correctly', async () => {
    const start = new Date('2026-02-14T10:00:00.000Z');
    const end = new Date(start.getTime() + 7200 * 1000); // 2 hours later
    const logContent = `[${start.toISOString()}] [turn 1] Starting turn
output
[${end.toISOString()}] [turn 2] Starting turn`;
    readFullLogSpy.mockResolvedValue(logContent);

    const result = await getAnalytics('drifter-gale');
    expect(result.uptimeFormatted).toBe('2h 0m');
  });

  it('calculates turnsPerHour correctly', async () => {
    const start = new Date('2026-02-14T10:00:00.000Z');
    const end = new Date(start.getTime() + 3600 * 1000); // 1 hour later
    let logContent = `[${start.toISOString()}] [turn 1] Starting turn\n`;

    // Add 9 more turns over the hour
    for (let i = 2; i <= 10; i++) {
      const time = new Date(start.getTime() + ((i - 1) * 400 * 1000));
      logContent += `[${time.toISOString()}] [turn ${i}] Starting turn\n`;
    }
    logContent += `[${end.toISOString()}] [turn 11] Starting turn`;

    readFullLogSpy.mockResolvedValue(logContent);

    const result = await getAnalytics('drifter-gale');
    expect(result.turnsPerHour).toBeGreaterThan(0);
  });

  it('does not calculate uptime/turnsPerHour with only 1 turn', async () => {
    const logContent = `[2026-02-14T10:00:00.000Z] [turn 1] Starting turn`;
    readFullLogSpy.mockResolvedValue(logContent);

    const result = await getAnalytics('drifter-gale');
    expect(result.uptimeFormatted).toBeUndefined();
    expect(result.turnsPerHour).toBeUndefined();
  });

  it('includes usage cost in analytics', async () => {
    const logContent = `[2026-02-15T10:00:00.000Z] Agent drifter-gale starting [claude/haiku]
output
[2026-02-15T10:02:00.000Z] [turn 1] Starting turn`;
    readFullLogSpy.mockResolvedValue(logContent);
    getUsageSummarySpy.mockResolvedValue({
      turnCount: 2,
      totalCost: 0.05,
      avgCostPerTurn: 0.025,
      totalInputTokens: 100,
      totalOutputTokens: 200,
    });

    const result = await getAnalytics('drifter-gale');
    expect(result.totalCost).toBe(0.05);
    expect(result.avgCostPerTurn).toBe(0.025);
  });
});
