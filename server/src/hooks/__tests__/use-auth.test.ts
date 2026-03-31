import { describe, it, expect, mock } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useAuth, useAuthFetch, AuthContext } from '../use-auth';
import type { AuthState } from '../use-auth';
import { mockFetch } from '@/test/mocks/hooks';

// ---------------------------------------------------------------------------
// useAuth — context consumer
// ---------------------------------------------------------------------------

describe('useAuth', () => {
  it('returns the default context value when no provider is present', () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.role).toBe('viewer');
    expect(result.current.identity).toBeNull();
    expect(result.current.loading).toBe(true);
    expect(result.current.isAdmin).toBe(false);
  });

  it('returns context value from AuthContext.Provider', () => {
    const customAuth: AuthState = {
      role: 'admin',
      identity: 'alice',
      loading: false,
      isAdmin: true,
    };

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      React.createElement(AuthContext.Provider, { value: customAuth }, children)
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.role).toBe('admin');
    expect(result.current.identity).toBe('alice');
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.loading).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// useAuthFetch — data fetching hook
// ---------------------------------------------------------------------------

describe('useAuthFetch', () => {
  it('starts in loading state', () => {
    // fetch never resolves in this test
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuthFetch());
    expect(result.current.loading).toBe(true);
    expect(result.current.role).toBe('viewer');
  });

  it('fetches /api/auth/me and sets admin state', async () => {
    mockFetch({ role: 'admin', identity: 'test-user' });
    const { result } = renderHook(() => useAuthFetch());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('admin');
    expect(result.current.identity).toBe('test-user');
    expect(result.current.isAdmin).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('fetches /api/auth/me and sets viewer state', async () => {
    mockFetch({ role: 'viewer', identity: null });
    const { result } = renderHook(() => useAuthFetch());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('viewer');
    expect(result.current.identity).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  it('defaults to viewer on fetch error (safe fallback)', async () => {
    global.fetch = mock().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuthFetch());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('viewer');
    expect(result.current.isAdmin).toBe(false);
    expect(result.current.identity).toBeNull();
  });

  it('defaults to viewer on non-OK response', async () => {
    global.fetch = mock().mockResolvedValue({
      ok: false,
      status: 401,
      json: mock().mockResolvedValue({}),
    }) as unknown as typeof fetch;
    // Note: the hook doesn't check res.ok — it just parses json.
    // If the response body is empty/invalid, the catch handler fires.
    global.fetch = mock().mockResolvedValue({
      ok: false,
      status: 401,
      json: mock().mockRejectedValue(new Error('Invalid JSON')),
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuthFetch());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('viewer');
  });

  it('defaults to viewer when payload role is invalid', async () => {
    global.fetch = mock().mockResolvedValue({
      ok: true,
      json: mock().mockResolvedValue({ role: 'owner', identity: 'alice' }),
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuthFetch());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('viewer');
    expect(result.current.identity).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  it('defaults to viewer when payload is not an object', async () => {
    global.fetch = mock().mockResolvedValue({
      ok: true,
      json: mock().mockResolvedValue('not-an-object'),
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useAuthFetch());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.role).toBe('viewer');
    expect(result.current.identity).toBeNull();
  });

  it('transitions from loading=true to loading=false', async () => {
    mockFetch({ role: 'admin', identity: 'alice' });
    const { result } = renderHook(() => useAuthFetch());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('does not update state after unmount (no memory leak)', async () => {
    let resolveAuth!: (v: { role: string; identity: string | null }) => void;
    global.fetch = mock().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveAuth = (data) =>
            resolve({
              ok: true,
              json: () => Promise.resolve(data),
            } as unknown as Response);
        }),
    ) as unknown as typeof fetch;

    const { result, unmount } = renderHook(() => useAuthFetch());
    expect(result.current.loading).toBe(true);

    // Unmount before fetch resolves
    unmount();

    // Resolve the fetch after unmount
    await act(async () => {
      resolveAuth({ role: 'admin', identity: 'alice' });
      await Promise.resolve();
    });

    // State should still be loading=true (no setState after unmount)
    expect(result.current.loading).toBe(true);
    expect(result.current.role).toBe('viewer');
  });
});
