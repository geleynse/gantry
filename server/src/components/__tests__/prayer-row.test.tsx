/**
 * PrayerRow — helper tests + basic render smoke.
 *
 * Focuses on pure helpers (status badge mapping, JSON parse) and a
 * rendering smoke test. Matches the testing pattern in
 * tool-call-feed.test.tsx (pure helpers) and agent-card.test.tsx (render).
 */
import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen } from '@testing-library/react';

// Avoid Next/tailwind surprises from @/lib/utils
mock.module('@/lib/utils', () => ({
  cn: (...classes: (string | undefined | false | null)[]) => classes.filter(Boolean).join(' '),
}));

// Stable fetch mock — PrayerRow fires /tool-calls when expanded; in the
// render smoke test we start collapsed, so no fetch is actually invoked.
const originalFetch = global.fetch;
beforeEach(() => {
  global.fetch = mock().mockResolvedValue({
    ok: true,
    json: async () => ({ tool_calls: [] }),
    text: async () => '',
    status: 200,
    statusText: 'OK',
  }) as unknown as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

import { PrayerRow, __test__, type PrayerToolCallRecord } from '../prayer-row';

const { statusBadgeClasses, parseJson } = __test__;

function makeRecord(overrides: Partial<PrayerToolCallRecord> = {}): PrayerToolCallRecord {
  return {
    id: 1,
    agent: 'drifter-gale',
    tool_name: 'pray',
    args_summary: JSON.stringify({ script: 'mine', max_steps: 20 }),
    result_summary: JSON.stringify({ status: 'completed', steps_executed: 3 }),
    success: 1,
    error_code: null,
    duration_ms: 500,
    is_compound: 1,
    trace_id: null,
    parent_id: null,
    status: 'complete',
    assistant_text: null,
    timestamp: '2026-04-24T12:00:00Z',
    created_at: '2026-04-24T12:00:00Z',
    ...overrides,
  };
}

describe('PrayerRow — helpers', () => {
  it('status badge: completed is success green', () => {
    expect(statusBadgeClasses('completed')).toContain('success');
  });

  it('status badge: error is error red', () => {
    expect(statusBadgeClasses('error')).toContain('error');
  });

  it('status badge: halted/step_limit_reached are amber', () => {
    expect(statusBadgeClasses('halted')).toContain('amber');
    expect(statusBadgeClasses('step_limit_reached')).toContain('amber');
  });

  it('status badge: pending is info', () => {
    expect(statusBadgeClasses('pending')).toContain('info');
  });

  it('status badge: unknown falls back to muted', () => {
    expect(statusBadgeClasses('wibble')).toContain('muted');
  });

  it('parseJson returns null on null input', () => {
    expect(parseJson(null)).toBeNull();
  });

  it('parseJson returns null on malformed JSON', () => {
    expect(parseJson('{invalid')).toBeNull();
  });

  it('parseJson returns the parsed payload on valid JSON', () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('PrayerRow — render', () => {
  it('renders collapsed row with pray label, status, and step counter', () => {
    render(
      <PrayerRow
        record={makeRecord()}
        agentName="drifter-gale"
        isGroupExpanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText('pray')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText(/3\/20 steps/)).toBeTruthy();
  });

  it('renders error tier + code when expanded on failure', () => {
    const record = makeRecord({
      success: 0,
      status: 'error',
      error_code: 'parse_error',
      result_summary: JSON.stringify({
        status: 'error',
        error: { tier: 'parse', code: 'parse_error', message: 'boom', line: 1, col: 2, suggestions: ['try again'] },
      }),
    });
    render(
      <PrayerRow
        record={record}
        agentName="drifter-gale"
        isGroupExpanded={true}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText(/parse/)).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('try again')).toBeTruthy();
  });

  it('renders pending status for in-flight prayers', () => {
    const record = makeRecord({
      status: 'pending',
      result_summary: null,
      duration_ms: null,
    });
    render(
      <PrayerRow
        record={record}
        agentName="drifter-gale"
        isGroupExpanded={false}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText('pending')).toBeTruthy();
  });
});
