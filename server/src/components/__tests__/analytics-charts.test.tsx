import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { ExpensiveTurnsTable, TokenEfficiencyPanel } from '../analytics-charts';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock recharts to avoid canvas/SVG rendering deps
mock.module('recharts', () => ({
  LineChart: () => null,
  BarChart: () => null,
  Line: () => null,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
  CartesianGrid: () => null,
  ResponsiveContainer: () => null,
}));

// Mock @/lib/utils
mock.module('@/lib/utils', () => ({
  AGENT_COLORS: {
    'drifter-gale': '#a3be8c',
    'sable-thorn': '#81a1c1',
  },
}));

// Provide a baseline global.fetch mock (tests override per-case)
beforeEach(() => {
  global.fetch = mock(async () => {
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof global.fetch;
});

// ---------------------------------------------------------------------------
// Tests: ExpensiveTurnsTable
// ---------------------------------------------------------------------------

describe('ExpensiveTurnsTable', () => {
  it('renders loading state initially', () => {
    render(<ExpensiveTurnsTable hours={24} limit={10} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders "No turn cost data available" when API returns empty array', async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<ExpensiveTurnsTable hours={24} limit={10} />);

    await waitFor(() => {
      expect(screen.getByText('No turn cost data available')).toBeInTheDocument();
    });
  });

  it('renders table with sample turn data', async () => {
    const sampleTurns = [
      {
        id: 1,
        agent: 'drifter-gale',
        turnNumber: 42,
        startedAt: '2026-03-09T15:30:00Z',
        costUsd: 0.85,
        inputTokens: 45000,
        outputTokens: 12000,
        cacheReadTokens: 8000,
        iterations: 12,
        durationMs: 65000,
        model: 'claude-opus-4',
        toolCallCount: 8,
      },
      {
        id: 2,
        agent: 'sable-thorn',
        turnNumber: 31,
        startedAt: '2026-03-09T15:25:00Z',
        costUsd: 0.62,
        inputTokens: 35000,
        outputTokens: 9000,
        cacheReadTokens: 5000,
        iterations: 8,
        durationMs: 48000,
        model: 'claude-opus-4',
        toolCallCount: 6,
      },
    ];

    global.fetch = mock(async () => {
      return new Response(JSON.stringify(sampleTurns), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<ExpensiveTurnsTable hours={24} limit={10} />);

    await waitFor(() => {
      expect(screen.getByText('drifter-gale')).toBeInTheDocument();
      expect(screen.getByText('sable-thorn')).toBeInTheDocument();
      // Table headers should be visible
      expect(screen.getByText('Turn #')).toBeInTheDocument();
      expect(screen.getByText('Cost')).toBeInTheDocument();
      expect(screen.getByText('Iters')).toBeInTheDocument();
    });
  });

  it('handles API error gracefully', async () => {
    global.fetch = mock(async () => {
      return new Response('Server error', { status: 500 });
    }) as unknown as typeof global.fetch;

    render(<ExpensiveTurnsTable hours={24} limit={10} />);

    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: TokenEfficiencyPanel
// ---------------------------------------------------------------------------

describe('TokenEfficiencyPanel', () => {
  it('renders loading state initially', () => {
    render(<TokenEfficiencyPanel hours={24} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders "No efficiency data available" when API returns empty array', async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<TokenEfficiencyPanel hours={24} />);

    await waitFor(() => {
      expect(screen.getByText('No efficiency data available')).toBeInTheDocument();
    });
  });

  it('renders efficiency table with per-agent stats', async () => {
    const efficiencyData = [
      {
        agent: 'drifter-gale',
        totalCost: 24.50,
        avgCostPerTurn: 0.35,
        avgInputTokensPerTurn: 42000,
        avgOutputTokensPerTurn: 11000,
        cacheHitRate: 0.68,
        estimatedCacheSavings: 1.82,
        creditsPerDollar: 450000,
      },
      {
        agent: 'sable-thorn',
        totalCost: 18.75,
        avgCostPerTurn: 0.28,
        avgInputTokensPerTurn: 35000,
        avgOutputTokensPerTurn: 8500,
        cacheHitRate: 0.52,
        estimatedCacheSavings: 1.04,
        creditsPerDollar: 380000,
      },
    ];

    global.fetch = mock(async () => {
      return new Response(JSON.stringify(efficiencyData), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<TokenEfficiencyPanel hours={24} />);

    await waitFor(() => {
      expect(screen.getByText('drifter-gale')).toBeInTheDocument();
      expect(screen.getByText('sable-thorn')).toBeInTheDocument();
      // Table headers should be visible
      expect(screen.getByText('Total Cost')).toBeInTheDocument();
      expect(screen.getByText('Avg/Turn')).toBeInTheDocument();
      expect(screen.getByText('Cache Hit%')).toBeInTheDocument();
    });
  });

  it('handles zero-cost agents (no efficiency data)', async () => {
    const efficiencyData = [
      {
        agent: 'zero-agent',
        totalCost: 0,
        avgCostPerTurn: 0,
        avgInputTokensPerTurn: 0,
        avgOutputTokensPerTurn: 0,
        cacheHitRate: 0,
        estimatedCacheSavings: 0,
        creditsPerDollar: null,
      },
    ];

    global.fetch = mock(async () => {
      return new Response(JSON.stringify(efficiencyData), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<TokenEfficiencyPanel hours={24} />);

    await waitFor(() => {
      expect(screen.getByText('zero-agent')).toBeInTheDocument();
      // Verify the table headers are rendered
      expect(screen.getByText('Cache Hit%')).toBeInTheDocument();
      expect(screen.getByText('Credits/$')).toBeInTheDocument();
    });
  });

  it('handles API error gracefully', async () => {
    global.fetch = mock(async () => {
      return new Response('Server error', { status: 500 });
    }) as unknown as typeof global.fetch;

    render(<TokenEfficiencyPanel hours={24} />);

    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });
});
