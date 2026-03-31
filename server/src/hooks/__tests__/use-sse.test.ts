import { describe, it, expect } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSSE } from '../use-sse';
import { MockEventSource } from '@/test/setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks/promises */
async function flushAsync() {
  await act(async () => {
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSSE', () => {
  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  it('starts with null data, not connected, no error', () => {
    const { result } = renderHook(() => useSSE('/test-stream'));
    expect(result.current.data).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('creates an EventSource for the given URL', () => {
    renderHook(() => useSSE('/test-stream'));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].url).toBe('/test-stream');
  });

  // ---------------------------------------------------------------------------
  // Successful connection
  // ---------------------------------------------------------------------------

  it('sets connected=true and clears error on open', async () => {
    const { result } = renderHook(() => useSSE('/test-stream'));
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it('parses JSON data from default "message" event', async () => {
    const { result } = renderHook(() => useSSE<{ val: number }>('/test-stream'));
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('message', { val: 42 });
    });
    await waitFor(() => expect(result.current.data).toEqual({ val: 42 }));
  });

  it('listens for a custom eventName', async () => {
    const { result } = renderHook(() =>
      useSSE<{ status: string }>('/fleet-stream', 'status'),
    );
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('status', { status: 'running' });
    });
    await waitFor(() => expect(result.current.data?.status).toBe('running'));
  });

  it('ignores messages on wrong event type', async () => {
    const { result } = renderHook(() =>
      useSSE<{ val: number }>('/test-stream', 'status'),
    );
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      // Send on 'message' but hook listens on 'status' — should be ignored
      MockEventSource.instances[0].simulateMessage('message', { val: 99 });
    });
    await flushAsync();
    expect(result.current.data).toBeNull();
  });

  it('updates data across multiple events', async () => {
    const { result } = renderHook(() => useSSE<{ count: number }>('/test-stream'));
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      MockEventSource.instances[0].simulateMessage('message', { count: 1 });
    });
    await waitFor(() => expect(result.current.data?.count).toBe(1));

    act(() => MockEventSource.instances[0].simulateMessage('message', { count: 2 }));
    await waitFor(() => expect(result.current.data?.count).toBe(2));
  });

  // ---------------------------------------------------------------------------
  // Non-JSON messages silently ignored
  // ---------------------------------------------------------------------------

  it('silently ignores non-JSON messages without throwing', async () => {
    const { result } = renderHook(() => useSSE<{ val: number }>('/test-stream'));
    act(() => {
      MockEventSource.instances[0].simulateOpen();
      // Send raw non-JSON string directly via listeners
      const listeners = MockEventSource.instances[0].listeners['message'] ?? [];
      const rawEvent = new MessageEvent('message', { data: 'not-valid-json' });
      for (const l of listeners) l(rawEvent);
    });
    await flushAsync();
    expect(result.current.data).toBeNull();
    expect(result.current.connected).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Connection errors
  // ---------------------------------------------------------------------------

  it('sets connected=false and error message on connection error', async () => {
    const { result, unmount } = renderHook(() => useSSE('/test-stream'));
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));

    act(() => MockEventSource.instances[0].simulateError());
    await waitFor(() => expect(result.current.connected).toBe(false));
    expect(result.current.error).toMatch(/Retrying/i);
    unmount(); // cancel pending reconnect timer
  });

  it('error message includes retry delay in seconds', async () => {
    const { result, unmount } = renderHook(() => useSSE('/test-stream'));
    act(() => MockEventSource.instances[0].simulateError());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    // First retry delay = 1s
    expect(result.current.error).toMatch(/1s/);
    unmount(); // cancel pending reconnect timer
  });

  // ---------------------------------------------------------------------------
  // Reconnect backoff — actual behavior with injectable timers
  // ---------------------------------------------------------------------------

  it('creates new EventSource after error when minRetryMs is 0', async () => {
    const { unmount } = renderHook(() =>
      useSSE('/test-stream', undefined, { minRetryMs: 0, maxRetryMs: 0 }),
    );

    act(() => MockEventSource.instances[0].simulateError());

    await waitFor(() =>
      expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2),
    );
    // The latest instance should be for the same URL
    expect(MockEventSource.instances.at(-1)!.url).toBe('/test-stream');
    unmount();
  });

  it('exponential backoff increases retry delay', async () => {
    // Use default minRetryMs (1000 ms) so the error message reports readable
    // second values. The message is set synchronously in onerror; we then let
    // the real 1 s timer fire before triggering the second error.
    const { result, unmount } = renderHook(() => useSSE('/test-stream'));

    try {
      // First error → delay = 1000 ms → message shows "1s"
      act(() => MockEventSource.instances[0].simulateError());
      await waitFor(() => expect(result.current.error).toMatch(/1s/));

      // Wait for the real 1 s reconnect timer → new instance created
      await waitFor(
        () => expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2),
        { timeout: 2000 },
      );

      // Second error → delay = 2000 ms → message shows "2s" (backoff doubled)
      act(() => MockEventSource.instances.at(-1)!.simulateError());
      await waitFor(() => expect(result.current.error).toMatch(/2s/));
    } finally {
      unmount();
    }
  });

  it('resets retry counter after successful open on reconnect', async () => {
    const { result, unmount } = renderHook(() => useSSE('/test-stream'));

    try {
      // First error (count → 1, delay = 1000 ms); wait for reconnect
      act(() => MockEventSource.instances[0].simulateError());
      await waitFor(
        () => expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2),
        { timeout: 2000 },
      );

      // Open on reconnected instance → resets retry count to 0
      const reconnected = MockEventSource.instances.at(-1)!;
      act(() => reconnected.simulateOpen());

      // Second error after reset: count goes 0 → 1, delay = 1000 ms → "1s" (not "2s")
      act(() => reconnected.simulateError());
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.error).toMatch(/1s/);
    } finally {
      unmount();
    }
  });

  it('caps retry delay at maxRetryMs', async () => {
    // maxRetryMs = 1000 ms: retry 1 = 1000 ms (under cap), retry 2 would be
    // 2000 ms but clamps to 1000 ms → both messages show "1s".
    const { result, unmount } = renderHook(() =>
      useSSE('/test-stream', undefined, { minRetryMs: 1000, maxRetryMs: 1000 }),
    );

    try {
      // First error — delay = min(1000*1, 1000) = 1000 ms → "1s"
      act(() => MockEventSource.instances[0].simulateError());
      await waitFor(() => expect(result.current.error).toMatch(/1s/));

      // Wait for reconnect
      await waitFor(
        () => expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2),
        { timeout: 2000 },
      );

      // Second error — uncapped would be 2000 ms → "2s"; capped at 1000 ms → "1s"
      act(() => MockEventSource.instances.at(-1)!.simulateError());
      await waitFor(() => expect(result.current.error).not.toBeNull());
      expect(result.current.error).toMatch(/1s/);
      expect(result.current.error).not.toMatch(/2s/);
    } finally {
      unmount();
    }
  });

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  it('closes EventSource when component unmounts', async () => {
    const { result, unmount } = renderHook(() => useSSE('/test-stream'));
    act(() => MockEventSource.instances[0].simulateOpen());
    await waitFor(() => expect(result.current.connected).toBe(true));
    const es = MockEventSource.instances[0];

    unmount();
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });

  it('does not immediately reconnect after error+unmount', () => {
    const { unmount } = renderHook(() => useSSE('/test-stream'));
    act(() => MockEventSource.instances[0].simulateError());
    // Before timer fires: still 1 instance
    expect(MockEventSource.instances).toHaveLength(1);
    unmount();
    // After unmount, cleanup clears the pending reconnect timer
    expect(MockEventSource.instances).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // URL changes
  // ---------------------------------------------------------------------------

  it('creates new EventSource when URL changes', () => {
    let url = '/stream-a';
    const { rerender } = renderHook(() => useSSE(url));
    expect(MockEventSource.instances[0].url).toBe('/stream-a');

    url = '/stream-b';
    act(() => rerender());
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1].url).toBe('/stream-b');
  });

  it('closes old EventSource when URL changes', () => {
    let url = '/stream-a';
    const { rerender } = renderHook(() => useSSE(url));
    const oldEs = MockEventSource.instances[0];

    url = '/stream-b';
    act(() => rerender());

    expect(oldEs.readyState).toBe(MockEventSource.CLOSED);
  });
});
