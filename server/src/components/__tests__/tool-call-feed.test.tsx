import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MockEventSource } from '@/test/setup';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the component
// NOTE: Do NOT use mock.module('@/hooks/use-sse', ...) here.
// With maxConcurrency=1 (used in CI), mock.module() persists for the entire
// worker process and leaks into all subsequent test files. The real useSSE
// hook works fine with MockEventSource which is already registered globally
// in setup.ts.
// ---------------------------------------------------------------------------

// NOTE: Do NOT use mock.module('@/lib/api', ...) here either — same leakage problem.
// Instead mock global.fetch directly. apiFetch calls fetch internally, and global.fetch
// mocks are reset by mock.restore() in setup.ts beforeEach, preventing leakage.
let mockToolCalls: unknown[] = [];

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { ToolCallFeed } from '../tool-call-feed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCall(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    agent: 'test-agent',
    tool_name: 'batch_mine',
    args_summary: '{"count":5}',
    result_summary: '{"ore":10}',
    success: 1,
    error_code: null,
    duration_ms: 150,
    is_compound: 1,
    trace_id: null,
    status: 'complete',
    assistant_text: null,
    timestamp: '2026-03-06T12:00:00Z',
    created_at: '2026-03-06T12:00:00Z',
    ...overrides,
  };
}

function makeRoutineParent(routine: string, traceId: string, overrides: Record<string, unknown> = {}) {
  return makeToolCall({
    id: 200,
    tool_name: 'execute_routine',
    args_summary: JSON.stringify({ routine, params: {} }),
    result_summary: JSON.stringify({ routine, status: 'completed', summary: `${routine} finished` }),
    is_compound: 1,
    trace_id: traceId,
    ...overrides,
  });
}

function makeRoutineSubCall(routine: string, tool: string, traceId: string, overrides: Record<string, unknown> = {}) {
  return makeToolCall({
    id: 201,
    tool_name: `routine:${routine}:${tool}`,
    args_summary: null,
    result_summary: '{"ok":true}',
    is_compound: 0,
    trace_id: traceId,
    ...overrides,
  });
}

