/**
 * SurveyMonetizationPanel — render + helper tests.
 *
 * Covers: helpers, agent gating (returns null for non-survey agents),
 * the zero-state message, the populated state, and the misuse marker.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, act, waitFor } from '@testing-library/react';

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
  // Default: empty report
  stubFetch({
    hours: 24,
    agents: [{
      agent: 'drifter-gale',
      prefix: 'INTEL-',
      targetPrice: 1000,
      notesPosted: 0,
      notesPostedSuccessful: 0,
      notesPosted24h: 0,
      sellThroughRate: null,
      totalCreditsEarned: 0,
      lastPostedAt: null,
    }],
    recent: [],
  });
});

afterEach(() => { global.fetch = originalFetch; });

import { SurveyMonetizationPanel, __test__ } from '../survey-monetization-panel';
const { formatPct, adoptionTone, sellThroughTone, SUPPORTED_AGENTS } = __test__;

async function renderAndFlush(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
    await new Promise((r) => setTimeout(r, 0));
  });
  return result!;
}

describe('SurveyMonetizationPanel helpers', () => {
  it('SUPPORTED_AGENTS pins the two scout agents', () => {
    expect(SUPPORTED_AGENTS.has('drifter-gale')).toBe(true);
    expect(SUPPORTED_AGENTS.has('lumen-shoal')).toBe(true);
    expect(SUPPORTED_AGENTS.has('rust-vane')).toBe(false);
    expect(SUPPORTED_AGENTS.has('overseer')).toBe(false);
  });

  it('formatPct formats ratio as percent', () => {
    expect(formatPct(0.5)).toBe('50%');
    expect(formatPct(1)).toBe('100%');
    expect(formatPct(0)).toBe('0%');
    expect(formatPct(null)).toBe('—');
  });

  it('adoptionTone: 0 is error, low-but-nonzero is warning, 5+ is success', () => {
    expect(adoptionTone(0)).toContain('error');
    expect(adoptionTone(2)).toContain('warning');
    expect(adoptionTone(7)).toContain('success');
  });

  it('sellThroughTone: null muted, low error, mid warning, high success', () => {
    expect(sellThroughTone(null)).toContain('muted');
    expect(sellThroughTone(0)).toContain('error');
    expect(sellThroughTone(0.2)).toContain('warning');
    expect(sellThroughTone(0.8)).toContain('success');
  });
});

describe('SurveyMonetizationPanel render', () => {
  it('returns null for non-survey agents (renders nothing)', () => {
    const { container } = render(<SurveyMonetizationPanel agentName="rust-vane" />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the zero-state message for drifter-gale when DB is empty', async () => {
    await renderAndFlush(<SurveyMonetizationPanel agentName="drifter-gale" />);
    await waitFor(() => {
      expect(screen.getByText(/No notes posted in this window/i)).toBeInTheDocument();
    });
    // Headline 24h count shows "0"
    expect(screen.getByText(/Posted 24h/i)).toBeInTheDocument();
  });

  it('shows tag-spec line with prefix + target price', async () => {
    await renderAndFlush(<SurveyMonetizationPanel agentName="drifter-gale" />);
    await waitFor(() => {
      expect(screen.getByText(/Target tag/i)).toBeInTheDocument();
    });
    // The prefix appears as INTEL-* and price as 1000cr
    expect(screen.getByText('INTEL-*')).toBeInTheDocument();
    expect(screen.getByText('1000cr')).toBeInTheDocument();
  });

  it('renders populated state with sell-through and credits earned', async () => {
    stubFetch({
      hours: 24,
      agents: [{
        agent: 'lumen-shoal',
        prefix: 'BELT-REPORT-',
        targetPrice: 500,
        notesPosted: 4,
        notesPostedSuccessful: 4,
        notesPosted24h: 2,
        sellThroughRate: 0.5,
        totalCreditsEarned: 1500,
        lastPostedAt: '2026-05-06T22:00:00Z',
      }],
      recent: [
        {
          id: 1,
          recordedAgent: 'lumen-shoal',
          prefix: 'BELT-REPORT-',
          taggedFor: 'lumen-shoal',
          region: 'VEGA',
          tagDate: '2026-05-06',
          title: 'BELT-REPORT-VEGA-2026-05-06',
          price: 500,
          postedAt: '2026-05-06T22:00:00Z',
          success: true,
          errorCode: null,
          sold: true,
          salePrice: 500,
        },
      ],
    });

    await renderAndFlush(<SurveyMonetizationPanel agentName="lumen-shoal" />);
    await waitFor(() => {
      // sell-through 50%
      expect(screen.getByText('50%')).toBeInTheDocument();
    });
    // credits earned formatted as "1,500cr"
    expect(screen.getByText('1,500cr')).toBeInTheDocument();
    // Recent table title
    expect(screen.getByText('BELT-REPORT-VEGA-2026-05-06')).toBeInTheDocument();
    // Sold cell
    expect(screen.getByText('yes')).toBeInTheDocument();
  });

  it('marks misuse when recordedAgent != taggedFor', async () => {
    stubFetch({
      hours: 24,
      agents: [{
        agent: 'drifter-gale',
        prefix: 'INTEL-',
        targetPrice: 1000,
        notesPosted: 1,
        notesPostedSuccessful: 1,
        notesPosted24h: 1,
        sellThroughRate: null,
        totalCreditsEarned: 0,
        lastPostedAt: '2026-05-06T22:00:00Z',
      }],
      recent: [
        {
          id: 9,
          recordedAgent: 'drifter-gale',
          prefix: 'BELT-REPORT-',
          taggedFor: 'lumen-shoal',
          region: 'VEGA',
          tagDate: '2026-05-06',
          title: 'BELT-REPORT-VEGA-2026-05-06',
          price: 500,
          postedAt: '2026-05-06T22:00:00Z',
          success: true,
          errorCode: null,
          sold: null,
          salePrice: null,
        },
      ],
    });

    await renderAndFlush(<SurveyMonetizationPanel agentName="drifter-gale" />);
    await waitFor(() => {
      expect(screen.getByText('misuse')).toBeInTheDocument();
    });
  });
});
