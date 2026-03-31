import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { FleetStatusSummary } from '../fleet-status-summary';
import { createMockAgentStatus } from '@/test/mocks/agents';

describe('FleetStatusSummary', () => {
  it('shows count for active agents', () => {
    const agents = [
      createMockAgentStatus({ name: 'a', state: 'running', llmRunning: true, proxySessionActive: true }),
      createMockAgentStatus({ name: 'b', state: 'running', llmRunning: true, proxySessionActive: true }),
    ];
    render(<FleetStatusSummary agents={agents} />);
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('shows multiple state groups', () => {
    const agents = [
      createMockAgentStatus({ name: 'a', state: 'running', llmRunning: true, proxySessionActive: true }),
      createMockAgentStatus({ name: 'b', llmRunning: false, proxySessionActive: false, lastActivityAt: null, lastToolCallAt: null }),
      createMockAgentStatus({ name: 'c', state: 'stale' }),
    ];
    render(<FleetStatusSummary agents={agents} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('does not show groups with zero agents', () => {
    const agents = [
      createMockAgentStatus({ name: 'a', state: 'running', llmRunning: true, proxySessionActive: true }),
    ];
    render(<FleetStatusSummary agents={agents} />);
    expect(screen.queryByText('Disconnected')).not.toBeInTheDocument();
    expect(screen.queryByText('Draining')).not.toBeInTheDocument();
  });

  it('shows draining state when agent is draining', () => {
    const agents = [
      createMockAgentStatus({ name: 'a', shutdownState: 'draining' }),
    ];
    render(<FleetStatusSummary agents={agents} />);
    expect(screen.getByText('Draining')).toBeInTheDocument();
  });

  it('renders nothing when agents array is empty', () => {
    const { container } = render(<FleetStatusSummary agents={[]} />);
    expect(container.textContent).toBe('');
  });
});
