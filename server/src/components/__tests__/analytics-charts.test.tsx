import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { AgentComparisonTable, ExpensiveTurnsTable, TokenEfficiencyPanel } from '../analytics-charts';

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

// ---------------------------------------------------------------------------
// Tests: AgentComparisonTable
// ---------------------------------------------------------------------------

describe('AgentComparisonTable', () => {
  it('renders loading state initially', () => {
    global.fetch = mock(async () => {
      // Mock stays in loading until resolved
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<AgentComparisonTable hours={24} />);
    expect(screen.getByText('Loading agent data…')).toBeInTheDocument();
  });

  it('renders "No agent data available" when API returns empty array', async () => {
    global.fetch = mock(async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<AgentComparisonTable hours={24} />);

    await waitFor(() => {
      expect(screen.getByText('No agent data available')).toBeInTheDocument();
    });
  });

  it('renders table with agent comparison data', async () => {
    const sampleData = [
      {
        agent: 'drifter-gale',
        turnCount: 42,
        totalCost: 25.50,
        avgCostPerTurn: 0.608,
        totalIterations: 168,
        avgDurationMs: 15500,
        latestCredits: 450000,
        creditsChange: 125000,
      },
      {
        agent: 'sable-thorn',
        turnCount: 38,
        totalCost: 18.75,
        avgCostPerTurn: 0.494,
        totalIterations: 144,
        avgDurationMs: 12800,
        latestCredits: 380000,
        creditsChange: 95000,
      },
    ];

    global.fetch = mock(async () => {
      return new Response(JSON.stringify(sampleData), { status: 200 });
    }) as unknown as typeof global.fetch;

    const { container } = render(<AgentComparisonTable hours={24} />);

    await waitFor(() => {
      // Verify agents are displayed
      expect(screen.getByText('drifter-gale')).toBeInTheDocument();
      expect(screen.getByText('sable-thorn')).toBeInTheDocument();
      // Verify table headers
      expect(screen.getByText('Agent')).toBeInTheDocument();
      expect(screen.getByText('Turns')).toBeInTheDocument();
      expect(screen.getByText('Cost')).toBeInTheDocument();
      expect(screen.getByText('Avg $')).toBeInTheDocument();
      expect(screen.getByText('Δ Credits')).toBeInTheDocument();
    });

    // Verify Agent column has sticky class
    const agentHeaders = container.querySelectorAll('th.sticky.left-0');
    expect(agentHeaders.length).toBeGreaterThan(0);
  });

  it('agent column remains visible with sticky positioning', async () => {
    const sampleData = [
      {
        agent: 'test-agent',
        turnCount: 10,
        totalCost: 5.0,
        avgCostPerTurn: 0.5,
        totalIterations: 40,
        avgDurationMs: 10000,
        latestCredits: 100000,
        creditsChange: 25000,
      },
    ];

    global.fetch = mock(async () => {
      return new Response(JSON.stringify(sampleData), { status: 200 });
    }) as unknown as typeof global.fetch;

    const { container } = render(<AgentComparisonTable hours={24} />);

    await waitFor(() => {
      expect(screen.getByText('test-agent')).toBeInTheDocument();
    });

    // Check that the Agent th has sticky positioning
    const agentTh = container.querySelector('th.sticky.left-0.bg-nord-1\\/50');
    expect(agentTh).toBeTruthy();
    expect(agentTh?.textContent).toBe('Agent');

    // Check that the Agent td has sticky positioning
    const agentTds = container.querySelectorAll('td.sticky.left-0.bg-nord-1');
    expect(agentTds.length).toBeGreaterThan(0);
  });

  it('handles API error gracefully', async () => {
    global.fetch = mock(async () => {
      return new Response('Server error', { status: 500 });
    }) as unknown as typeof global.fetch;

    render(<AgentComparisonTable hours={24} />);

    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeInTheDocument();
    });
  });
});
