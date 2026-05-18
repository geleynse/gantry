import { describe, it, expect } from 'bun:test';
import { getServerStatusDisplay } from '../server-status-widget';
import type { ServerStatusData } from '@/hooks/use-server-status';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(
  status: ServerStatusData['status'],
  cbState: 'closed' | 'open' | 'half-open',
  failures = 0,
  extra: Partial<ServerStatusData> = {}
): ServerStatusData {
  return {
    status,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    latency_ms: null,
    circuit_breaker: {
      state: cbState,
      consecutive_failures: failures,
    },
    last_health_check: new Date().toISOString(),
    check_interval_seconds: 10,
    notes: '',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// getServerStatusDisplay — pure helper
// ---------------------------------------------------------------------------

describe('getServerStatusDisplay', () => {
  // -------------------------------------------------------------------------
  // Null / missing payload
  // -------------------------------------------------------------------------

  it('returns unknown when payload is null', () => {
    const d = getServerStatusDisplay(null);
    expect(d.label).toBe('—');
    expect(d.severity).toBe('unknown');
  });

  it('returns unknown when payload is undefined', () => {
    const d = getServerStatusDisplay(undefined);
    expect(d.label).toBe('—');
    expect(d.severity).toBe('unknown');
  });

  // -------------------------------------------------------------------------
  // Circuit-breaker present: state drives the badge
  // -------------------------------------------------------------------------

  it('shows UP green when cb=closed + status=up', () => {
    const d = getServerStatusDisplay(makePayload('up', 'closed'));
    expect(d.label).toBe('UP');
    expect(d.severity).toBe('up');
  });

  it('shows DEGRADED yellow when cb=half-open (regardless of status field)', () => {
    const d = getServerStatusDisplay(makePayload('up', 'half-open', 2));
    expect(d.label).toBe('DEGRADED');
    expect(d.severity).toBe('degraded');
  });

  it('shows DOWN red when cb=open', () => {
    const d = getServerStatusDisplay(makePayload('up', 'open', 5));
    expect(d.label).toBe('DOWN');
    expect(d.severity).toBe('down');
  });

  it('shows DOWN red when cb=open even if status field says "up"', () => {
    // The CB state is authoritative — a transient "up" status must not override open CB
    const d = getServerStatusDisplay(makePayload('up', 'open', 3));
    expect(d.severity).toBe('down');
  });

  it('shows DEGRADED when cb=closed + status=degraded', () => {
    const d = getServerStatusDisplay(makePayload('degraded', 'closed'));
    expect(d.label).toBe('DEGRADED');
    expect(d.severity).toBe('degraded');
  });

  it('shows DOWN when cb=closed + status=down', () => {
    const d = getServerStatusDisplay(makePayload('down', 'closed'));
    expect(d.label).toBe('DOWN');
    expect(d.severity).toBe('down');
  });

  // -------------------------------------------------------------------------
  // tooltipDetail — consecutive_failures
  // -------------------------------------------------------------------------

  it('includes tooltipDetail when consecutive_failures > 0', () => {
    const d = getServerStatusDisplay(makePayload('up', 'half-open', 3));
    expect(d.tooltipDetail).toBe('3 consecutive upstream failures');
  });

  it('uses singular when consecutive_failures === 1', () => {
    const d = getServerStatusDisplay(makePayload('up', 'half-open', 1));
    expect(d.tooltipDetail).toBe('1 consecutive upstream failure');
  });

  it('omits tooltipDetail when consecutive_failures === 0', () => {
    const d = getServerStatusDisplay(makePayload('up', 'closed', 0));
    expect(d.tooltipDetail).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Fallback: circuit_breaker field missing (older server build)
  // -------------------------------------------------------------------------

  it('falls back to status=up when circuit_breaker is absent', () => {
    const payload: ServerStatusData = {
      status: 'up',
      version: '0.9.0',
      timestamp: new Date().toISOString(),
      latency_ms: null,
      // @ts-expect-error testing absent field
      circuit_breaker: undefined,
      last_health_check: null,
      check_interval_seconds: 10,
      notes: '',
    };
    const d = getServerStatusDisplay(payload);
    expect(d.label).toBe('UP');
    expect(d.severity).toBe('up');
  });

  it('falls back to status=degraded when circuit_breaker is absent', () => {
    const payload: ServerStatusData = {
      status: 'degraded',
      version: '0.9.0',
      timestamp: new Date().toISOString(),
      latency_ms: null,
      // @ts-expect-error testing absent field
      circuit_breaker: undefined,
      last_health_check: null,
      check_interval_seconds: 10,
      notes: '',
    };
    const d = getServerStatusDisplay(payload);
    expect(d.label).toBe('DEGRADED');
    expect(d.severity).toBe('degraded');
  });

  it('falls back to status=down when circuit_breaker is absent', () => {
    const payload: ServerStatusData = {
      status: 'down',
      version: '0.9.0',
      timestamp: new Date().toISOString(),
      latency_ms: null,
      // @ts-expect-error testing absent field
      circuit_breaker: undefined,
      last_health_check: null,
      check_interval_seconds: 10,
      notes: '',
    };
    const d = getServerStatusDisplay(payload);
    expect(d.label).toBe('DOWN');
    expect(d.severity).toBe('down');
  });
});
