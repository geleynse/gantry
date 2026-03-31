import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MockEventSource } from '@/test/setup';
import { LogStream } from '../log-stream';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function simulateLogLines(lines: string[]) {
  const es = MockEventSource.instances[0];
  if (!es) throw new Error('No MockEventSource instance found');
  es.simulateMessage('log', { lines, offset: 0 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogStream', () => {
  beforeEach(() => {
    // MockEventSource.instances is reset by setup.ts beforeEach
  });

  describe('basic rendering', () => {
    it('shows waiting message before log events arrive', () => {
      render(<LogStream agentName="test-agent" />);
      expect(screen.getByText(/Waiting for logs/)).toBeInTheDocument();
    });

    it('renders log lines after receiving a log event', async () => {
      render(<LogStream agentName="test-agent" />);

      act(() => {
        MockEventSource.instances[0]?.simulateOpen();
        simulateLogLines(['Hello from agent.']);
      });

      await waitFor(() => {
        expect(screen.getByText('Hello from agent.')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Timestamp localization (#511)
  // -------------------------------------------------------------------------

  describe('timestamp localization (#511)', () => {
    it('replaces ISO 8601 UTC timestamp with local HH:MM:SS', async () => {
      render(<LogStream agentName="test-agent" />);

      act(() => {
        MockEventSource.instances[0]?.simulateOpen();
        simulateLogLines(['[2026-03-07T19:53:00Z] Agent started turn.']);
      });

      await waitFor(() => {
        // The raw ISO date should NOT appear — it was replaced with local time
        expect(screen.queryByText(/2026-03-07T19:53:00Z/)).not.toBeInTheDocument();
        // A HH:MM:SS time should appear in the line
        expect(screen.getByText(/\d{2}:\d{2}:\d{2}/)).toBeInTheDocument();
        // Non-timestamp text is preserved
        expect(screen.getByText(/Agent started turn/)).toBeInTheDocument();
      });
    });

    it('replaces space-separated timestamp with local HH:MM:SS', async () => {
      render(<LogStream agentName="test-agent" />);

      act(() => {
        MockEventSource.instances[0]?.simulateOpen();
        simulateLogLines(['[2026-03-07 08:30:00] Docked at Cinder Wake Station.']);
      });

      await waitFor(() => {
        // The space-separated date string should not appear verbatim
        expect(screen.queryByText(/2026-03-07 08:30:00/)).not.toBeInTheDocument();
        // Rest of the line preserved
        expect(screen.getByText(/Docked at Cinder Wake Station/)).toBeInTheDocument();
      });
    });

    it('replaces ISO timestamp with milliseconds', async () => {
      render(<LogStream agentName="test-agent" />);

      act(() => {
        MockEventSource.instances[0]?.simulateOpen();
        simulateLogLines(['2026-03-07T12:00:00.123Z turn=5 cost=0.04']);
      });

      await waitFor(() => {
        // The ISO timestamp should be replaced
        expect(screen.queryByText(/2026-03-07T12:00:00\.123Z/)).not.toBeInTheDocument();
        // Other parts of line preserved
        expect(screen.getByText(/turn=5 cost=0.04/)).toBeInTheDocument();
      });
    });
  });
});
