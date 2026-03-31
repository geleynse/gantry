import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { EconomyPanel } from '../economy-panel';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock CreditChart to avoid canvas/chart deps in unit tests
mock.module('../credit-chart', () => ({
  CreditChart: () => null,
}));

// Mock @/lib/utils
mock.module('@/lib/utils', () => ({
  cn: (...classes: (string | undefined | false | null)[]) => classes.filter(Boolean).join(' '),
  summarizeArgs: (s: string | null | undefined) => s ?? null,
}));

// Provide a baseline global.fetch mock (tests override per-case)
beforeEach(() => {
  // Default: return empty data for all endpoints
  global.fetch = mock(async (url: string) => {
    if (String(url).includes('/api/tool-calls/missions')) {
      return new Response(JSON.stringify({ missions: [] }), { status: 200 });
    }
    // analytics and tool-calls endpoints for RecentTransactions
    return new Response(JSON.stringify([]), { status: 200 });
  }) as unknown as typeof global.fetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EconomyPanel — ActiveMissions', () => {
  it('renders "No active missions" when missions API returns empty array', async () => {
    render(<EconomyPanel agentName="drifter-gale" />);

    await waitFor(() => {
      expect(screen.getByText('No active missions')).toBeInTheDocument();
    });
  });

  it('renders mission cards when missions API returns data', async () => {
    const missions = [
      { id: 'm1', title: 'Deliver Iron Ore', objectives: [{ type: 'delivery' }], reward: { credits: 500 }, status: 'active' },
      { id: 'm2', title: 'Patrol Sol System', objectives: [{ type: 'combat' }], reward: { credits: 1200 }, status: 'active' },
    ];

    global.fetch = mock(async (url: string) => {
      if (String(url).includes('/api/tool-calls/missions')) {
        return new Response(JSON.stringify({ missions }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(<EconomyPanel agentName="drifter-gale" />);

    await waitFor(() => {
      expect(screen.getByText('Deliver Iron Ore')).toBeInTheDocument();
      expect(screen.getByText('Patrol Sol System')).toBeInTheDocument();
    });
  });
});
