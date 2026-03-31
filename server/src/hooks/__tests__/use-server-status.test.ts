import { describe, it, expect } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useServerStatus } from '../use-server-status';
import type { ServerStatusData } from '../use-server-status';
import { MockEventSource } from '@/test/setup';

function createMockServerStatus(overrides: Partial<ServerStatusData> = {}): ServerStatusData {
  return {
    status: 'up',
    version: '1.2.3',
    timestamp: new Date().toISOString(),
    latency_ms: 42,
    circuit_breaker: {
      state: 'closed',
      consecutive_failures: 0,
    },
    last_health_check: new Date().toISOString(),
    check_interval_seconds: 10,
    notes: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// useServerStatus — wraps useSSE for game server status stream
// ---------------------------------------------------------------------------

describe('useServerStatus', () => {
  it('starts with null data, not connected, no error', () => {
    const { result } = renderHook(() => useServerStatus());
    expect(result.current.data).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('connects to /api/server-status/stream', () => {
    renderHook(() => useServerStatus());
    expect(MockEventSource.instances[0].url).toBe('/api/server-status/stream');
  });

  it('listens for "server-status" events', () => {
    renderHook(() => useServerStatus());
    const es = MockEventSource.instances[0];
    expect(es.listeners['server-status']).toBeDefined();
    expect(es.listeners['server-status'].length).toBeGreaterThan(0);
  });

  it('ignores generic "message" events', async () => {
    const { result } = renderHook(() => useServerStatus());
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('message', createMockServerStatus());
    });
    expect(result.current.data).toBeNull();
  });

  it('parses ServerStatusData from "server-status" event', async () => {
    const { result } = renderHook(() => useServerStatus());
    const mockStatus = createMockServerStatus({ status: 'up', latency_ms: 15 });

    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('server-status', mockStatus);
    });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const data = result.current.data as ServerStatusData;
    expect(data.status).toBe('up');
    expect(data.latency_ms).toBe(15);
    expect(data.version).toBe('1.2.3');
  });

  it('sets connected=true when stream opens', async () => {
    const { result } = renderHook(() => useServerStatus());
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  it('handles degraded status', async () => {
    const { result } = renderHook(() => useServerStatus());
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage(
        'server-status',
        createMockServerStatus({ status: 'degraded', latency_ms: 800 }),
      );
    });
    await waitFor(() => expect(result.current.data?.status).toBe('degraded'));
  });

  it('handles down status with circuit breaker open', async () => {
    const { result } = renderHook(() => useServerStatus());
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage(
        'server-status',
        createMockServerStatus({
          status: 'down',
          latency_ms: null,
          circuit_breaker: {
            state: 'open',
            consecutive_failures: 5,
            cooldown_remaining_ms: 30000,
          },
        }),
      );
    });

    await waitFor(() => expect(result.current.data?.status).toBe('down'));
    expect(result.current.data?.circuit_breaker.state).toBe('open');
    expect(result.current.data?.circuit_breaker.consecutive_failures).toBe(5);
    expect(result.current.data?.circuit_breaker.cooldown_remaining_ms).toBe(30000);
  });

  it('handles null version', async () => {
    const { result } = renderHook(() => useServerStatus());
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage(
        'server-status',
        createMockServerStatus({ version: null }),
      );
    });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.version).toBeNull();
  });

  it('updates data on subsequent events', async () => {
    const { result } = renderHook(() => useServerStatus());
    act(() => MockEventSource.instances[0].simulateOpen());

    act(() =>
      MockEventSource.instances[0].simulateMessage(
        'server-status',
        createMockServerStatus({ status: 'up', latency_ms: 10 }),
      ),
    );
    await waitFor(() => expect(result.current.data?.latency_ms).toBe(10));

    act(() =>
      MockEventSource.instances[0].simulateMessage(
        'server-status',
        createMockServerStatus({ status: 'degraded', latency_ms: 500 }),
      ),
    );
    await waitFor(() => expect(result.current.data?.status).toBe('degraded'));
    expect(result.current.data?.latency_ms).toBe(500);
  });
});
