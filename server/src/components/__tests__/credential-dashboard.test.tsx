import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import { CredentialDashboard } from '../credential-dashboard';
import { AuthContext } from '@/hooks/use-auth';

// Use AuthContext.Provider instead of mock.module('@/hooks/use-auth') to avoid
// poisoning the module registry for auth-provider.test.tsx (mock.module persists
// across files with maxConcurrency=1).
const ADMIN_AUTH = { role: 'admin' as const, identity: 'test-admin', loading: false, isAdmin: true };

const originalFetch = global.fetch;

describe('CredentialDashboard', () => {
  beforeEach(() => {
    global.fetch = mock().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.includes('/api/credentials/audit')) {
          return [
            { id: 1, agent_name: 'agent-1', action: 'enrolled', timestamp: new Date().toISOString(), actor: 'admin', details: null }
          ];
        }
        if (url.includes('/api/credentials')) {
          return [
            { name: 'agent-1', hasCredentials: true, username: 'user1' },
            { name: 'agent-2', hasCredentials: false, username: null }
          ];
        }
        return { ok: true };
      },
      status: 200,
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders agent credential status', async () => {
    await act(async () => {
      render(
        <AuthContext.Provider value={ADMIN_AUTH}>
          <CredentialDashboard />
        </AuthContext.Provider>,
      );
    });

    await waitFor(() => {
      // Find agent-1 in the table
      const rows = screen.getAllByText('agent-1');
      expect(rows.length).toBeGreaterThan(0);
      expect(screen.getByText('agent-2')).toBeInTheDocument();
      expect(screen.getByText('Configured')).toBeInTheDocument();
      expect(screen.getByText('Missing')).toBeInTheDocument();
    });
  });

  it('renders audit log', async () => {
    await act(async () => {
      render(
        <AuthContext.Provider value={ADMIN_AUTH}>
          <CredentialDashboard />
        </AuthContext.Provider>,
      );
    });

    await waitFor(() => {
      // Search for "enrolled" which is a distinct word in the audit log
      expect(screen.getByText(/enrolled/i)).toBeInTheDocument();
    });
  });
});
