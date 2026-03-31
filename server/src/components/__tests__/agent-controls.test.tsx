import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { createMockAgentStatus } from '@/test/mocks/agents';

// ---------------------------------------------------------------------------
// Mocks — use global.fetch instead of mock.module('@/lib/api') to avoid
// cross-test contamination. mock.module() persists for the entire worker
// process with maxConcurrency=1 (CI), breaking all subsequent tests that
// import @/lib/api.
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

import { AgentControls } from '../agent-controls';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default mock: routes /routines → list, everything else → { ok: true } */
function setupDefaultMock(routines: string[] = []) {
  global.fetch = mock().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => {
      if (url.includes('/routines')) return { routines };
      return { ok: true };
    },
    text: async () => '',
    status: 200,
    statusText: 'OK',
  })) as unknown as typeof fetch;
}

async function renderComponent(ui: React.ReactElement) {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(ui);
    // Flush useEffect / Promises
    await new Promise((r) => setTimeout(r, 0));
  });
  return result!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentControls', () => {
  beforeEach(() => {
    setupDefaultMock();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ── Render ───────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders Process Controls section', async () => {
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      expect(screen.getByText('Process Controls')).toBeInTheDocument();
    });

    it('renders Send Fleet Order section', async () => {
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      expect(screen.getByText('Send Fleet Order')).toBeInTheDocument();
    });

    it('renders Trigger Routine section', async () => {
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      expect(screen.getByText('Trigger Routine')).toBeInTheDocument();
    });

    it('shows Start button when agent is not running', async () => {
      await renderComponent(
        <AgentControls agentName="drifter-gale" agent={createMockAgentStatus({ llmRunning: false })} />
      );
      expect(screen.getByText('Start')).toBeInTheDocument();
    });

    it('shows Stop button when agent is running', async () => {
      await renderComponent(
        <AgentControls agentName="drifter-gale" agent={createMockAgentStatus({ llmRunning: true })} />
      );
      expect(screen.getByText('Stop')).toBeInTheDocument();
    });

    it('shows Shutdown button when running with no shutdown in progress', async () => {
      await renderComponent(
        <AgentControls
          agentName="drifter-gale"
          agent={createMockAgentStatus({ llmRunning: true, shutdownState: 'none' })}
        />
      );
      expect(screen.getByText('Shutdown')).toBeInTheDocument();
    });

    it('hides Shutdown button when shutdown already in progress', async () => {
      await renderComponent(
        <AgentControls
          agentName="drifter-gale"
          agent={createMockAgentStatus({ llmRunning: true, shutdownState: 'draining' })}
        />
      );
      expect(screen.queryByText('Shutdown')).not.toBeInTheDocument();
    });
  });

  // ── Process Controls ─────────────────────────────────────────────────────

  describe('process controls', () => {
    it('calls start endpoint when Start clicked', async () => {
      await renderComponent(
        <AgentControls agentName="drifter-gale" agent={createMockAgentStatus({ llmRunning: false })} />
      );
      const startBtn = screen.getByText('Start');
      await act(async () => { fireEvent.click(startBtn); });
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/agents/drifter-gale/start',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('calls stop endpoint when Stop clicked', async () => {
      await renderComponent(
        <AgentControls agentName="drifter-gale" agent={createMockAgentStatus({ llmRunning: true })} />
      );
      await act(async () => { fireEvent.click(screen.getByText('Stop')); });
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/agents/drifter-gale/stop',
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('calls restart endpoint when Restart clicked', async () => {
      await renderComponent(
        <AgentControls agentName="drifter-gale" agent={createMockAgentStatus({ llmRunning: true })} />
      );
      await act(async () => { fireEvent.click(screen.getByText('Restart')); });
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/agents/drifter-gale/restart',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ── Send Order ───────────────────────────────────────────────────────────

  describe('send order', () => {
    it('Send Order button is disabled when message is empty', async () => {
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      expect(screen.getByText('Send Order')).toBeDisabled();
    });

    it('shows success message after sending order', async () => {
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      const textarea = screen.getByPlaceholderText('Enter order for this agent…');
      fireEvent.change(textarea, { target: { value: 'Mine iron' } });
      await act(async () => { fireEvent.click(screen.getByText('Send Order')); });
      await waitFor(() => expect(screen.getByText('Order queued for delivery.')).toBeInTheDocument());
    });
  });

  // ── Trigger Routine ──────────────────────────────────────────────────────

  describe('trigger routine', () => {
    it('shows routines in dropdown after fetch', async () => {
      setupDefaultMock(['sell_cycle', 'mining_loop']);
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      await waitFor(() => expect(screen.getByText('sell cycle')).toBeInTheDocument());
    });

    it('shows confirmation dialog when Execute Routine clicked', async () => {
      setupDefaultMock(['sell_cycle']);
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      await waitFor(() => screen.getByText('Execute Routine'));
      fireEvent.click(screen.getByText('Execute Routine'));
      expect(screen.getByText('Confirm')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('hides confirmation dialog when Cancel clicked', async () => {
      setupDefaultMock(['sell_cycle']);
      await renderComponent(<AgentControls agentName="drifter-gale" agent={null} />);
      await waitFor(() => screen.getByText('Execute Routine'));
      fireEvent.click(screen.getByText('Execute Routine'));
      fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByText('Confirm')).not.toBeInTheDocument();
    });
  });
});