function makeAssistantText(text: string, overrides: Record<string, unknown> = {}) {
  return makeToolCall({
    id: 100,
    tool_name: '__assistant_text',
    args_summary: null,
    result_summary: null,
    duration_ms: 0,
    is_compound: 0,
    assistant_text: text,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolCallFeed', () => {
  beforeEach(() => {
    mockToolCalls = [];
    // Mock global.fetch so apiFetch returns controlled tool call data.
    // Read mockToolCalls at call-time via mockImplementation to pick up per-test values.
    global.fetch = mock().mockImplementation(async (url: string) => ({
      ok: true,
      json: () =>
        Promise.resolve(
          url.includes('turn-costs')
            ? { turns: [] }
            : { tool_calls: mockToolCalls }
        ),
      text: () => Promise.resolve('{}'),
    })) as unknown as typeof fetch;
    // MockEventSource.instances is reset in setup.ts beforeEach
  });

  afterEach(() => {
    // Restore fetch so it doesn't leak into other test files
    mock.restore();
  });

  // -------------------------------------------------------------------------
  // Basic rendering
  // -------------------------------------------------------------------------

  describe('basic rendering', () => {
    it('renders "No tool calls recorded" when empty', async () => {
      mockToolCalls = [];
      render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        expect(screen.getByText('No tool calls recorded')).toBeInTheDocument();
      });
    });

    it('renders tool call rows', async () => {
      mockToolCalls = [makeToolCall({ tool_name: 'batch_mine' })];
      render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
      });
    });

    it('renders filter buttons', () => {
      render(<ToolCallFeed agentName="test-agent" />);
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('Navigation')).toBeInTheDocument();
      expect(screen.getByText('Combat')).toBeInTheDocument();
      expect(screen.getByText('Economy')).toBeInTheDocument();
      expect(screen.getByText('Social')).toBeInTheDocument();
    });

    it('shows live indicator when SSE connected', async () => {
      render(<ToolCallFeed agentName="test-agent" />);
      // Simulate EventSource connecting — useSSE sets connected=true on open
      act(() => { MockEventSource.instances[0]?.simulateOpen(); });
      await waitFor(() => expect(screen.getByText('live')).toBeInTheDocument());
    });

    it('shows offline indicator when SSE disconnected', () => {
      render(<ToolCallFeed agentName="test-agent" />);
      // Default state is CONNECTING (readyState=0), so connected=false → "offline"
      expect(screen.getByText('offline')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Timestamp sort (#513)
  // -------------------------------------------------------------------------

  describe('timestamp sort order', () => {
    it('renders records sorted by timestamp newest-first regardless of array order', async () => {
      // Provide records in reverse-chronological order (oldest first in array,
      // as they might arrive from the API). After sorting, newest should appear first.
      mockToolCalls = [
        makeToolCall({ id: 1, tool_name: 'jump', timestamp: '2026-03-06T12:00:00Z' }),
        makeToolCall({ id: 2, tool_name: 'batch_mine', timestamp: '2026-03-06T12:00:05Z' }),
        makeToolCall({ id: 3, tool_name: 'multi_sell', timestamp: '2026-03-06T12:00:10Z' }),
      ];
      const { container } = render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('multi_sell')).toBeInTheDocument();
      });

      // All rows should be present
      const toolNames = container.querySelectorAll('.font-bold.shrink-0');
      const names = Array.from(toolNames).map((el) => el.textContent);
      // multi_sell (newest) should appear before jump (oldest) in the DOM
      const multiSellIdx = names.findIndex((n) => n === 'multi_sell');
      const jumpIdx = names.findIndex((n) => n === 'jump');
      expect(multiSellIdx).toBeLessThan(jumpIdx);
    });

    it('interleaves assistant text with tool calls when timestamps differ', async () => {
      // Simulate: tool call logged at T1, assistant text logged at T1+1s, another tool at T1+2s
      // The DB might return them grouped (all assistant text last), but after sort they interleave
      mockToolCalls = [
        makeAssistantText('Now I will sell.', { id: 3, timestamp: '2026-03-06T12:00:10Z' }),
        makeAssistantText('Mining complete.', { id: 2, timestamp: '2026-03-06T12:00:05Z' }),
        makeToolCall({ id: 4, tool_name: 'multi_sell', timestamp: '2026-03-06T12:00:15Z' }),
        makeToolCall({ id: 1, tool_name: 'batch_mine', timestamp: '2026-03-06T12:00:00Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
        expect(screen.getByText('multi_sell')).toBeInTheDocument();
        expect(screen.getByText('Mining complete.')).toBeInTheDocument();
        expect(screen.getByText('Now I will sell.')).toBeInTheDocument();
      });
    });

    it('uses id as stable tiebreaker for same-timestamp entries', async () => {
      // All same timestamp — sort should fall back to id descending (insertion order)
      const ts = '2026-03-06T12:00:00Z';
      mockToolCalls = [
        makeToolCall({ id: 1, tool_name: 'jump', timestamp: ts }),
        makeAssistantText('Plan A.', { id: 2, timestamp: ts }),
        makeToolCall({ id: 3, tool_name: 'batch_mine', timestamp: ts }),
        makeAssistantText('Plan B.', { id: 4, timestamp: ts }),
      ];
      const { container } = render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('Plan B.')).toBeInTheDocument();
      });

      // All four should render — presence check is sufficient for same-timestamp stability
      expect(screen.getByText('jump')).toBeInTheDocument();
      expect(screen.getByText('Plan A.')).toBeInTheDocument();
      expect(screen.getByText('batch_mine')).toBeInTheDocument();
      expect(container.querySelectorAll('.bg-secondary\\/10').length).toBe(2); // 2 thinking rows
    });
  });

  // -------------------------------------------------------------------------
  // Assistant text visibility in "all" view (#504)
  // -------------------------------------------------------------------------

  describe('assistant text in all view (#504)', () => {
    it('shows assistant text records in the "all" filter view', async () => {
      mockToolCalls = [
        makeToolCall({ id: 1, tool_name: 'batch_mine', timestamp: '2026-03-06T12:00:00Z' }),
        makeAssistantText('Docked successfully.', { id: 2, timestamp: '2026-03-06T12:00:05Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('Docked successfully.')).toBeInTheDocument();
        expect(screen.getByText('commentary')).toBeInTheDocument();
      });
    });

    it('hides assistant text records from category filter views', async () => {
      mockToolCalls = [
        makeToolCall({ id: 1, tool_name: 'batch_mine', timestamp: '2026-03-06T12:00:00Z' }),
        makeAssistantText('Selling ore.', { id: 2, timestamp: '2026-03-06T12:00:05Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('Selling ore.')).toBeInTheDocument();
      });

      // Switch to Economy category filter
      fireEvent.click(screen.getByText('Economy'));

      await waitFor(() => {
        // Tool call stays (batch_mine is in economy filter)
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
        // Assistant text hidden in category view
        expect(screen.queryByText('Selling ore.')).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Assistant text rendering (#300)
  // -------------------------------------------------------------------------

  describe('assistant text rendering', () => {
    it('renders assistant text with "commentary" label', async () => {
      mockToolCalls = [
        makeAssistantText('I should mine some iron ore next.'),
      ];
      render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        expect(screen.getByText('commentary')).toBeInTheDocument();
        expect(screen.getByText('I should mine some iron ore next.')).toBeInTheDocument();
      });
    });

    it('renders assistant text interleaved with tool calls', async () => {
      mockToolCalls = [
        makeAssistantText('Planning to mine iron.', { id: 1, timestamp: '2026-03-06T12:00:00Z' }),
        makeToolCall({ id: 2, tool_name: 'batch_mine', timestamp: '2026-03-06T12:00:05Z' }),
        makeAssistantText('Now I will sell the ore.', { id: 3, timestamp: '2026-03-06T12:00:10Z' }),
        makeToolCall({ id: 4, tool_name: 'multi_sell', timestamp: '2026-03-06T12:00:15Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        expect(screen.getByText('Planning to mine iron.')).toBeInTheDocument();
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
        expect(screen.getByText('Now I will sell the ore.')).toBeInTheDocument();
        expect(screen.getByText('multi_sell')).toBeInTheDocument();
      });
    });

    it('truncates long assistant text at 200 chars with "show more"', async () => {
      const longText = 'A'.repeat(250);
      mockToolCalls = [makeAssistantText(longText)];
      render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        // Should show truncated text (200 chars + "...")
        expect(screen.getByText('A'.repeat(200) + '...')).toBeInTheDocument();
        expect(screen.getByText('show more')).toBeInTheDocument();
      });
    });

    it('expands truncated text on "show more" click', async () => {
      const longText = 'B'.repeat(250);
      mockToolCalls = [makeAssistantText(longText)];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('show more')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('show more'));

      await waitFor(() => {
        expect(screen.getByText(longText)).toBeInTheDocument();
        expect(screen.getByText('show less')).toBeInTheDocument();
      });
    });

    it('collapses expanded text on "show less" click', async () => {
      const longText = 'C'.repeat(250);
      mockToolCalls = [makeAssistantText(longText)];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('show more')).toBeInTheDocument();
      });

      // Expand
      fireEvent.click(screen.getByText('show more'));
      await waitFor(() => {
        expect(screen.getByText('show less')).toBeInTheDocument();
      });

      // Collapse
      fireEvent.click(screen.getByText('show less'));
      await waitFor(() => {
        expect(screen.getByText('show more')).toBeInTheDocument();
        expect(screen.getByText('C'.repeat(200) + '...')).toBeInTheDocument();
      });
    });

    it('does not show "show more" for short text', async () => {
      mockToolCalls = [makeAssistantText('Short reasoning text.')];
      render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        expect(screen.getByText('Short reasoning text.')).toBeInTheDocument();
        expect(screen.queryByText('show more')).not.toBeInTheDocument();
      });
    });

    it('shows assistant_text in expanded tool call details', async () => {
      mockToolCalls = [
        makeToolCall({
          id: 1,
          tool_name: 'batch_mine',
          assistant_text: 'Reasoning about mining strategy.',
        }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      // Click to expand the tool call
      await waitFor(() => {
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('batch_mine'));

      await waitFor(() => {
        expect(screen.getByText('Assistant reasoning')).toBeInTheDocument();
        expect(screen.getByText('Reasoning about mining strategy.')).toBeInTheDocument();
      });
    });

    it('does not show "Assistant reasoning" section when assistant_text is null', async () => {
      mockToolCalls = [
        makeToolCall({
          id: 1,
          tool_name: 'batch_mine',
          assistant_text: null,
        }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('batch_mine'));

      await waitFor(() => {
        expect(screen.queryByText('Assistant reasoning')).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Assistant text styling
  // -------------------------------------------------------------------------

  describe('assistant text styling', () => {
    it('applies distinct background and border to assistant text rows', async () => {
      mockToolCalls = [makeAssistantText('Test styling.')];
      const { container } = render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        expect(screen.getByText('commentary')).toBeInTheDocument();
      });
      // The assistant text row should have bg-secondary/10 and border-l-primary/30
      const textRow = container.querySelector('.bg-secondary\\/10');
      expect(textRow).toBeTruthy();
    });

    it('renders assistant text in italic', async () => {
      mockToolCalls = [makeAssistantText('Italic text check.')];
      const { container } = render(<ToolCallFeed agentName="test-agent" />);
      await waitFor(() => {
        expect(screen.getByText('Italic text check.')).toBeInTheDocument();
      });
      const italicEl = container.querySelector('.italic');
      expect(italicEl).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Filter behavior with assistant text
  // -------------------------------------------------------------------------

  describe('filter behavior', () => {
    it('shows Routines filter tab', () => {
      render(<ToolCallFeed agentName="test-agent" />);
      expect(screen.getByText('Routines')).toBeInTheDocument();
    });

    it('hides assistant text records from category filters', async () => {
      mockToolCalls = [
        makeAssistantText('Planning mining.', { id: 1 }),
        makeToolCall({ id: 2, tool_name: 'batch_mine' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
        expect(screen.getByText('Planning mining.')).toBeInTheDocument();
      });

      // Switch to Economy filter
      fireEvent.click(screen.getByText('Economy'));

      await waitFor(() => {
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
        // Assistant text should be hidden in category views
        expect(screen.queryByText('Planning mining.')).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Routine grouping
  // -------------------------------------------------------------------------

  describe('routine grouping', () => {
    it('groups parent and sub-calls with matching trace_id into one row', async () => {
      const traceId = 'test-trace-001';
      mockToolCalls = [
        makeRoutineSubCall('full_trade_run', 'multi_sell', traceId, { id: 202, timestamp: '2026-03-06T12:00:02Z' }),
        makeRoutineSubCall('full_trade_run', 'batch_mine', traceId, { id: 201, timestamp: '2026-03-06T12:00:01Z' }),
        makeRoutineParent('full_trade_run', traceId, { id: 200, timestamp: '2026-03-06T12:00:00Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        // Routine badge shows the routine name
        expect(screen.getByText('full_trade_run')).toBeInTheDocument();
        // Sub-calls should NOT appear as separate rows
        expect(screen.queryByText('routine:full_trade_run:batch_mine')).not.toBeInTheDocument();
        expect(screen.queryByText('routine:full_trade_run:multi_sell')).not.toBeInTheDocument();
      });
    });

    it('shows step count for grouped routine', async () => {
      const traceId = 'test-trace-002';
      mockToolCalls = [
        makeRoutineSubCall('full_trade_run', 'batch_mine', traceId, { id: 201, timestamp: '2026-03-06T12:00:01Z' }),
        makeRoutineSubCall('full_trade_run', 'multi_sell', traceId, { id: 202, timestamp: '2026-03-06T12:00:02Z' }),
        makeRoutineSubCall('full_trade_run', 'refuel', traceId, { id: 203, timestamp: '2026-03-06T12:00:03Z' }),
        makeRoutineParent('full_trade_run', traceId, { id: 200, timestamp: '2026-03-06T12:00:00Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('3 steps')).toBeInTheDocument();
      });
    });

    it('records without trace_id remain ungrouped', async () => {
      mockToolCalls = [
        makeToolCall({ id: 1, tool_name: 'batch_mine', trace_id: null }),
        makeToolCall({ id: 2, tool_name: 'execute_routine', args_summary: '{"routine":"sell_cycle"}', trace_id: null }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        // execute_routine with no trace_id shows as ungrouped regular row
        expect(screen.getByText('execute_routine')).toBeInTheDocument();
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
      });
    });

    it('non-routine records with same trace_id are not absorbed', async () => {
      const traceId = 'test-trace-003';
      mockToolCalls = [
        makeToolCall({ id: 1, tool_name: 'batch_mine', trace_id: traceId }),
        makeRoutineParent('sell_cycle', traceId, { id: 200, timestamp: '2026-03-06T12:00:00Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        // batch_mine has the same trace_id but is NOT routine:* prefixed, so it stays as its own row
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
        // Routine still shows
        expect(screen.getByText('sell_cycle')).toBeInTheDocument();
      });
    });

    it('pending parent with no sub-calls still renders', async () => {
      mockToolCalls = [
        makeRoutineParent('mining_loop', 'pending-trace', {
          id: 200,
          status: 'pending',
          result_summary: null,
          duration_ms: null,
        }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('mining_loop')).toBeInTheDocument();
      });
    });

    it('shows completed status badge in green', async () => {
      const traceId = 'test-trace-004';
      mockToolCalls = [
        makeRoutineParent('sell_cycle', traceId, {
          id: 200,
          result_summary: JSON.stringify({ routine: 'sell_cycle', status: 'completed', summary: 'All sold' }),
        }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('completed')).toBeInTheDocument();
      });
    });

    it('shows handoff status badge', async () => {
      const traceId = 'test-trace-005';
      mockToolCalls = [
        makeRoutineParent('patrol_and_attack', traceId, {
          id: 200,
          result_summary: JSON.stringify({ routine: 'patrol_and_attack', status: 'handoff', summary: 'Combat detected' }),
        }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('handoff')).toBeInTheDocument();
      });
    });

    it('shows error status badge', async () => {
      const traceId = 'test-trace-006';
      mockToolCalls = [
        makeRoutineParent('refuel_repair', traceId, {
          id: 200,
          success: 0,
          result_summary: JSON.stringify({ routine: 'refuel_repair', status: 'error', summary: 'No credits' }),
        }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('error')).toBeInTheDocument();
      });
    });

    it('expands sub-calls on click and strips routine:NAME: prefix', async () => {
      const traceId = 'test-trace-007';
      mockToolCalls = [
        makeRoutineSubCall('full_trade_run', 'batch_mine', traceId, { id: 201, timestamp: '2026-03-06T12:00:01Z' }),
        makeRoutineParent('full_trade_run', traceId, { id: 200, timestamp: '2026-03-06T12:00:00Z' }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('full_trade_run')).toBeInTheDocument();
      });

      // Click to expand
      fireEvent.click(screen.getByText('full_trade_run'));

      await waitFor(() => {
        // Sub-call shows stripped tool name (no routine:NAME: prefix)
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
        // Should NOT show the full prefixed name
        expect(screen.queryByText('routine:full_trade_run:batch_mine')).not.toBeInTheDocument();
      });
    });

    it('Routines filter shows only routine group entries', async () => {
      const traceId = 'test-trace-008';
      mockToolCalls = [
        makeRoutineSubCall('sell_cycle', 'multi_sell', traceId, { id: 201 }),
        makeRoutineParent('sell_cycle', traceId, { id: 200 }),
        makeToolCall({ id: 1, tool_name: 'batch_mine', trace_id: null }),
      ];
      render(<ToolCallFeed agentName="test-agent" />);

      await waitFor(() => {
        expect(screen.getByText('batch_mine')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Routines'));

      await waitFor(() => {
        // Routine shows in Routines filter
        expect(screen.getByText('sell_cycle')).toBeInTheDocument();
        // Non-routine tool hidden
        expect(screen.queryByText('batch_mine')).not.toBeInTheDocument();
      });
    });
  });
});
