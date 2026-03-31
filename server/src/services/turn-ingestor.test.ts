import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase, getDb, closeDb } from './database.js';
import { ingestTurnFile, backfillAgent, addPostIngestHook, type PostIngestData } from './turn-ingestor.js';

/** Build a valid JSONL string with a tool_use/tool_result pair + result summary line. */
function makeTurnJsonl(cost: number): string {
  const toolUseId = 'toolu_test_001';
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: toolUseId, name: 'mcp__gantry__mine', input: { resource: 'iron' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: 'Mined 10 iron ore' },
        ],
      },
    }),
    JSON.stringify({
      type: 'result',
      total_cost_usd: cost,
      usage: {
        input_tokens: 4000,
        output_tokens: 1000,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 500,
      },
      num_turns: 2,
      duration_ms: 15000,
      model: 'claude-sonnet-4-20250514',
    }),
  ];
  return lines.join('\n');
}

describe('turn-ingestor', () => {
  let tempDir: string;

  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('ingests a single turn file into the database', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-ingest-'));

    const turnDir = join(tempDir, 'turns');
    mkdirSync(turnDir, { recursive: true });
    const filename = '5-1739625600.jsonl';
    const filePath = join(turnDir, filename);
    writeFileSync(filePath, makeTurnJsonl(0.042));

    ingestTurnFile('test-agent', filePath);

    const db = getDb();
    const turns = db.prepare('SELECT * FROM turns WHERE agent = ?').all('test-agent') as Record<string, unknown>[];
    expect(turns).toHaveLength(1);
    expect(turns[0].turn_number).toBe(5);
    expect(turns[0].cost_usd).toBeCloseTo(0.042);
    expect(turns[0].input_tokens).toBe(4000);
    expect(turns[0].output_tokens).toBe(1000);
    expect(turns[0].model).toBe('claude-sonnet-4-20250514');
    // started_at should be derived from epoch 1739625600
    expect(turns[0].started_at).toBe(new Date(1739625600 * 1000).toISOString());

    const toolCalls = db.prepare('SELECT * FROM tool_calls WHERE turn_id = ?').all(turns[0].id as string) as Record<string, unknown>[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].tool_name).toBe('mcp__gantry__mine');
    expect(toolCalls[0].result_summary).toBe('Mined 10 iron ore');
    expect(toolCalls[0].success).toBe(1);
  });

  it('skips duplicate turn files (idempotent)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-ingest-'));

    const turnDir = join(tempDir, 'turns');
    mkdirSync(turnDir, { recursive: true });
    const filename = '10-1739625700.jsonl';
    const filePath = join(turnDir, filename);
    writeFileSync(filePath, makeTurnJsonl(0.05));

    ingestTurnFile('test-agent', filePath);
    ingestTurnFile('test-agent', filePath);

    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as cnt FROM turns WHERE agent = ?').get('test-agent') as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  it('skips files without a result line (incomplete turns)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-ingest-'));

    const turnDir = join(tempDir, 'turns');
    mkdirSync(turnDir, { recursive: true });
    const filename = '3-1739625500.jsonl';
    const filePath = join(turnDir, filename);
    // Write JSONL without a result line
    writeFileSync(filePath, JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello' }] },
    }));

    ingestTurnFile('test-agent', filePath);

    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as cnt FROM turns').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });

  it('backfills all turn files for an agent', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-ingest-'));

    const turnDir = join(tempDir, 'turns');
    mkdirSync(turnDir, { recursive: true });

    writeFileSync(join(turnDir, '1-1739625100.jsonl'), makeTurnJsonl(0.01));
    writeFileSync(join(turnDir, '2-1739625200.jsonl'), makeTurnJsonl(0.02));
    writeFileSync(join(turnDir, '3-1739625300.jsonl'), makeTurnJsonl(0.03));

    backfillAgent('test-agent', turnDir);

    const db = getDb();
    const rows = db.prepare('SELECT * FROM turns WHERE agent = ? ORDER BY turn_number').all('test-agent') as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows[0].turn_number).toBe(1);
    expect(rows[1].turn_number).toBe(2);
    expect(rows[2].turn_number).toBe(3);
  });

  it('fires post-ingest hooks with cost data after successful ingest', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-ingest-'));
    const turnDir = join(tempDir, 'turns');
    mkdirSync(turnDir, { recursive: true });
    const filePath = join(turnDir, '7-1739625700.jsonl');
    writeFileSync(filePath, makeTurnJsonl(0.0077));

    const received: PostIngestData[] = [];
    addPostIngestHook((data) => received.push(data));

    ingestTurnFile('overseer', filePath);

    expect(received).toHaveLength(1);
    expect(received[0].agent).toBe('overseer');
    expect(received[0].turnNumber).toBe(7);
    expect(received[0].costUsd).toBeCloseTo(0.0077);
    expect(received[0].inputTokens).toBe(4000);
    expect(received[0].outputTokens).toBe(1000);
  });

  it('does not fire post-ingest hooks for duplicate (already-ingested) turns', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-ingest-'));
    const turnDir = join(tempDir, 'turns');
    mkdirSync(turnDir, { recursive: true });
    const filePath = join(turnDir, '8-1739625800.jsonl');
    writeFileSync(filePath, makeTurnJsonl(0.01));

    const received: PostIngestData[] = [];
    addPostIngestHook((data) => received.push(data));

    ingestTurnFile('overseer', filePath);
    ingestTurnFile('overseer', filePath); // duplicate

    expect(received).toHaveLength(1); // only fired once
  });

  it('handles millisecond epoch timestamps in filenames', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'fleet-ingest-'));

    const turnDir = join(tempDir, 'turns');
    mkdirSync(turnDir, { recursive: true });
    // Millisecond epoch (as used by fleet-cli runner)
    const epochMs = 1774201192364;
    const filename = `4-${epochMs}.jsonl`;
    const filePath = join(turnDir, filename);
    writeFileSync(filePath, makeTurnJsonl(0.05));

    ingestTurnFile('test-agent', filePath);

    const db = getDb();
    const turns = db.prepare('SELECT * FROM turns WHERE agent = ?').all('test-agent') as Record<string, unknown>[];
    expect(turns).toHaveLength(1);
    expect(turns[0].turn_number).toBe(4);
    // Should be in 2026, not year 58192
    const started = new Date(turns[0].started_at as string);
    expect(started.getFullYear()).toBe(2026);
    expect(turns[0].started_at).toBe(new Date(Math.floor(epochMs / 1000) * 1000).toISOString());
  });
});
