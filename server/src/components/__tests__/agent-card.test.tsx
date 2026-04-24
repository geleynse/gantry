import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AgentCard } from '../agent-card';
import { createMockAgentStatus } from '@/test/mocks/agents';
import { createMockGameState, createMockShip } from '@/test/mocks/game-state';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = mock();

// Mock @/lib/utils to avoid clsx/tailwind-merge resolution issues in CI
mock.module('@/lib/utils', () => ({
  cn: (...classes: (string | undefined | false | null)[]) => classes.filter(Boolean).join(' '),
  formatCredits: (n: number | null | undefined) => {
    if (n == null) return '---';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M cr`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k cr`;
    return `${n.toLocaleString()} cr`;
  },
  getItemName: (id: string | undefined, displayName?: string | null) => displayName ?? id ?? 'Unknown',
  formatModuleName: (id: string | undefined) => id ?? 'Unknown',
  relativeTime: (ts: number) => `${ts}`,
}));

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

// Stub ShipImage — avoids CDN/image loading complexity
mock.module('../ShipImage', () => ({
  ShipImage: ({ shipClass, alt }: { shipClass: string; alt?: string }) => (
    <img data-testid="ship-image" data-ship-class={shipClass} alt={alt} />
  ),
}));

// Stub HealthMetricsCard — not the focus of these tests
mock.module('../health-metrics-card', () => ({
  HealthMetricsCard: () => <div data-testid="health-metrics-card" />,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockPush.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCard', () => {
  // ---------------------------------------------------------------------------
  // Skeleton state
  // ---------------------------------------------------------------------------

  describe('skeleton state (no agent data)', () => {
    it('renders animate-pulse placeholder when no agent provided', () => {
      const { container } = render(<AgentCard />);
      expect(container.querySelector('.animate-pulse')).toBeTruthy();
    });

    it('renders with a name hint in skeleton state', () => {
      render(<AgentCard name="drifter-gale" />);
      // Skeleton renders but no name text visible
      const { container } = render(<AgentCard name="drifter-gale" />);
      expect(container.querySelector('.animate-pulse')).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // Full render
  // ---------------------------------------------------------------------------

  describe('full render with agent data', () => {
    it('renders agent name', () => {
      render(<AgentCard agent={createMockAgentStatus({ name: 'drifter-gale' })} />);
      expect(screen.getByText('drifter-gale')).toBeInTheDocument();
    });

    it('renders role badge when role is present', () => {
      render(<AgentCard agent={createMockAgentStatus({ role: 'Scout' })} />);
      expect(screen.getByText('Scout')).toBeInTheDocument();
    });

    it('renders model label', () => {
      render(<AgentCard agent={createMockAgentStatus({ model: 'haiku' })} />);
      expect(screen.getByText('haiku')).toBeInTheDocument();
    });

    it('renders health score percentage', () => {
      render(<AgentCard agent={createMockAgentStatus({ healthScore: 85 })} />);
      expect(screen.getByText('85%')).toBeInTheDocument();
    });

    it('renders turn count', () => {
      render(<AgentCard agent={createMockAgentStatus({ turnCount: 42 })} />);
      expect(screen.getByText('42')).toBeInTheDocument();
    });

    it('renders 0 turn count when no turns', () => {
      render(<AgentCard agent={createMockAgentStatus({ turnCount: 0 })} />);
      expect(screen.getByText('0')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Health score color coding
  // ---------------------------------------------------------------------------

  describe('health score color coding', () => {
    it('applies success color for health score > 60', () => {
      render(
        <AgentCard agent={createMockAgentStatus({ healthScore: 80 })} />,
      );
      // Find the health score text (contains %) and verify it has success color
      expect(screen.getByText('80%')).toBeInTheDocument();
      expect(screen.getByText('80%')).toHaveClass('text-success');
    });

    it('applies warning color for health score 30-60', () => {
      render(
        <AgentCard agent={createMockAgentStatus({ healthScore: 45 })} />,
      );
      // Find the health score text and verify it has warning color
      expect(screen.getByText('45%')).toBeInTheDocument();
      expect(screen.getByText('45%')).toHaveClass('text-warning');
    });

    it('applies error color for health score < 30', () => {
      render(
        <AgentCard agent={createMockAgentStatus({ healthScore: 15 })} />,
      );
      // Find the health score text and verify it has error color
      expect(screen.getByText('15%')).toBeInTheDocument();
      expect(screen.getByText('15%')).toHaveClass('text-error');
    });

    it('shows health issues in tooltip when present', () => {
      const issues = ["high error rate", "stale cache"];
      render(
        <AgentCard agent={createMockAgentStatus({ healthScore: 50, healthIssues: issues })} />,
      );
      const healthText = screen.getByText('health');
      const healthScoreDiv = healthText.parentElement?.parentElement;
      expect(healthScoreDiv).toHaveAttribute('title', issues.join('; '));
    });

    it('shows "Healthy" in tooltip when no health issues', () => {
      render(
        <AgentCard agent={createMockAgentStatus({ healthScore: 90, healthIssues: [] })} />,
      );
      const healthText = screen.getByText('health');
      const healthScoreDiv = healthText.parentElement?.parentElement;
      expect(healthScoreDiv).toHaveAttribute('title', 'Healthy');
    });
  });

  // ---------------------------------------------------------------------------
  // Click / keyboard navigation
  // ---------------------------------------------------------------------------

  describe('navigation', () => {
    it('calls router.push with agent detail URL on click', () => {
      render(<AgentCard agent={createMockAgentStatus({ name: 'drifter-gale' })} />);
      const card = screen.getByRole('button', { name: /View agent drifter-gale/i });
      fireEvent.click(card);
      expect(mockPush).toHaveBeenCalledWith('/agent/drifter-gale');
    });

    it('calls router.push on Enter key press', () => {
      render(<AgentCard agent={createMockAgentStatus({ name: 'sable-thorn' })} />);
      const card = screen.getByRole('button', { name: /View agent sable-thorn/i });
      fireEvent.keyDown(card, { key: 'Enter' });
      expect(mockPush).toHaveBeenCalledWith('/agent/sable-thorn');
    });

    it('does not navigate on non-Enter key', () => {
      render(<AgentCard agent={createMockAgentStatus({ name: 'drifter-gale' })} />);
      const card = screen.getByRole('button', { name: /View agent drifter-gale/i });
      fireEvent.keyDown(card, { key: 'Space' });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('has tabIndex=0 for keyboard accessibility', () => {
      render(<AgentCard agent={createMockAgentStatus({ name: 'test-agent' })} />);
      const card = screen.getByRole('button', { name: /View agent test-agent/i });
      expect(card).toHaveAttribute('tabindex', '0');
    });
  });

  // ---------------------------------------------------------------------------
  // Ship data
  // ---------------------------------------------------------------------------

  describe('ship data display', () => {
    it('shows health bars when game state has a ship', () => {
      const gameState = createMockGameState();
      render(
        <AgentCard
          agent={createMockAgentStatus()}
          gameState={gameState}
        />,
      );
      // Should have hull, shield, fuel, cargo labels
      expect(screen.getByText('Hull')).toBeInTheDocument();
      expect(screen.getByText('Shield')).toBeInTheDocument();
      expect(screen.getByText('Fuel')).toBeInTheDocument();
      expect(screen.getByText('Cargo')).toBeInTheDocument();
    });

    it('shows ship name and class', () => {
      const gameState = createMockGameState({
        ship: createMockShip({ name: 'Stormhawk I', class: 'starter_mining' }),
      });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText('Stormhawk I')).toBeInTheDocument();
      expect(screen.getByText(/starter_mining/i)).toBeInTheDocument();
    });

    it('shows ship image when ship data present', () => {
      const gameState = createMockGameState({
        ship: createMockShip({ class: 'starter_mining' }),
      });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      const shipImg = screen.getByTestId('ship-image');
      expect(shipImg).toHaveAttribute('data-ship-class', 'starter_mining');
    });

    it('shows dimmed bars when no ship data', () => {
      render(<AgentCard agent={createMockAgentStatus()} gameState={null} />);
      // Should render bars with opacity-60
      const { container } = render(<AgentCard agent={createMockAgentStatus()} gameState={null} />);
      expect(container.querySelector('.opacity-60')).toBeTruthy();
    });

    it('renders module list when ship has modules', () => {
      const gameState = createMockGameState({
        ship: createMockShip({
          modules: [
            { slot_type: 'weapon', item_id: 'blaster', item_name: 'Blaster Mk I' },
          ],
        }),
      });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText('Blaster Mk I')).toBeInTheDocument();
    });

    it('renders cargo list when ship has cargo', () => {
      const gameState = createMockGameState({
        ship: createMockShip({
          cargo: [
            { item_id: 'iron_ore', name: 'Iron Ore', quantity: 10 },
          ],
        }),
      });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText('Iron Ore')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Location & credits
  // ---------------------------------------------------------------------------

  describe('location and economy', () => {
    it('shows system and POI from game state', () => {
      const gameState = createMockGameState({
        current_system: 'Solaria Prime',
        current_poi: 'Mining Belt Alpha',
      });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText(/Solaria Prime/)).toBeInTheDocument();
      expect(screen.getByText(/Mining Belt Alpha/)).toBeInTheDocument();
    });

    it('shows "location unknown" when no system and no data_age_s', () => {
      const gameState = createMockGameState({ current_system: null });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText('location unknown')).toBeInTheDocument();
    });

    it('shows stale location indicator with age when no system but data_age_s present', () => {
      const gameState = createMockGameState({ current_system: null, data_age_s: 300 });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      // 300s = 5 minutes → shows "5m ago"
      expect(screen.getByText(/location unknown · stale/)).toBeInTheDocument();
      expect(screen.getByText(/5m ago/)).toBeInTheDocument();
    });

    it('shows stale location with hours when data_age_s >= 3600', () => {
      const gameState = createMockGameState({ current_system: null, data_age_s: 7200 });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      // 7200s = 2 hours → shows "2h ago"
      expect(screen.getByText(/location unknown · stale/)).toBeInTheDocument();
      expect(screen.getByText(/2h ago/)).toBeInTheDocument();
    });

    it('shows "[docked]" badge when docked at base', () => {
      const gameState = createMockGameState({ docked_at_base: 'Base Alpha' });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText('[docked]')).toBeInTheDocument();
    });

    it('formats credits with k/M suffix', () => {
      const gameState = createMockGameState({ credits: 12345 });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText(/12\.3k cr/)).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Skills
  // ---------------------------------------------------------------------------

  describe('skills display', () => {
    it('shows skills section when game state has skills', () => {
      const gameState = createMockGameState({
        // Use unique skill name to avoid collision with location POI text
        skills: { combat: { name: 'Combat', level: 5, xp: 400, xp_to_next: 1000 } },
        current_poi: null,
      });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.getByText('combat')).toBeInTheDocument();
      expect(screen.getByText('Lvl 5')).toBeInTheDocument();
    });

    it('does not show skills section when no skills', () => {
      const gameState = createMockGameState({ skills: {} });
      render(<AgentCard agent={createMockAgentStatus()} gameState={gameState} />);
      expect(screen.queryByText('Skills')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Status badge display (replaces status dot + shutdown badges)
  // ---------------------------------------------------------------------------

  describe('status badge display', () => {
    it('shows Active badge when agent is running and connected', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({
            state: 'running',
            llmRunning: true,
            proxySessionActive: true,
            shutdownState: 'none',
          })}
        />,
      );
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('shows Draining badge when shutdownState is draining', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({ shutdownState: 'draining' })}
        />,
      );
      expect(screen.getByText('Draining')).toBeInTheDocument();
    });

    it('shows Shutdown Waiting badge when in shutdown_waiting state', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({ shutdownState: 'shutdown_waiting' })}
        />,
      );
      expect(screen.getByText('Shutdown Waiting')).toBeInTheDocument();
    });

    it('shows In Battle badge when inBattle is true', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({ inBattle: true })}
        />,
      );
      expect(screen.getByText('In Battle')).toBeInTheDocument();
    });

    it('shows Disconnected badge when llmRunning is false', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({
            llmRunning: false,
            proxySessionActive: false,
            lastActivityAt: null,
            lastToolCallAt: null,
          })}
        />,
      );
      expect(within(screen.getByTestId('status-badge')).getByText('Disconnected')).toBeInTheDocument();
    });

    it('shows Degraded badge when state is stale', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({ state: 'stale' })}
        />,
      );
      expect(screen.getByText('Degraded')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // Proxy status text
  // ---------------------------------------------------------------------------

  describe('proxy status text', () => {
    it('shows "In Session" when proxy session is active', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({ proxySessionActive: true })}
        />,
      );
      expect(screen.getByText('(In Session)')).toBeInTheDocument();
    });

    it('shows "Proxy Blocking" when agent is draining', () => {
      render(
        <AgentCard
          agent={createMockAgentStatus({ shutdownState: 'draining' })}
        />,
      );
      expect(screen.getByText('(Proxy Blocking)')).toBeInTheDocument();
    });
  });
});
