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
      // v0.548.0: pirate reputation is per-stronghold (pirate_voss, pirate_kael, …),
      // not a single "pirates" key. StandingsPanel iterates Object.entries so any
      // key name renders the same way — this is just a fixture refresh.
      pirate_voss: { reputation: -30, baseline: -30, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/solarian/)).toBeDefined();
    expect(screen.getByText(/pirate_voss/)).toBeDefined();
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

  it('renders a pirate stronghold row', () => {
    const standings: Standings = {
      pirate_voss: { reputation: -30, baseline: -30, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    expect(screen.getByText(/pirate_voss/i)).toBeDefined();
  });

  it('renders all nine per-stronghold pirate rows (v0.548.0)', () => {
    const standings: Standings = {
      pirate_voss: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_kael: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_thane: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_mera: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_dross: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_crix: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_sable: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_nyx: { reputation: -30, baseline: -30, bounty: 0 },
      pirate_korr: { reputation: -30, baseline: -30, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    for (const key of Object.keys(standings)) {
      expect(screen.getByText(new RegExp(key))).toBeDefined();
    }
  });

  it('renders full live-data example without crashing', () => {
    // Shape captured from live server log (2026-06-01), refreshed for v0.548.0's
    // per-stronghold pirate standings (pirate_voss replaces the old "pirates" key).
    const standings: Standings = {
      solarian: { reputation: 20, baseline: 20, bounty: 0 },
      voidborn: { reputation: 10, baseline: 10, bounty: 0 },
      crimson: { reputation: 10, baseline: 10, bounty: 0 },
      nebula: { reputation: 10, baseline: 10, bounty: 0 },
      outerrim: { reputation: 10, baseline: 10, bounty: 0 },
      pirate_voss: { reputation: -30, baseline: -30, bounty: 0 },
    };
    render(<StandingsPanel standings={standings} />);
    // solarian (rep 20) and pirate_voss (rep -30) show; others are rep=10 (non-zero)
    expect(screen.getByText(/solarian/)).toBeDefined();
    expect(screen.getByText(/pirate_voss/)).toBeDefined();
  });
});
