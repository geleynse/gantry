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

  it('shows "—" when all empires have zero values', () => {
    const standings: Standings = {
      Solara: { Fame: 0, Criminal: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText('—')).toBeDefined();
  });

  it('renders empire names and non-zero dims', () => {
    const standings: Standings = {
      Solara: { Fame: 75, Criminal: 20 },
      Nexus: { Criminal: 80, Love: 10 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/Solara/)).toBeDefined();
    expect(screen.getByText(/Nexus/)).toBeDefined();
    // Fame 75 should appear
    expect(screen.getByText(/Fame\s*75/)).toBeDefined();
    // Criminal 80 should appear for Nexus
    expect(screen.getByText(/Criminal\s*80/)).toBeDefined();
  });

  it('skips zero-value dimensions', () => {
    const standings: Standings = {
      Solara: { Fame: 60, Criminal: 0, Love: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    // Fame shows but Criminal/Love are zero so they shouldn't appear
    expect(screen.getByText(/Fame\s*60/)).toBeDefined();
    const criminalEls = screen.queryAllByText(/Criminal\s*0/);
    expect(criminalEls.length).toBe(0);
  });

  it('uses "Enc" abbreviation for CriminalEncounters', () => {
    const standings: Standings = {
      Solara: { CriminalEncounters: 30 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/Enc\s*30/)).toBeDefined();
  });

  it('renders pirates row', () => {
    const standings: Standings = {
      pirates: { Criminal: 99 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/pirates/i)).toBeDefined();
  });
});
