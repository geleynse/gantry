import { describe, it, expect } from 'bun:test';

// ---------------------------------------------------------------------------
// Types (mirrored from activity-feed.tsx to avoid Next.js import issues)
// ---------------------------------------------------------------------------

interface ActivityEvent {
  id: number;
  agent: string;
  tool_name: string;
  params_summary: string | null;
  result_summary: string | null;
  status: string;
  timestamp: string;
  duration_ms: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers extracted from the component for testability
// ---------------------------------------------------------------------------

type ToolFilter = "all" | "navigation" | "combat" | "economy" | "other";

const TOOL_CATEGORIES: Record<Exclude<ToolFilter, "all" | "other">, string[]> = {
  navigation: ["jump", "travel", "travel_to", "jump_route", "find_route", "get_map", "scan_local"],
  combat: ["scan_and_attack", "attack", "flee", "loot_wrecks"],
  economy: ["batch_mine", "multi_sell", "buy", "analyze_market", "get_missions", "mine", "sell"],
};

function classifyTool(toolName: string): Exclude<ToolFilter, "all"> {
  for (const [cat, tools] of Object.entries(TOOL_CATEGORIES) as Array<[Exclude<ToolFilter, "all" | "other">, string[]]>) {
    if (tools.some((t) => toolName === t || toolName.startsWith(t))) return cat;
  }
  return "other";
}

function matchesToolFilter(ev: ActivityEvent, filter: ToolFilter): boolean {
  if (filter === "all") return true;
  return classifyTool(ev.tool_name) === filter;
}

function sortByTimestamp(events: ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    if (ta !== tb) return tb - ta;
    return b.id - a.id;
  });
}

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 1,
    agent: 'drifter-gale',
    tool_name: 'mine',
    params_summary: null,
    result_summary: null,
    status: 'complete',
    timestamp: new Date().toISOString(),
    duration_ms: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: tool classification and filtering
// ---------------------------------------------------------------------------

describe('ActivityFeed — tool classification', () => {
  it('classifies navigation tools correctly', () => {
    expect(classifyTool('jump')).toBe('navigation');
    expect(classifyTool('travel_to')).toBe('navigation');
    expect(classifyTool('jump_route')).toBe('navigation');
    expect(classifyTool('scan_local')).toBe('navigation');
  });

  it('classifies combat tools correctly', () => {
    expect(classifyTool('attack')).toBe('combat');
    expect(classifyTool('scan_and_attack')).toBe('combat');
    expect(classifyTool('flee')).toBe('combat');
    expect(classifyTool('loot_wrecks')).toBe('combat');
  });

  it('classifies economy tools correctly', () => {
    expect(classifyTool('mine')).toBe('economy');
    expect(classifyTool('sell')).toBe('economy');
    expect(classifyTool('batch_mine')).toBe('economy');
    expect(classifyTool('analyze_market')).toBe('economy');
  });

  it('classifies unknown tools as other', () => {
    expect(classifyTool('write_diary')).toBe('other');
    expect(classifyTool('get_status')).toBe('other');
    expect(classifyTool('execute_routine')).toBe('other');
  });
});

describe('ActivityFeed — event filtering', () => {
  it('"all" filter passes every event', () => {
    const events = [
      makeEvent({ tool_name: 'mine', agent: 'drifter-gale' }),
      makeEvent({ tool_name: 'jump', agent: 'sable-thorn' }),
      makeEvent({ tool_name: 'write_diary', agent: 'rust-vane' }),
    ];
    const filtered = events.filter((ev) => matchesToolFilter(ev, 'all'));
    expect(filtered.length).toBe(3);
  });

  it('navigation filter shows only navigation tools', () => {
    const events = [
      makeEvent({ id: 1, tool_name: 'jump' }),
      makeEvent({ id: 2, tool_name: 'mine' }),
      makeEvent({ id: 3, tool_name: 'travel_to' }),
    ];
    const filtered = events.filter((ev) => matchesToolFilter(ev, 'navigation'));
    expect(filtered.length).toBe(2);
    expect(filtered.map((e) => e.tool_name)).toContain('jump');
    expect(filtered.map((e) => e.tool_name)).toContain('travel_to');
  });

  it('combat filter excludes economy and nav tools', () => {
    const events = [
      makeEvent({ id: 1, tool_name: 'attack' }),
      makeEvent({ id: 2, tool_name: 'mine' }),
      makeEvent({ id: 3, tool_name: 'jump' }),
    ];
    const filtered = events.filter((ev) => matchesToolFilter(ev, 'combat'));
    expect(filtered.length).toBe(1);
    expect(filtered[0].tool_name).toBe('attack');
  });
});

