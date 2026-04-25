/**
 * PrayerAdoptionCard — render + helper tests.
 *
 * Covers: formatPct, formatAvg, tone helpers, initial render with data,
 * window toggle, and disabled-agent visual state.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

mock.module('@/lib/utils', () => ({
  cn: (...classes: (string | undefined | false | null)[]) => classes.filter(Boolean).join(' '),
}));

const originalFetch = global.fetch;

function stubFetch(payload: unknown) {
  global.fetch = mock().mockResolvedValue({
    ok: true,
    json: async () => payload,
    text: async () => '',
    status: 200,
    statusText: 'OK',
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  stubFetch({
    hours: 24,
    adoption: [
      {
        agent: 'drifter-gale',
        prayEnabled: true,
        prayerCount: 3,
        turnCount: 10,
        adoptionRatio: 0.3,
        avgStepsExecuted: 4.5,
        successRate: 0.9,
        completedCount: 2,
        errorCount: 1,
        lastPrayerAt: '2026-04-24T10:00:00Z',
      },
      {
        agent: 'sable-thorn',
        prayEnabled: false,
        prayerCount: 0,
        turnCount: 5,
        adoptionRatio: 0,
        avgStepsExecuted: null,
        successRate: null,
        completedCount: 0,
        errorCount: 0,
        lastPrayerAt: null,
      },
    ],
  });
});

afterEach(() => { global.fetch = originalFetch; });

import { PrayerAdoptionCard, __test__ } from '../prayer-adoption-card';
const { formatPct, formatAvg, adoptionTone, successTone } = __test__;

async function renderAndFlush(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
    await new Promise((r) => setTimeout(r, 0));
  });
  return result!;
}

describe('PrayerAdoptionCard helpers', () => {
  it('formatPct formats ratio as percent', () => {
    expect(formatPct(0.3)).toBe('30%');
    expect(formatPct(1)).toBe('100%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(null)).toBe('—');
  });

  it('formatAvg keeps one decimal', () => {
    expect(formatAvg(4.6)).toBe('4.6');
    expect(formatAvg(0)).toBe('0.0');
    expect(formatAvg(null)).toBe('—');
  });

  it('adoptionTone: high is success, low-but-nonzero is warning, zero is muted', () => {
    expect(adoptionTone(0.3)).toContain('success');
    expect(adoptionTone(0.05)).toContain('warning');
    expect(adoptionTone(0)).toContain('muted');
  });

  it('successTone: 90+ green, 60+ warning, lower error, null muted', () => {
    expect(successTone(0.95)).toContain('success');
    expect(successTone(0.7)).toContain('warning');
    expect(successTone(0.3)).toContain('error');
    expect(successTone(null)).toContain('muted');
  });
});

describe('PrayerAdoptionCard render', () => {
  it('renders rows for each agent after load', async () => {
    await renderAndFlush(<PrayerAdoptionCard />);
    await waitFor(() => expect(screen.getByText('drifter-gale')).toBeTruthy());
    expect(screen.getByText('sable-thorn')).toBeTruthy();
    // adoption %
    expect(screen.getByText('30%')).toBeTruthy();
    // disabled marker for sable-thorn
    expect(screen.getByText('disabled')).toBeTruthy();
  });

  it('shows the prayer-enabled count in the header', async () => {
    await renderAndFlush(<PrayerAdoptionCard />);
    await waitFor(() => expect(screen.getByText(/1\/2 agents prayer-enabled/)).toBeTruthy());
  });

  it('switches window when 7d is clicked and re-fetches', async () => {
    await renderAndFlush(<PrayerAdoptionCard />);
    await waitFor(() => expect(screen.getByText('drifter-gale')).toBeTruthy());

    const fetchMock = global.fetch as unknown as ReturnType<typeof mock>;
    const callsBefore = fetchMock.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByText('7d'));
      await new Promise((r) => setTimeout(r, 0));
    });

    const callsAfter = fetchMock.mock.calls.length;
    expect(callsAfter).toBeGreaterThan(callsBefore);
    // The most recent call should be for hours=168
    const lastCallUrl = String(fetchMock.mock.calls[callsAfter - 1]?.[0] ?? '');
    expect(lastCallUrl).toContain('hours=168');
  });
});
