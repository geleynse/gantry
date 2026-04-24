import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { AgentComparisonTable } from '../analytics-charts';

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
