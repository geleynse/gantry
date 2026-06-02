import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { StandingsPanel } from '../standings-panel';
import type { Standings } from '@/hooks/use-game-state';

mock.module('@/lib/utils', () => ({
  cn: (...classes: (string | undefined | false | null)[]) => classes.filter(Boolean).join(' '),
}));

describe('StandingsPanel', () => {
  it('shows "—" when standings is undefined', () => {
    render(<StandingsPanel standings={undefined} />);
    expect(screen.getByText('Standings')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
  });

  it('shows "—" when standings is null', () => {
    render(<StandingsPanel standings={null} />);
    expect(screen.getByText('—')).toBeDefined();
  });

  it('shows "—" when all empires have zero reputation and no bounty', () => {
    const standings: Standings = {
      solarian: { reputation: 0, baseline: 0, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText('—')).toBeDefined();
  });

  it('shows "—" when standings is empty object', () => {
    render(<StandingsPanel standings={{}} />);
    expect(screen.getByText('—')).toBeDefined();
  });

  it('renders empire name and reputation for non-zero standing', () => {
    const standings: Standings = {
      solarian: { reputation: 20, baseline: 20, bounty: 0 },
      pirates: { reputation: -30, baseline: -30, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/solarian/)).toBeDefined();
    expect(screen.getByText(/pirates/)).toBeDefined();
  });

  it('displays reputation value', () => {
    const standings: Standings = {
      solarian: { reputation: 20, baseline: 20, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    // Should render "rep 20"
    expect(screen.getByText(/rep\s*20/i)).toBeDefined();
  });

  it('does not render bounty when bounty is 0', () => {
    const standings: Standings = {
      solarian: { reputation: 20, baseline: 20, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    const bountyEls = screen.queryAllByText(/bounty/i);
    expect(bountyEls.length).toBe(0);
  });

  it('renders bounty when bounty is non-zero', () => {
    const standings: Standings = {
      crimson: { reputation: -25, baseline: -20, bounty: 5000 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/bounty/i)).toBeDefined();
    expect(screen.getByText(/5,000cr/)).toBeDefined();
  });

  it('hides empire with zero reputation and zero bounty', () => {
    const standings: Standings = {
      voidborn: { reputation: 0, baseline: 0, bounty: 0 },
      crimson: { reputation: -18, baseline: -20, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    // voidborn is all-zero so it shouldn't appear
    const voidbornEls = screen.queryAllByText(/voidborn/i);
    expect(voidbornEls.length).toBe(0);
    // crimson should appear
    expect(screen.getByText(/crimson/)).toBeDefined();
  });

  it('shows empire when bounty > 0 even if reputation is 0', () => {
    const standings: Standings = {
      outerrim: { reputation: 0, baseline: 0, bounty: 1000 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/outerrim/)).toBeDefined();
    expect(screen.getByText(/bounty/i)).toBeDefined();
  });

  it('renders pirates row', () => {
    const standings: Standings = {
      pirates: { reputation: -30, baseline: -30, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/pirates/i)).toBeDefined();
  });

  it('renders full live-data example without crashing', () => {
    // Shape captured from live server log (2026-06-01)
    const standings: Standings = {
      solarian: { reputation: 20, baseline: 20, bounty: 0 },
      voidborn: { reputation: 10, baseline: 10, bounty: 0 },
      crimson: { reputation: 10, baseline: 10, bounty: 0 },
      nebula: { reputation: 10, baseline: 10, bounty: 0 },
      outerrim: { reputation: 10, baseline: 10, bounty: 0 },
      pirates: { reputation: -30, baseline: -30, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    // solarian (rep 20) and pirates (rep -30) show; others are rep=10 (non-zero)
    expect(screen.getByText(/solarian/)).toBeDefined();
    expect(screen.getByText(/pirates/)).toBeDefined();
  });
});
