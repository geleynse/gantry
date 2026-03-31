import { describe, it, expect } from 'bun:test';

// Helper type for turn cost
interface TurnCost {
  turnNumber: number;
  startedAt: string;
  completedAt: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  iterations: number | null;
  model: string | null;
}

// Helper type for tool call
interface ToolCallRecord {
  id: number;
  agent: string;
  tool_name: string;
  timestamp: string;
  duration_ms: number | null;
  success: number;
}

// formatCostBadge — formats cost + tokens for display
function formatCostBadge(cost: number | null, inputTokens: number | null, outputTokens: number | null): string | null {
  if (cost === null || inputTokens === null || outputTokens === null) return null;
  const totalTokens = inputTokens + outputTokens;
  const tokenDisplay = totalTokens >= 1000 ? `${Math.round(totalTokens / 1000)}k` : String(totalTokens);
  return `$${cost.toFixed(3)} | ${tokenDisplay} tok`;
}

// findTurnForToolCall — finds the turn containing a tool call
function findTurnForToolCall(record: ToolCallRecord, turns: TurnCost[]): TurnCost | null {
  const toolCallTime = new Date(record.timestamp).getTime();
  for (const turn of turns) {
    const turnStart = new Date(turn.startedAt).getTime();
    const turnEnd = turn.completedAt ? new Date(turn.completedAt).getTime() : Infinity;
    if (toolCallTime >= turnStart && toolCallTime <= turnEnd) {
      return turn;
    }
  }
  return null;
}

describe('cost badge helpers', () => {
  it('formats cost badge with thousands-abbreviated tokens', () => {
    const result = formatCostBadge(0.047, 12000, 5000);
    expect(result).toBe('$0.047 | 17k tok');
  });

  it('formats cost badge with single-token counts', () => {
    const result = formatCostBadge(0.005, 100, 50);
    expect(result).toBe('$0.005 | 150 tok');
  });

  it('returns null if cost is missing', () => {
    const result = formatCostBadge(null, 12000, 5000);
    expect(result).toBeNull();
  });

  it('returns null if input tokens is missing', () => {
    const result = formatCostBadge(0.047, null, 5000);
    expect(result).toBeNull();
  });

  it('returns null if output tokens is missing', () => {
    const result = formatCostBadge(0.047, 12000, null);
    expect(result).toBeNull();
  });

  it('finds turn containing tool call timestamp', () => {
    const turns: TurnCost[] = [
      {
        turnNumber: 1,
        startedAt: '2026-03-06T10:00:00Z',
        completedAt: '2026-03-06T10:00:30Z',
        costUsd: 0.047,
        inputTokens: 12000,
        outputTokens: 5000,
        cacheReadTokens: 0,
        iterations: 3,
        model: 'claude-opus',
      },
    ];

    const toolCall: ToolCallRecord = {
      id: 1,
      agent: 'drifter-gale',
      tool_name: 'mine',
      timestamp: '2026-03-06T10:00:15Z', // within turn window
      duration_ms: 5000,
      success: 1,
    };

    const result = findTurnForToolCall(toolCall, turns);
    expect(result?.turnNumber).toBe(1);
  });

  it('does not match tool call outside turn window', () => {
    const turns: TurnCost[] = [
      {
        turnNumber: 1,
        startedAt: '2026-03-06T10:00:00Z',
        completedAt: '2026-03-06T10:00:30Z',
        costUsd: 0.047,
        inputTokens: 12000,
        outputTokens: 5000,
        cacheReadTokens: 0,
        iterations: 3,
        model: 'claude-opus',
      },
    ];

    const toolCall: ToolCallRecord = {
      id: 1,
      agent: 'drifter-gale',
      tool_name: 'mine',
      timestamp: '2026-03-06T10:01:00Z', // after turn ends
      duration_ms: 5000,
      success: 1,
    };

    const result = findTurnForToolCall(toolCall, turns);
    expect(result).toBeNull();
  });

  it('handles uncompleted turns (no completed_at)', () => {
    const turns: TurnCost[] = [
      {
        turnNumber: 1,
        startedAt: '2026-03-06T10:00:00Z',
        completedAt: null,
        costUsd: 0.047,
        inputTokens: 12000,
        outputTokens: 5000,
        cacheReadTokens: 0,
        iterations: 3,
        model: 'claude-opus',
      },
    ];

    const toolCall: ToolCallRecord = {
      id: 1,
      agent: 'drifter-gale',
      tool_name: 'mine',
      timestamp: '2026-03-06T10:05:00Z', // long after start
      duration_ms: 5000,
      success: 1,
    };

    const result = findTurnForToolCall(toolCall, turns);
    expect(result?.turnNumber).toBe(1);
  });
});
