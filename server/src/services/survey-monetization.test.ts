/**
 * Unit tests for the survey-monetization parser.
 *
 * Most logic lives in pure helpers (matchSurveyTag, extractTitleFromArgs,
 * classifyRow). We seed an in-memory database for the aggregate-shape tests
 * to validate the SQL/JS contract end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { createDatabase, closeDb, getDb } from './database.js';
import {
  matchSurveyTag,
  expectedAgentFor,
  classifyRow,
  getSurveyMonetizationReport,
  getSurveyMonetizationBySession,
  SURVEY_TAG_SPECS,
  __test__,
} from './survey-monetization.js';

const { extractTitleFromArgs } = __test__;

// ---------------------------------------------------------------------------
// Pure helpers — run without a DB
// ---------------------------------------------------------------------------

describe('matchSurveyTag', () => {
  it('matches the canonical INTEL title', () => {
    const r = matchSurveyTag('INTEL-SIRIUS-2026-04-27');
    expect(r).toEqual({ prefix: 'INTEL-', region: 'SIRIUS', date: '2026-04-27' });
  });

  it('matches the canonical BELT-REPORT title', () => {
    const r = matchSurveyTag('BELT-REPORT-VEGA-2026-05-01');
    expect(r).toEqual({ prefix: 'BELT-REPORT-', region: 'VEGA', date: '2026-05-01' });
  });

  it('accepts underscores in region (NEXUS_CORE)', () => {
    const r = matchSurveyTag('INTEL-NEXUS_CORE-2026-05-06');
    expect(r?.region).toBe('NEXUS_CORE');
  });

  it('still matches when the date suffix is missing', () => {
    // Off-format but the prompt-target prefix is intact — count as attempt.
    const r = matchSurveyTag('INTEL-SIRIUS');
    expect(r).toEqual({ prefix: 'INTEL-', region: 'SIRIUS', date: null });
  });

  it('normalizes prefix casing to upper', () => {
    const r = matchSurveyTag('intel-sirius-2026-04-27');
    expect(r?.prefix).toBe('INTEL-');
  });

  it('rejects unrelated titles', () => {
    expect(matchSurveyTag('analyze_market')).toBeNull();
    expect(matchSurveyTag('')).toBeNull();
    expect(matchSurveyTag('mission: deliver iron')).toBeNull();
  });

  it('captures permissive prefix matches; classifyRow contextualizes them', () => {
    // Off-by-one regression guard — the live DB had one spurious hit on
    // rust-vane's prose ("intel-gathering session"). The matcher captures
    // the prefix; classifyRow drops __reasoning rows so prose mentions
    // never count as a tagged note attempt.
    const r = matchSurveyTag('intel-gathering session');
    expect(r?.prefix).toBe('INTEL-');
    expect(r?.region?.toUpperCase()).toBe('GATHERING');
  });
});

describe('expectedAgentFor', () => {
  it('maps INTEL- to drifter-gale', () => {
    expect(expectedAgentFor('INTEL-')).toBe('drifter-gale');
  });
  it('maps BELT-REPORT- to lumen-shoal', () => {
    expect(expectedAgentFor('BELT-REPORT-')).toBe('lumen-shoal');
  });
  it('returns null for unknown prefix', () => {
    expect(expectedAgentFor('OTHER-')).toBeNull();
  });
});

describe('SURVEY_TAG_SPECS contract', () => {
  // If you change this you almost certainly need to update the agent prompts.
  it('has both expected agents at their pinned prices', () => {
    expect(SURVEY_TAG_SPECS).toHaveLength(2);
    const drifter = SURVEY_TAG_SPECS.find((s) => s.agent === 'drifter-gale');
    const lumen   = SURVEY_TAG_SPECS.find((s) => s.agent === 'lumen-shoal');
    expect(drifter).toEqual({ agent: 'drifter-gale', prefix: 'INTEL-',       targetPrice: 1000 });
    expect(lumen).toEqual(  { agent: 'lumen-shoal',  prefix: 'BELT-REPORT-', targetPrice: 500 });
  });
});

describe('extractTitleFromArgs', () => {
  it('parses JSON-shaped args from logToolCall', () => {
    const got = extractTitleFromArgs(JSON.stringify({ title: 'INTEL-SIRIUS-2026-04-27', price: 1000 }));
    expect(got).toEqual({ title: 'INTEL-SIRIUS-2026-04-27', price: 1000 });
  });

  it('parses the v2 dispatcher key=value snippet', () => {
    const got = extractTitleFromArgs('title="INTEL-SIRIUS-2026-04-27", price=1000');
    expect(got).toEqual({ title: 'INTEL-SIRIUS-2026-04-27', price: 1000 });
  });

  it('handles truncated JSON gracefully', () => {
    // logToolCall truncates args_summary at 1000 chars — verify we degrade
    // to the regex path rather than throwing.
    const truncated = '{"title":"BELT-REPORT-VEGA-2026-05-01","price":500,"long_field":"' + 'x'.repeat(100);
    const got = extractTitleFromArgs(truncated);
    expect(got.title).toBe('BELT-REPORT-VEGA-2026-05-01');
    expect(got.price).toBe(500);
  });

  it('returns nulls when nothing matches', () => {
    expect(extractTitleFromArgs(null)).toEqual({ title: null, price: null });
    expect(extractTitleFromArgs('')).toEqual({ title: null, price: null });
    expect(extractTitleFromArgs('this is just noise')).toEqual({ title: null, price: null });
  });

  it('coerces numeric string price to number', () => {
    const got = extractTitleFromArgs(JSON.stringify({ title: 'INTEL-X-2026-05-06', price: '1000' }));
    expect(got.price).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// classifyRow — operates on a row shape, no DB needed
// ---------------------------------------------------------------------------

describe('classifyRow', () => {
  function makeRow(overrides: Partial<{
    id: number;
    agent: string;
    tool_name: string;
    args_summary: string | null;
    result_summary: string | null;
    success: number;
    error_code: string | null;
    created_at: string;
  }> = {}) {
    return {
      id: 1,
      agent: 'drifter-gale',
      tool_name: 'create_note',
      args_summary: null,
      result_summary: null,
      success: 1,
      error_code: null,
      created_at: '2026-05-06T12:00:00Z',
      ...overrides,
    };
  }

  it('classifies a successful drifter-gale INTEL post', () => {
    const r = classifyRow(makeRow({
      args_summary: JSON.stringify({ title: 'INTEL-SIRIUS-2026-04-27', price: 1000 }),
    }));
    expect(r).toMatchObject({
      recordedAgent: 'drifter-gale',
      prefix: 'INTEL-',
      taggedFor: 'drifter-gale',
      region: 'SIRIUS',
      tagDate: '2026-04-27',
      title: 'INTEL-SIRIUS-2026-04-27',
      price: 1000,
      success: true,
      sold: null,
      salePrice: null,
    });
  });

  it('classifies a successful lumen-shoal BELT-REPORT post', () => {
    const r = classifyRow(makeRow({
      agent: 'lumen-shoal',
      args_summary: JSON.stringify({ title: 'BELT-REPORT-VEGA-2026-05-01', price: 500 }),
    }));
    expect(r?.taggedFor).toBe('lumen-shoal');
    expect(r?.prefix).toBe('BELT-REPORT-');
  });

  it('flags a misuse: drifter-gale posting a BELT-REPORT', () => {
    const r = classifyRow(makeRow({
      agent: 'drifter-gale',
      args_summary: JSON.stringify({ title: 'BELT-REPORT-VEGA-2026-05-01', price: 500 }),
    }));
    expect(r?.recordedAgent).toBe('drifter-gale');
    expect(r?.taggedFor).toBe('lumen-shoal');
  });

  it('marks failed calls with success=false', () => {
    const r = classifyRow(makeRow({
      success: 0,
      error_code: 'denied',
      args_summary: JSON.stringify({ title: 'INTEL-X-2026-05-06', price: 1000 }),
    }));
    expect(r?.success).toBe(false);
    expect(r?.errorCode).toBe('denied');
  });

  it('detects sold-state from result_summary tokens', () => {
    const r = classifyRow(makeRow({
      args_summary: JSON.stringify({ title: 'INTEL-X-2026-05-06', price: 1000 }),
      result_summary: '{"id":"note-42","sold":true,"sale_price":1000,"buyer_id":"player-7"}',
    }));
    expect(r?.sold).toBe(true);
    expect(r?.salePrice).toBe(1000);
  });

  it('detects unsold-state from "listed" status', () => {
    const r = classifyRow(makeRow({
      args_summary: JSON.stringify({ title: 'INTEL-X-2026-05-06', price: 1000 }),
      result_summary: '{"id":"note-9","status":"listed","price":1000}',
    }));
    expect(r?.sold).toBe(false);
  });

  it('drops __reasoning rows so prose mentions of INTEL- do not inflate the count', () => {
    // This was a real regression — rust-vane wrote "intel-gathering session"
    // in __assistant_text and the broad SQL filter pulled it in.
    const r = classifyRow(makeRow({
      tool_name: '__assistant_text',
      result_summary: 'INTEL-GATHERING was the theme today',
    }));
    expect(r).toBeNull();
  });

  it('drops rows with no extractable title', () => {
    const r = classifyRow(makeRow({
      tool_name: 'create_note',
      args_summary: '{"price":1000}',
    }));
    expect(r).toBeNull();
  });

  it('drops rows where the title prefix is unrelated', () => {
    const r = classifyRow(makeRow({
      args_summary: JSON.stringify({ title: 'random-title-2026-05-06', price: 100 }),
    }));
    expect(r).toBeNull();
  });

  it('does NOT fall back to result_summary for get_notes (read paths cannot count as posts)', () => {
    const r = classifyRow(makeRow({
      tool_name: 'get_notes',
      args_summary: '{}',
      result_summary: '[{"id":"note-1","title":"BELT-REPORT-VEGA-2026-05-01","price":500}]',
    }));
    expect(r).toBeNull();
  });

  it('falls back to result_summary for create_note when args has no title', () => {
    // create_note responses sometimes echo the persisted title in the result
    // even when args_summary is truncated or missing the title field.
    const r = classifyRow(makeRow({
      tool_name: 'create_note',
      args_summary: '{}',
      result_summary: '{"id":"note-1","title":"BELT-REPORT-VEGA-2026-05-01","price":500}',
    }));
    expect(r?.prefix).toBe('BELT-REPORT-');
  });
});

// ---------------------------------------------------------------------------
// getSurveyMonetizationReport — DB-backed integration
// ---------------------------------------------------------------------------

describe('getSurveyMonetizationReport', () => {
  beforeAll(() => {
    createDatabase(':memory:');
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    // Wipe between tests so cases are independent.
    getDb().run('DELETE FROM proxy_tool_calls');
  });

  function insertCall(opts: {
    agent: string;
    tool_name: string;
    args_summary?: string | null;
    result_summary?: string | null;
    success?: number;
    error_code?: string | null;
    created_at?: string;
  }) {
    getDb()
      .prepare(`
        INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, error_code, created_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        opts.agent,
        opts.tool_name,
        opts.args_summary ?? null,
        opts.result_summary ?? null,
        opts.success ?? 1,
        opts.error_code ?? null,
        opts.created_at ?? new Date().toISOString(),
        opts.created_at ?? new Date().toISOString(),
      );
  }

  it('returns zero rows for both spec agents when DB is empty (the live state today)', () => {
    const report = getSurveyMonetizationReport({ hours: 168 });
    expect(report.agents).toHaveLength(2);
    for (const a of report.agents) {
      expect(a.notesPosted).toBe(0);
      expect(a.notesPosted24h).toBe(0);
      expect(a.sellThroughRate).toBeNull();
      expect(a.totalCreditsEarned).toBe(0);
      expect(a.lastPostedAt).toBeNull();
    }
    expect(report.recent).toHaveLength(0);
  });

  it('counts a happy-path drifter-gale post', () => {
    insertCall({
      agent: 'drifter-gale',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'INTEL-SIRIUS-2026-04-27', price: 1000 }),
    });
    const report = getSurveyMonetizationReport({ hours: 24 });
    const drifter = report.agents.find((a) => a.agent === 'drifter-gale')!;
    expect(drifter.notesPosted).toBe(1);
    expect(drifter.notesPosted24h).toBe(1);
    expect(drifter.notesPostedSuccessful).toBe(1);
    expect(drifter.lastPostedAt).not.toBeNull();
    expect(report.recent[0].title).toBe('INTEL-SIRIUS-2026-04-27');
  });

  it('respects the hours window — older rows excluded', () => {
    const oldTs = new Date(Date.now() - 72 * 3600 * 1000).toISOString(); // 3 days ago
    insertCall({
      agent: 'drifter-gale',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'INTEL-OLD-2026-04-01', price: 1000 }),
      created_at: oldTs,
    });
    const report = getSurveyMonetizationReport({ hours: 24 });
    expect(report.agents.find((a) => a.agent === 'drifter-gale')!.notesPosted).toBe(0);

    const wide = getSurveyMonetizationReport({ hours: 168 });
    expect(wide.agents.find((a) => a.agent === 'drifter-gale')!.notesPosted).toBe(1);
  });

  it('separates drifter-gale and lumen-shoal counts by tag prefix', () => {
    insertCall({
      agent: 'drifter-gale',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'INTEL-X-2026-05-06', price: 1000 }),
    });
    insertCall({
      agent: 'lumen-shoal',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'BELT-REPORT-Y-2026-05-06', price: 500 }),
    });
    const report = getSurveyMonetizationReport({ hours: 24 });
    expect(report.agents.find((a) => a.agent === 'drifter-gale')!.notesPosted).toBe(1);
    expect(report.agents.find((a) => a.agent === 'lumen-shoal')!.notesPosted).toBe(1);
  });

  it('computes sell-through and credits earned when result data is present', () => {
    insertCall({
      agent: 'drifter-gale',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'INTEL-X-2026-05-06', price: 1000 }),
      result_summary: '{"id":"n1","sold":true,"sale_price":1000,"buyer_id":"p2"}',
    });
    insertCall({
      agent: 'drifter-gale',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'INTEL-Y-2026-05-06', price: 1000 }),
      result_summary: '{"id":"n2","status":"listed","price":1000}',
    });
    const report = getSurveyMonetizationReport({ hours: 24 });
    const drifter = report.agents.find((a) => a.agent === 'drifter-gale')!;
    expect(drifter.notesPosted).toBe(2);
    expect(drifter.sellThroughRate).toBeCloseTo(0.5, 5);
    expect(drifter.totalCreditsEarned).toBe(1000);
  });

  it('does not inflate count from prose-only mentions in __reasoning', () => {
    insertCall({
      agent: 'rust-vane',
      tool_name: '__reasoning',
      result_summary: 'plan: gather INTEL-on-station, reach out to drifter',
    });
    const report = getSurveyMonetizationReport({ hours: 168 });
    expect(report.agents.every((a) => a.notesPosted === 0)).toBe(true);
  });

  it('scopes to a single agent when opts.agent is set', () => {
    insertCall({
      agent: 'drifter-gale',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'INTEL-X-2026-05-06', price: 1000 }),
    });
    insertCall({
      agent: 'lumen-shoal',
      tool_name: 'create_note',
      args_summary: JSON.stringify({ title: 'BELT-REPORT-Y-2026-05-06', price: 500 }),
    });
    const r = getSurveyMonetizationReport({ hours: 24, agent: 'drifter-gale' });
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0].agent).toBe('drifter-gale');
    expect(r.recent.every((n) => n.recordedAgent === 'drifter-gale')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-session bucketing
// ---------------------------------------------------------------------------

describe('getSurveyMonetizationBySession', () => {
  beforeAll(() => {
    createDatabase(':memory:');
  });

  afterAll(() => {
    closeDb();
  });

  beforeEach(() => {
    getDb().run('DELETE FROM proxy_tool_calls');
    getDb().run('DELETE FROM session_handoffs');
  });

  function insertCall(opts: {
    agent: string;
    title: string;
    price?: number;
    result_summary?: string | null;
    success?: number;
    created_at?: string;
  }) {
    const ts = opts.created_at ?? new Date().toISOString();
    getDb()
      .prepare(`
        INSERT INTO proxy_tool_calls (agent, tool_name, args_summary, result_summary, success, created_at, timestamp)
        VALUES (?, 'create_note', ?, ?, ?, ?, ?)
      `)
      .run(
        opts.agent,
        JSON.stringify({ title: opts.title, price: opts.price ?? 1000 }),
        opts.result_summary ?? null,
        opts.success ?? 1,
        ts,
        ts,
      );
  }

  function insertHandoff(agent: string, created_at: string) {
    getDb()
      .prepare(`INSERT INTO session_handoffs (agent, created_at) VALUES (?, ?)`)
      .run(agent, created_at);
  }

  it('with no handoffs, emits one open bucket per spec agent', () => {
    const sessions = getSurveyMonetizationBySession({ hours: 168 });
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      expect(s.sessionStart).toBeNull();
      expect(s.sessionEnd).toBeNull();
      expect(s.notesPosted).toBe(0);
      expect(s.meetsTarget).toBe(false);
    }
  });

  it('counts a note in the current open session and flips meetsTarget', () => {
    insertCall({ agent: 'drifter-gale', title: 'INTEL-SIRIUS-2026-05-12' });
    const sessions = getSurveyMonetizationBySession({ hours: 24 });
    const open = sessions.find((s) => s.agent === 'drifter-gale' && s.sessionEnd === null)!;
    expect(open.notesPosted).toBe(1);
    expect(open.notesPostedSuccessful).toBe(1);
    expect(open.meetsTarget).toBe(true);
    // lumen-shoal's open bucket stays at zero.
    const lumenOpen = sessions.find((s) => s.agent === 'lumen-shoal' && s.sessionEnd === null)!;
    expect(lumenOpen.notesPosted).toBe(0);
    expect(lumenOpen.meetsTarget).toBe(false);
  });

  it('splits notes across closed and open session windows by handoff timestamps', () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
    // Two handoffs: at -36h and -12h => windows: (<-36h), (-36h..-12h closed), (-12h..now open)
    insertHandoff('drifter-gale', hoursAgo(36));
    insertHandoff('drifter-gale', hoursAgo(12));
    // One note in the closed -36h..-12h session, two in the open one.
    insertCall({ agent: 'drifter-gale', title: 'INTEL-A-2026-05-11', created_at: hoursAgo(24) });
    insertCall({ agent: 'drifter-gale', title: 'INTEL-B-2026-05-12', created_at: hoursAgo(6) });
    insertCall({ agent: 'drifter-gale', title: 'INTEL-C-2026-05-12', created_at: hoursAgo(1) });

    const sessions = getSurveyMonetizationBySession({ hours: 168, agent: 'drifter-gale' });
    const open = sessions.find((s) => s.sessionEnd === null)!;
    expect(open.notesPosted).toBe(2);
    const closed = sessions.find((s) => s.sessionStart !== null && s.sessionEnd !== null)!;
    expect(closed.notesPosted).toBe(1);
    // Newest session first.
    expect(sessions[0].sessionEnd).toBeNull();
  });

  it('tallies sales detected and credits earned per session window', () => {
    insertCall({
      agent: 'lumen-shoal',
      title: 'BELT-REPORT-VEGA-2026-05-12',
      price: 500,
      result_summary: '{"id":"n1","sold":true,"sale_price":500,"buyer_id":"p9"}',
    });
    insertCall({
      agent: 'lumen-shoal',
      title: 'BELT-REPORT-WOLF-2026-05-12',
      price: 500,
      result_summary: '{"id":"n2","status":"listed","price":500}',
    });
    const sessions = getSurveyMonetizationBySession({ hours: 24, agent: 'lumen-shoal' });
    const open = sessions.find((s) => s.sessionEnd === null)!;
    expect(open.notesPosted).toBe(2);
    expect(open.salesDetected).toBe(1);
    expect(open.creditsEarned).toBe(500);
  });

  it('attributes a misposted tag to the prefix owner, not the caller', () => {
    // drifter-gale posts a BELT-REPORT-* — should land in lumen-shoal's timeline.
    insertCall({ agent: 'drifter-gale', title: 'BELT-REPORT-X-2026-05-12', price: 500 });
    const sessions = getSurveyMonetizationBySession({ hours: 24 });
    const lumenOpen = sessions.find((s) => s.agent === 'lumen-shoal' && s.sessionEnd === null)!;
    expect(lumenOpen.notesPosted).toBe(1);
    const drifterOpen = sessions.find((s) => s.agent === 'drifter-gale' && s.sessionEnd === null)!;
    expect(drifterOpen.notesPosted).toBe(0);
  });

  it('is reachable from the headline report as report.sessions', () => {
    insertCall({ agent: 'drifter-gale', title: 'INTEL-Z-2026-05-12' });
    const report = getSurveyMonetizationReport({ hours: 24 });
    expect(Array.isArray(report.sessions)).toBe(true);
    const open = report.sessions.find((s) => s.agent === 'drifter-gale' && s.sessionEnd === null)!;
    expect(open.notesPosted).toBe(1);
  });
});
