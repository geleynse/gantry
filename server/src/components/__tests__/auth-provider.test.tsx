import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { AuthProvider } from '../auth-provider';
import { useAuth } from '@/hooks/use-auth';
import { mockFetch } from '@/test/mocks/hooks';

// ---------------------------------------------------------------------------
// Test consumer component
// ---------------------------------------------------------------------------

function AuthConsumer() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="role">{auth.role}</span>
      <span data-testid="identity">{auth.identity ?? 'null'}</span>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="is-admin">{String(auth.isAdmin)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AuthProvider tests
// ---------------------------------------------------------------------------

describe('AuthProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders children', () => {
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    render(
      <AuthProvider>
        <span data-testid="child">hello</span>
      </AuthProvider>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('provides loading=true initially before fetch completes', () => {
    global.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch; // never resolves
    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );
    expect(screen.getByTestId('loading').textContent).toBe('true');
  });

  it('provides admin auth state to consumers after successful fetch', async () => {
    mockFetch({ role: 'admin', identity: 'alice' });
    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('role').textContent).toBe('admin');
    expect(screen.getByTestId('identity').textContent).toBe('alice');
    expect(screen.getByTestId('is-admin').textContent).toBe('true');
  });

  it('provides viewer auth state to consumers after successful fetch (viewer)', async () => {
    mockFetch({ role: 'viewer', identity: null });
    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('role').textContent).toBe('viewer');
    expect(screen.getByTestId('is-admin').textContent).toBe('false');
  });

  it('falls back to viewer state on fetch error', async () => {
    global.fetch = mock().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;
    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(screen.getByTestId('role').textContent).toBe('viewer');
    expect(screen.getByTestId('is-admin').textContent).toBe('false');
  });

  it('calls /api/auth/me exactly once on mount', async () => {
    const mockFetchFn = mockFetch({ role: 'viewer', identity: null });
    render(
      <AuthProvider>
        <AuthConsumer />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(mockFetchFn).toHaveBeenCalledTimes(1);
    expect(mockFetchFn).toHaveBeenCalledWith('/api/auth/me', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('nested AuthProviders: inner provider overrides outer', async () => {
    mockFetch({ role: 'viewer', identity: null });
    render(
      <AuthProvider>
        <AuthProvider>
          <AuthConsumer />
        </AuthProvider>
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    // Inner auth state wins — viewer
    expect(screen.getByTestId('role').textContent).toBe('viewer');
  });
});
