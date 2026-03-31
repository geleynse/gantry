import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import { parseUsageLog, getAgentUsageSummary, estimateCodexCost } from './usage-parser.js';

describe('usage-parser', () => {
  let readFileSpy: any;

  beforeEach(() => {
    // Use spyOn instead of mock.module
    readFileSpy = spyOn(fs, 'readFile').mockImplementation(async () => '');
  });

  afterEach(() => {
    readFileSpy.mockRestore();
  });

  describe('parseUsageLog', () => {
    it('parses claude usage lines', async () => {
      readFileSpy.mockResolvedValue(
        '[2026-02-15T10:00:00+00:00] [turn 1] cost=0.035 input=3 output=74 cache_read=27778 cache_create=0 iters=1 duration=2249ms\n' +
        '[2026-02-15T10:02:00+00:00] [turn 2] cost=0.012 input=5 output=50 cache_read=30000 cache_create=0 iters=2 duration=3100ms\n'
      );

      const entries = await parseUsageLog('drifter-gale');
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        timestamp: '2026-02-15T10:00:00+00:00',
        turn: 1,
        cost: 0.035,
        inputTokens: 3,
        outputTokens: 74,
        cacheReadTokens: 27778,
        cacheCreateTokens: 0,
        iterations: 1,
        durationMs: 2249,
      });
      expect(entries[1].turn).toBe(2);
    });

    it('parses codex usage lines', async () => {
      readFileSpy.mockResolvedValue(
        '[2026-02-15T10:00:00+00:00] [turn 1] tokens=50569\n' +
        '[2026-02-15T10:02:00+00:00] [turn 2] tokens=unknown\n'
      );

      const entries = await parseUsageLog('rust-vane');
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        timestamp: '2026-02-15T10:00:00+00:00',
        turn: 1,
        totalTokens: 50569,
      });
      expect(entries[1]).toEqual({
        timestamp: '2026-02-15T10:02:00+00:00',
        turn: 2,
        totalTokens: null,
      });
    });

    it('returns empty array when no log file', async () => {
      readFileSpy.mockRejectedValue(new Error('ENOENT'));
      const entries = await parseUsageLog('nonexistent');
      expect(entries).toEqual([]);
    });

    it('skips malformed lines gracefully', async () => {
      readFileSpy.mockResolvedValue(
        'garbage line\n' +
        '[2026-02-15T10:00:00+00:00] [turn 1] cost=0.01 input=3 output=74 cache_read=100 cache_create=0 iters=1 duration=1000ms\n' +
        'another bad line\n'
      );

      const entries = await parseUsageLog('drifter-gale');
      expect(entries).toHaveLength(1);
    });
  });

  describe('getAgentUsageSummary', () => {
    it('summarizes claude agent usage', async () => {
      readFileSpy.mockResolvedValue(
        '[2026-02-15T10:00:00+00:00] [turn 1] cost=0.035 input=100 output=200 cache_read=1000 cache_create=500 iters=3 duration=5000ms\n' +
        '[2026-02-15T10:02:00+00:00] [turn 2] cost=0.020 input=80 output=150 cache_read=900 cache_create=0 iters=2 duration=3000ms\n'
      );

      const summary = await getAgentUsageSummary('drifter-gale');
      expect(summary.totalCost).toBeCloseTo(0.055);
      expect(summary.totalInputTokens).toBe(180);
      expect(summary.totalOutputTokens).toBe(350);
      expect(summary.totalCacheReadTokens).toBe(1900);
      expect(summary.totalCacheCreateTokens).toBe(500);
      expect(summary.turnCount).toBe(2);
      expect(summary.avgCostPerTurn).toBeCloseTo(0.0275);
      expect(summary.avgDurationMs).toBe(4000);
      expect(summary.totalIterations).toBe(5);
    });

    it('summarizes codex agent usage with estimated costs', async () => {
      readFileSpy.mockResolvedValue(
        '[2026-02-15T10:00:00+00:00] [turn 1] tokens=50000\n' +
        '[2026-02-15T10:02:00+00:00] [turn 2] tokens=30000\n' +
        '[2026-02-15T10:04:00+00:00] [turn 3] tokens=unknown\n'
      );

      const summary = await getAgentUsageSummary('rust-vane', 'codex-mini');
      expect(summary.totalTokens).toBe(80000);
      expect(summary.turnCount).toBe(3);
      expect(summary.avgTokensPerTurn).toBe(40000);
      expect(summary.totalCost).toBeCloseTo(0.12);
      expect(summary.avgCostPerTurn).toBeCloseTo(0.06);
      expect(summary.costPerHour).toBeDefined();
    });

    it('summarizes mixed codex-then-claude usage (migration scenario)', async () => {
      readFileSpy.mockResolvedValue(
        '[2026-02-10T10:00:00+00:00] [turn 1] tokens=50000\n' +
        '[2026-02-10T10:02:00+00:00] [turn 2] tokens=30000\n' +
        '[2026-02-12T10:00:00+00:00] [turn 3] cost=0.035 input=100 output=200 cache_read=1000 cache_create=500 iters=3 duration=5000ms\n' +
        '[2026-02-12T10:02:00+00:00] [turn 4] cost=0.020 input=80 output=150 cache_read=900 cache_create=0 iters=2 duration=3000ms\n'
      );

      const summary = await getAgentUsageSummary('rust-vane');
      expect(summary.totalCost).toBeCloseTo(0.055);
      expect(summary.avgCostPerTurn).toBeCloseTo(0.0275);
      expect(summary.totalInputTokens).toBe(180);
      expect(summary.totalOutputTokens).toBe(350);
      expect(summary.turnCount).toBe(4);
    });

    it('summarizes codex usage with default pricing when no model given', async () => {
      readFileSpy.mockResolvedValue(
        '[2026-02-15T10:00:00+00:00] [turn 1] tokens=10000\n'
      );

      const summary = await getAgentUsageSummary('rust-vane');
      expect(summary.totalCost).toBeCloseTo(0.07875);
    });

    it('returns empty summary when no log', async () => {
      readFileSpy.mockRejectedValue(new Error('ENOENT'));
      const summary = await getAgentUsageSummary('nonexistent');
      expect(summary.turnCount).toBe(0);
    });
  });

  describe('estimateCodexCost', () => {
    it('uses model-specific pricing', () => {
      expect(estimateCodexCost(10000, 'codex-mini')).toBeCloseTo(0.015);
      expect(estimateCodexCost(10000, 'gpt-4.1-mini')).toBeCloseTo(0.02);
      expect(estimateCodexCost(10000, 'gpt-4.1-nano')).toBeCloseTo(0.005);
      expect(estimateCodexCost(10000, 'gpt-5.3-codex')).toBeCloseTo(0.07875);
      expect(estimateCodexCost(10000, 'gpt-5.4')).toBeCloseTo(0.0875);
    });

    it('falls back to default rate for unknown models', () => {
      expect(estimateCodexCost(10000, 'unknown-model')).toBeCloseTo(0.07875);
      expect(estimateCodexCost(10000)).toBeCloseTo(0.07875);
    });

    it('is case-insensitive', () => {
      expect(estimateCodexCost(10000, 'Codex-Mini')).toBeCloseTo(0.015);
      expect(estimateCodexCost(10000, 'GPT-4.1-MINI')).toBeCloseTo(0.02);
    });

    it('returns 0 for 0 tokens', () => {
      expect(estimateCodexCost(0)).toBe(0);
    });
  });
});
