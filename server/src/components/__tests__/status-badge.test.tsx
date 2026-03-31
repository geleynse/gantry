import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../status-badge';
import type { AgentDisplayState } from '@/lib/agent-display-state';

describe('StatusBadge', () => {
  it('renders badge with active state', () => {
    render(<StatusBadge state="active" />);
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('renders badge with disconnected state', () => {
    render(<StatusBadge state="disconnected" />);
    expect(screen.getByText('Disconnected')).toBeTruthy();
  });

  it('renders badge with draining state', () => {
    render(<StatusBadge state="draining" />);
    expect(screen.getByText('Draining')).toBeTruthy();
  });

  it('renders all state labels correctly', () => {
    const cases: [AgentDisplayState, string][] = [
      ['active', 'Active'],
      ['disconnected', 'Disconnected'],
      ['draining', 'Draining'],
      ['shutdown-waiting', 'Shutdown Waiting'],
      ['in-battle', 'In Battle'],
      ['offline', 'Reconnecting'],
      ['degraded', 'Degraded'],
      ['stopped', 'Stopped'],
    ];
    for (const [state, label] of cases) {
      const { unmount } = render(<StatusBadge state={state} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });

  it('applies correct color classes', () => {
    const { container } = render(<StatusBadge state="active" />);
    const badge = container.querySelector('[data-testid="status-badge"]');
    expect(badge?.className).toContain('bg-green-500');
  });

  it('applies sm size classes', () => {
    const { container } = render(<StatusBadge state="active" size="sm" />);
    const badge = container.querySelector('[data-testid="status-badge"]');
    expect(badge?.className).toContain('text-[10px]');
  });

  it('renders subLabel when provided', () => {
    render(<StatusBadge state="active" subLabel="In Session" />);
    expect(screen.getByText('(In Session)')).toBeTruthy();
  });

  it('applies lg size classes', () => {
    const { container } = render(<StatusBadge state="active" size="lg" />);
    const badge = container.querySelector('[data-testid="status-badge"]');
    expect(badge?.className).toContain('text-base');
  });

  it('defaults to md size', () => {
    const { container } = render(<StatusBadge state="active" />);
    const badge = container.querySelector('[data-testid="status-badge"]');
    expect(badge?.className).toContain('text-sm');
  });

  it('includes dot indicator', () => {
    const { container } = render(<StatusBadge state="active" />);
    const dot = container.querySelector('[data-testid="status-badge"] span.rounded-full');
    expect(dot).toBeTruthy();
  });
});