// ---------------------------------------------------------------------------
// Tests: sort order
// ---------------------------------------------------------------------------

describe('ActivityFeed — sort order', () => {
  it('sorts events newest first', () => {
    const events: ActivityEvent[] = [
      makeEvent({ id: 1, timestamp: '2026-03-07T10:00:00Z' }),
      makeEvent({ id: 3, timestamp: '2026-03-07T10:02:00Z' }),
      makeEvent({ id: 2, timestamp: '2026-03-07T10:01:00Z' }),
    ];
    const sorted = sortByTimestamp(events);
    expect(sorted[0].id).toBe(3);
    expect(sorted[1].id).toBe(2);
    expect(sorted[2].id).toBe(1);
  });

  it('uses id as tiebreaker for same-second events', () => {
    const ts = '2026-03-07T10:00:00Z';
    const events: ActivityEvent[] = [
      makeEvent({ id: 1, timestamp: ts }),
      makeEvent({ id: 5, timestamp: ts }),
      makeEvent({ id: 3, timestamp: ts }),
    ];
    const sorted = sortByTimestamp(events);
    // Higher id should come first (later insertion)
    expect(sorted[0].id).toBe(5);
    expect(sorted[1].id).toBe(3);
    expect(sorted[2].id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: event shape validation
// ---------------------------------------------------------------------------

describe('ActivityFeed — event shape', () => {
  it('event has all required fields', () => {
    const ev = makeEvent({
      id: 42,
      agent: 'cinder-wake',
      tool_name: 'sell',
      params_summary: '{"item":"copper_ore"}',
      result_summary: '{"sold":10}',
      status: 'complete',
      duration_ms: 850,
    });

    expect(ev.id).toBe(42);
    expect(ev.agent).toBe('cinder-wake');
    expect(ev.tool_name).toBe('sell');
    expect(ev.params_summary).toBe('{"item":"copper_ore"}');
    expect(ev.result_summary).toBe('{"sold":10}');
    expect(ev.status).toBe('complete');
    expect(ev.duration_ms).toBe(850);
  });

  it('pending events have null duration_ms', () => {
    const ev = makeEvent({ status: 'pending', duration_ms: null });
    expect(ev.status).toBe('pending');
    expect(ev.duration_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: Bug 5 — duration display: zero durations should not be shown
// ---------------------------------------------------------------------------

/** Mirror of the display condition fixed in activity-feed.tsx (Bug 5) */
function shouldShowDuration(ev: ActivityEvent): boolean {
  if (ev.status === 'pending') return false; // pending shows elapsed timer
  return ev.duration_ms != null && ev.duration_ms > 0;
}

describe('ActivityFeed — duration display condition (Bug 5)', () => {
  it('shows duration for positive duration_ms', () => {
    const ev = makeEvent({ status: 'complete', duration_ms: 42 });
    expect(shouldShowDuration(ev)).toBe(true);
  });

  it('does not show duration for zero duration_ms', () => {
    const ev = makeEvent({ status: 'complete', duration_ms: 0 });
    expect(shouldShowDuration(ev)).toBe(false);
  });

  it('does not show duration for null duration_ms', () => {
    const ev = makeEvent({ status: 'complete', duration_ms: null });
    expect(shouldShowDuration(ev)).toBe(false);
  });

  it('does not show duration for pending events (even with non-null duration_ms)', () => {
    const ev = makeEvent({ status: 'pending', duration_ms: 100 });
    expect(shouldShowDuration(ev)).toBe(false);
  });

  it('does not show duration for error events with zero duration_ms', () => {
    const ev = makeEvent({ status: 'error', duration_ms: 0 });
    expect(shouldShowDuration(ev)).toBe(false);
  });
});
