import { describe, it, expect } from 'bun:test';

// Mirrors the doubled-prefix collapse loop in analytics-charts.tsx (ToolUsageChart):
// historical "mcp__gantry__mcp__gantry__X" rows are merged into the clean name,
// with counts summed and success rate combined as a weighted average.
interface ToolFrequencyEntry {
  toolName: string;
  count: number;
  avgSuccess: number;
}

function collapseDoubledPrefixes(raw: ToolFrequencyEntry[]): ToolFrequencyEntry[] {
  const collapsed = new Map<string, ToolFrequencyEntry>();
  for (const entry of raw) {
    const cleanName = entry.toolName.replace(/^(mcp__gantry__)+/, "mcp__gantry__");
    const existing = collapsed.get(cleanName);
    if (existing) {
      // Weighted average for success rate — capture the old count
      // before mutating so each side is weighted correctly
      const oldCount = existing.count;
      existing.count += entry.count;
      existing.avgSuccess = existing.count > 0
        ? (existing.avgSuccess * oldCount + entry.avgSuccess * entry.count) / existing.count
        : 0;
    } else {
      collapsed.set(cleanName, { ...entry, toolName: cleanName });
    }
  }
  return [...collapsed.values()].sort((a, b) => b.count - a.count);
}

describe('tool usage collapse — doubled mcp__gantry__ prefixes', () => {
  it('merges doubled-prefix rows into the clean name with summed counts', () => {
    const merged = collapseDoubledPrefixes([
      { toolName: 'mcp__gantry__logout', count: 10, avgSuccess: 1.0 },
      { toolName: 'mcp__gantry__mcp__gantry__logout', count: 5, avgSuccess: 0.8 },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].toolName).toBe('mcp__gantry__logout');
    expect(merged[0].count).toBe(15);
  });

  it('computes a correctly weighted success rate (equal counts average evenly)', () => {
    const merged = collapseDoubledPrefixes([
      { toolName: 'mcp__gantry__scan', count: 10, avgSuccess: 1.0 },
      { toolName: 'mcp__gantry__mcp__gantry__scan', count: 10, avgSuccess: 0.0 },
    ]);
    expect(merged[0].count).toBe(20);
    expect(merged[0].avgSuccess).toBeCloseTo(0.5, 10);
  });

  it('weights unequal counts proportionally', () => {
    const merged = collapseDoubledPrefixes([
      { toolName: 'mcp__gantry__mine', count: 30, avgSuccess: 0.9 },
      { toolName: 'mcp__gantry__mcp__gantry__mine', count: 10, avgSuccess: 0.5 },
    ]);
    // (0.9*30 + 0.5*10) / 40 = 0.8
    expect(merged[0].avgSuccess).toBeCloseTo(0.8, 10);
  });

  it('leaves distinct clean names separate', () => {
    const merged = collapseDoubledPrefixes([
      { toolName: 'mcp__gantry__mine', count: 3, avgSuccess: 1.0 },
      { toolName: 'mcp__gantry__scan', count: 2, avgSuccess: 1.0 },
    ]);
    expect(merged).toHaveLength(2);
  });
});
