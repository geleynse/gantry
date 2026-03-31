import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import React from 'react';
import { OutboundReviewPanel } from '../outbound-review';
import { AuthContext } from '@/hooks/use-auth';

// ---------------------------------------------------------------------------
// Module mocks — DO NOT mock @/lib/api here. mock.module() leaks across all
// test files in CI (bun runs them in one process). apiFetch already delegates
// to global.fetch, which we mock in beforeEach below.
// ---------------------------------------------------------------------------

mock.module('@/lib/utils', () => ({
  cn: (...classes: (string | undefined | false | null)[]) => classes.filter(Boolean).join(' '),
}));

mock.module('lucide-react', () => ({
  CheckCircle: () => null,
  XCircle: () => null,
  Clock: () => null,
  Filter: () => null,
  RefreshCw: () => null,
}));

// ---------------------------------------------------------------------------
// Auth context wrapper — avoids module mock leaking into auth-provider tests
// ---------------------------------------------------------------------------

const ADMIN_AUTH = { role: 'admin' as const, identity: 'test-admin', loading: false, isAdmin: true };
const VIEWER_AUTH = { role: 'viewer' as const, identity: null, loading: false, isAdmin: false };

function WithAuth({ admin, children }: { admin: boolean; children: React.ReactNode }) {
  return (
    <AuthContext.Provider value={admin ? ADMIN_AUTH : VIEWER_AUTH}>
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_MESSAGES = [
  {
    id: 1,
    timestamp: '2026-03-09 10:00:00',
    agentName: 'rust-vane',
    channel: 'forum',
    content: 'Best trading routes in the Solarian sector!',
    metadata: { v1_action: 'forum_create_thread' },
    status: 'pending',
  },
  {
    id: 2,
    timestamp: '2026-03-09 10:05:00',
    agentName: 'cinder-wake',
    channel: 'chat',
    content: 'Anyone at Nexus Prime?',
    metadata: { v1_action: 'chat' },
    status: 'pending',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  global.fetch = mock(async (url: string) => {
    const path = String(url);
    if (path.includes('/api/outbound/pending/count')) {
      return new Response(JSON.stringify({ count: 2 }), { status: 200 });
    }
    if (path.includes('/api/outbound/pending')) {
      return new Response(JSON.stringify(SAMPLE_MESSAGES), { status: 200 });
    }
    if (path.includes('/api/outbound/history')) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof global.fetch;
});

describe('OutboundReviewPanel', () => {
  it('renders pending messages for admin', async () => {
    render(
      <WithAuth admin={true}>
        <OutboundReviewPanel />
      </WithAuth>,
    );

    await waitFor(() => {
      expect(screen.getByText('rust-vane')).toBeInTheDocument();
    });

    expect(screen.getByText('cinder-wake')).toBeInTheDocument();
    expect(screen.getByText('Best trading routes in the Solarian sector!')).toBeInTheDocument();
  });

  it('calls approve API when Approve button clicked', async () => {
    const approveCallUrls: string[] = [];
    global.fetch = mock(async (url: string, options?: RequestInit) => {
      const path = String(url);
      if (path.includes('/api/outbound/approve/') && options?.method === 'POST') {
        approveCallUrls.push(path);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (path.includes('/api/outbound/pending/count')) {
        return new Response(JSON.stringify({ count: 1 }), { status: 200 });
      }
      if (path.includes('/api/outbound/pending')) {
        return new Response(JSON.stringify(SAMPLE_MESSAGES), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(
      <WithAuth admin={true}>
        <OutboundReviewPanel />
      </WithAuth>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Approve').length).toBeGreaterThan(0);
    });

    const approveButtons = screen.getAllByText('Approve');
    fireEvent.click(approveButtons[0]);

    await waitFor(() => {
      expect(approveCallUrls.some(u => u.includes('/api/outbound/approve/'))).toBe(true);
    });
  });

  it('shows "No pending messages" when queue is empty', async () => {
    global.fetch = mock(async (url: string) => {
      const path = String(url);
      if (path.includes('/api/outbound/pending/count')) {
        return new Response(JSON.stringify({ count: 0 }), { status: 200 });
      }
      if (path.includes('/api/outbound/pending')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof global.fetch;

    render(
      <WithAuth admin={true}>
        <OutboundReviewPanel />
      </WithAuth>,
    );

    await waitFor(() => {
      expect(screen.getByText('No pending messages')).toBeInTheDocument();
    });
  });

  it('shows admin-required message for non-admin users', async () => {
    render(
      <WithAuth admin={false}>
        <OutboundReviewPanel />
      </WithAuth>,
    );

    expect(screen.getByText(/Admin access required/)).toBeInTheDocument();
  });
});
