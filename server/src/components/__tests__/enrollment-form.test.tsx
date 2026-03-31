import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { EnrollmentForm } from '../enrollment-form';
import { AuthContext } from '@/hooks/use-auth';

// Use AuthContext.Provider instead of mock.module('@/hooks/use-auth') to avoid
// poisoning the module registry for auth-provider.test.tsx (mock.module persists
// across files with maxConcurrency=1).
const ADMIN_AUTH = { role: 'admin' as const, identity: 'test-admin', loading: false, isAdmin: true };

const originalFetch = global.fetch;

describe('EnrollmentForm', () => {
  beforeEach(() => {
    global.fetch = mock().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.includes('/enrollment-options')) {
          return {
            roleTypes: ['trader', 'miner'],
            mcpPresets: ['basic', 'standard', 'full'],
            empires: ['Solarian', 'Nebula'],
            factions: ['Solarian', 'Nebula'],
            suggestions: { Solarian: 'trader' }
          };
        }
        if (url.includes('/prompt-preview')) {
          return { preview: 'Mock Preview' };
        }
        return { success: true, agent: { name: 'test-agent' }, password: 'pass' };
      },
      status: 200,
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('renders enrollment form with options', async () => {
    await act(async () => {
      render(
        <AuthContext.Provider value={ADMIN_AUTH}>
          <EnrollmentForm onClose={() => {}} />
        </AuthContext.Provider>,
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Enroll New Agent')).toBeInTheDocument();
      expect(screen.getByText('Solarian')).toBeInTheDocument();
    });
  });

  it('submits form and shows success screen', async () => {
    await act(async () => {
      render(
        <AuthContext.Provider value={ADMIN_AUTH}>
          <EnrollmentForm onClose={() => {}} />
        </AuthContext.Provider>,
      );
    });

    await waitFor(() => screen.getByLabelText(/Agent Name/i));

    fireEvent.change(screen.getByLabelText(/Agent Name/i), { target: { value: 'test-agent' } });
    fireEvent.change(screen.getByLabelText(/Game Username/i), { target: { value: 'user1' } });
    fireEvent.change(screen.getByPlaceholderText(/From spacemolt.com/i), { target: { value: 'CODE123' } });
    fireEvent.change(screen.getByLabelText(/Role Description/i), { target: { value: 'Trading' } });

    await act(async () => {
      fireEvent.click(screen.getByText('Enroll Agent'));
    });

    await waitFor(() => {
      expect(screen.getByText('Enrollment Successful')).toBeInTheDocument();
      // Use partial match because of bold styling
      expect(screen.getByText(/test-agent/i)).toBeInTheDocument();
    });
  });
});
