import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { renderHook, waitFor } from '@testing-library/react';
import { useGameState } from '../use-game-state';
import type { AgentGameState } from '../use-game-state';
import { createMockFleetGameState, createMockGameState } from '@/test/mocks/game-state';
import { mockFetch, mockFetchResponse } from '@/test/mocks/hooks';

// useGameState polls /api/game-state/all via apiFetch (which calls fetch('/api/...')).
// We mock global.fetch in the setup.ts and via mockFetch helper.

describe('useGameState', () => {
  // Reset global.fetch between tests to prevent mock leakage
  beforeEach(() => {
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch; // safe default: never resolves
  });
  // ---------------------------------------------------------------------------
  // Initial state
  // ---------------------------------------------------------------------------

  it('starts in loading state with null data', () => {
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    const { result } = renderHook(() => useGameState());
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Successful fetch
  // ---------------------------------------------------------------------------

  it('fetches from /api/game-state/all on mount', async () => {
    const mockData = createMockFleetGameState(['drifter-gale', 'sable-thorn']);
    mockFetch(mockData);

    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(global.fetch).toHaveBeenCalledWith('/api/game-state/all', undefined);
  });

  it('sets data map after successful fetch', async () => {
    const mockData = createMockFleetGameState(['drifter-gale', 'sable-thorn']);
    mockFetch(mockData);

    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).not.toBeNull();
    expect(Object.keys(result.current.data!)).toContain('drifter-gale');
    expect(Object.keys(result.current.data!)).toContain('sable-thorn');
  });

  it('sets loading=false after successful fetch', async () => {
    mockFetch(createMockFleetGameState());
    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it('includes correct AgentGameState shape per agent', async () => {
    const gameState = createMockGameState({ credits: 99999, current_system: 'Alpha Centauri' });
    mockFetch({ 'drifter-gale': gameState });

    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    const agentState = result.current.data!['drifter-gale'] as AgentGameState;
    expect(agentState.credits).toBe(99999);
    expect(agentState.current_system).toBe('Alpha Centauri');
    expect(agentState.ship).not.toBeNull();
    expect(agentState.ship!.hull).toBeTypeOf('number');
  });

  it('returns ship modules and cargo arrays', async () => {
    mockFetch({ 'drifter-gale': createMockGameState() });
    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const ship = result.current.data!['drifter-gale'].ship!;
    expect(Array.isArray(ship.modules)).toBe(true);
    expect(Array.isArray(ship.cargo)).toBe(true);
  });

  it('handles agent with null ship', async () => {
    const stateNoShip = createMockGameState({ ship: undefined });
    mockFetch({ 'drifter-gale': stateNoShip });

    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data!['drifter-gale'].ship).toBeFalsy();
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  it('sets error on fetch failure', async () => {
    global.fetch = mock().mockResolvedValue({
      ok: false,
      status: 500,
      text: mock().mockResolvedValue('Internal Server Error'),
      statusText: 'Internal Server Error',
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).not.toBeNull();
    expect(result.current.error).toContain('500');
  });

  it('sets error on network failure', async () => {
    global.fetch = mock().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;
    const { result } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Network error');
  });

  it('preserves previous data on error after successful fetch', async () => {
    const mockData = createMockFleetGameState(['drifter-gale']);
    // First call succeeds, all subsequent polls fail — the error must persist
    // so waitFor can observe it reliably (no race with a third success clearing it).
    global.fetch = mock()
      .mockResolvedValueOnce(mockFetchResponse(mockData))
      .mockRejectedValue(new Error('Network error')) as unknown as typeof fetch; // all subsequent polls fail

    const { result, unmount } = renderHook(() => useGameState(50));
    try {
      // Wait until first fetch completes
      await waitFor(() => expect(result.current.loading).toBe(false), { timeout: 5000 });
      expect(result.current.data).not.toBeNull();

      // Wait for the error from the second poll
      await waitFor(() => expect(result.current.error).toBe('Network error'), {
        timeout: 5000,
      });
      // Data must still be present despite the error
      expect(result.current.data).not.toBeNull();
      expect(Object.keys(result.current.data!)).toContain('drifter-gale');
    } finally {
      unmount();
    }
  });

  // ---------------------------------------------------------------------------
  // Lifecycle / cleanup
  // ---------------------------------------------------------------------------

  it('makes the initial fetch call on mount', async () => {
    const mockData = createMockFleetGameState();
    global.fetch = mock().mockResolvedValue({
      ok: true,
      json: mock().mockResolvedValue(mockData),
    }) as unknown as typeof fetch;

    renderHook(() => useGameState());
    await waitFor(() => expect((global.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThan(0));
    expect((global.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('cleans up without error on unmount', async () => {
    mockFetch(createMockFleetGameState());
    const { result, unmount } = renderHook(() => useGameState());
    await waitFor(() => expect(result.current.loading).toBe(false));
    // Unmounting should not throw
    expect(() => unmount()).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Polling — real timers with injectable interval
  // ---------------------------------------------------------------------------

  it('polls again after the interval elapses', async () => {
    const mockData = createMockFleetGameState(['drifter-gale']);
    global.fetch = mock()
      .mockResolvedValue(mockFetchResponse(mockData)) as unknown as typeof fetch;

    const { unmount } = renderHook(() => useGameState(50)); // 50 ms polling interval
    try {
      // Wait for the first fetch
      await waitFor(() =>
        expect((global.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1),
      );

      // Wait for at least one more poll
      await waitFor(
        () =>
          expect(
            (global.fetch as unknown as ReturnType<typeof mock>).mock.calls.length,
          ).toBeGreaterThanOrEqual(2),
        { timeout: 500 },
      );
    } finally {
      unmount(); // stop the polling interval
    }
  });

  it('continues polling after a fetch error', async () => {
    const mockData = createMockFleetGameState(['drifter-gale']);
    global.fetch = mock()
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValue(mockFetchResponse(mockData)) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useGameState(200)); // 200 ms interval
    try {
      // First fetch fails — loading transitions to false once the error is set
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe('Network error');
      expect(result.current.data).toBeNull();

      // Second poll (200 ms later) succeeds — error clears and data arrives
      await waitFor(() => expect(result.current.data).not.toBeNull(), { timeout: 1000 });
      expect(result.current.error).toBeNull();
    } finally {
      unmount(); // stop the polling interval
    }
  });
});
