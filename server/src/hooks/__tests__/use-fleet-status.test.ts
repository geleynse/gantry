import { describe, it, expect } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFleetStatus, useToolCallStream } from '../use-fleet-status';
import type { FleetStatus, ToolCallEvent } from '../use-fleet-status';
import { MockEventSource } from '@/test/setup';
import { createMockFleetStatus } from '@/test/mocks/agents';

// ---------------------------------------------------------------------------
// useFleetStatus — wraps useSSE for the fleet status stream
// ---------------------------------------------------------------------------

describe('useFleetStatus', () => {
  it('starts with null data, not connected, no error', () => {
    const { result } = renderHook(() => useFleetStatus());
    expect(result.current.data).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('connects to /api/status/stream', () => {
    renderHook(() => useFleetStatus());
    expect(MockEventSource.instances[0].url).toBe('/api/status/stream');
  });

  it('listens for "status" events (not generic "message")', () => {
    renderHook(() => useFleetStatus());
    const es = MockEventSource.instances[0];
    // Should have a "status" listener registered
    expect(es.listeners['status']).toBeDefined();
    expect(es.listeners['status'].length).toBeGreaterThan(0);
  });

  it('does not receive generic "message" events', async () => {
    const { result } = renderHook(() => useFleetStatus());
    const es = MockEventSource.instances[0];
    act(() => {
      es.simulateOpen();
      es.simulateMessage('message', createMockFleetStatus());
    });
    // data should be null since hook only listens to 'status'
    expect(result.current.data).toBeNull();
  });

  it('parses FleetStatus from "status" event', async () => {
    const { result } = renderHook(() => useFleetStatus());
    const mockStatus = createMockFleetStatus();

    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('status', mockStatus);
    });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const data = result.current.data as FleetStatus;
    expect(data.agents).toHaveLength(mockStatus.agents.length);
    expect(data.turnSleepMs).toBe(90);
    expect(data.fleetName).toBe('Test Fleet');
  });

  it('sets connected=true on open', async () => {
    const { result } = renderHook(() => useFleetStatus());
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));
  });

  it('includes all expected AgentStatus fields', async () => {
    const { result } = renderHook(() => useFleetStatus());
    const mockStatus = createMockFleetStatus([{ name: 'drifter-gale', state: 'running', healthScore: 85 }]);

    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('status', mockStatus);
    });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    const agent = result.current.data!.agents[0];
    expect(agent.name).toBe('drifter-gale');
    expect(agent.state).toBe('running');
    expect(agent.healthScore).toBe(85);
    expect(agent.turnCount).toBeTypeOf('number');
    expect(agent.llmRunning).toBeTypeOf('boolean');
  });

  it('updates with new fleet status events in sequence', async () => {
    const { result } = renderHook(() => useFleetStatus());
    act(() => MockEventSource.instances[0].simulateOpen());

    const status1 = createMockFleetStatus([{ name: 'drifter-gale', turnCount: 10 }]);
    act(() => MockEventSource.instances[0].simulateMessage('status', status1));
    await waitFor(() => expect(result.current.data?.agents[0].turnCount).toBe(10));

    const status2 = createMockFleetStatus([{ name: 'drifter-gale', turnCount: 20 }]);
    act(() => MockEventSource.instances[0].simulateMessage('status', status2));
    await waitFor(() => expect(result.current.data?.agents[0].turnCount).toBe(20));
  });

  it('surfaces connection errors from SSE transport', async () => {
    const { result, unmount } = renderHook(() => useFleetStatus());
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => MockEventSource.instances[0].simulateError());
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.error).toMatch(/Retrying/i);
    unmount();
  });
});

// ---------------------------------------------------------------------------
// useToolCallStream — listens for toolCall events on same SSE stream
// ---------------------------------------------------------------------------

describe('useToolCallStream', () => {
  it('connects to /api/status/stream', () => {
    renderHook(() => useToolCallStream());
    expect(MockEventSource.instances[0].url).toBe('/api/status/stream');
  });

  it('listens for "toolCall" events', () => {
    renderHook(() => useToolCallStream());
    const es = MockEventSource.instances[0];
    expect(es.listeners['toolCall']).toBeDefined();
  });

  it('parses ToolCallEvent from "toolCall" event', async () => {
    const { result } = renderHook(() => useToolCallStream());
    const toolCall: ToolCallEvent = {
      agent: 'drifter-gale',
      tool: 'mine',
      ts: Date.now(),
      success: true,
      summary: 'Mined 5 iron ore',
    };

    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('toolCall', toolCall);
    });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data!.agent).toBe('drifter-gale');
    expect(result.current.data!.tool).toBe('mine');
    expect(result.current.data!.success).toBe(true);
  });

  it('does not receive "status" events', async () => {
    const { result } = renderHook(() => useToolCallStream());
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('status', createMockFleetStatus());
    });
    expect(result.current.data).toBeNull();
  });

  it('surfaces connection errors from SSE transport', async () => {
    const { result, unmount } = renderHook(() => useToolCallStream());
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => MockEventSource.instances[0].simulateError());
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.error).toMatch(/Retrying/i);
    unmount();
  });
});
