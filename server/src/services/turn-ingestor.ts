import { readFileSync, readdirSync, watch, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { FLEET_DIR, AGENTS, getAgent } from '../config.js';
import { getDb } from './database.js';
import { parseTurnFile } from './turn-parser.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('turn-ingestor');

// ---------------------------------------------------------------------------
// Post-ingest hooks
// ---------------------------------------------------------------------------

export interface PostIngestData {
  agent: string;
  turnNumber: number;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

type PostIngestHook = (data: PostIngestData) => void;
const postIngestHooks: PostIngestHook[] = [];

/**
 * Register a callback fired after each turn is successfully ingested.
 * Used by the overseer to backfill cost_estimate on the latest decision row.
 */
export function addPostIngestHook(fn: PostIngestHook): void {
  postIngestHooks.push(fn);
}

/**
 * Parse turn number and epoch timestamp from a filename like "42-1739625600.jsonl".
 * Handles both seconds and milliseconds epoch formats — if the value is > 1e12,
 * it's treated as milliseconds and divided by 1000.
 * Returns null if the filename doesn't match the expected pattern.
 */
function parseFilename(filename: string): { turnNumber: number; epochSeconds: number } | null {
  const match = basename(filename).match(/^(\d+)-(\d+)\.jsonl$/);
  if (!match) return null;
  const raw = parseInt(match[2], 10);
  // Epoch seconds are ~1.7e9 in 2026; milliseconds are ~1.7e12
  const epochSeconds = raw > 1e12 ? Math.floor(raw / 1000) : raw;
  return {
    turnNumber: parseInt(match[1], 10),
    epochSeconds,
  };
}

/**
 * Ingest a single turn JSONL file into the database.
 * Uses INSERT OR IGNORE for idempotency (agent + turn_number + started_at is unique).
 * Skips files without a result line (incomplete turns).
 */
export function ingestTurnFile(agent: string, filePath: string): void {
  const parsed = parseFilename(filePath);
  if (!parsed) {
    log.warn('Skipping unparseable turn filename', { agent, file: basename(filePath) });
    return;
  }

  const content = readFileSync(filePath, 'utf-8');
  const turn = parseTurnFile(content);

  // Skip incomplete turns (no result line)
  if (!turn.summary) {
    log.debug('Skipping incomplete turn (no summary)', { agent, file: basename(filePath) });
    return;
  }

  const { turnNumber, epochSeconds } = parsed;
  const startedAt = new Date(epochSeconds * 1000).toISOString();

  // Sanity check: reject timestamps more than 1 day in the future
  if (epochSeconds * 1000 > Date.now() + 86_400_000) {
    log.error('Turn timestamp is in the far future — likely an epoch parsing bug', {
      agent, file: basename(filePath), epochSeconds, startedAt,
    });
    return;
  }
  const completedAt = turn.summary.durationMs
    ? new Date(epochSeconds * 1000 + turn.summary.durationMs).toISOString()
    : null;

  const db = getDb();

  const insertTurn = db.prepare(`
    INSERT OR IGNORE INTO turns (
      agent, turn_number, started_at, completed_at, duration_ms,
      cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens,
      iterations, model, error_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = insertTurn.run(
    agent,
    turnNumber,
    startedAt,
    completedAt,
    turn.summary.durationMs,
    turn.summary.costUsd,
    turn.summary.inputTokens,
    turn.summary.outputTokens,
    turn.summary.cacheReadTokens,
    turn.summary.cacheCreateTokens,
    turn.summary.iterations,
    turn.summary.model || getAgent(agent)?.model || null,
    null,
  );

  // If the row was ignored (duplicate), skip tool calls, snapshots, and combat events
  if (info.changes === 0) return;

  const turnId = info.lastInsertRowid;

  // Warn on suspicious zero-cost turns (helps catch parser format mismatches early)
  if (turn.summary.costUsd === 0 && turn.toolCalls.length > 0) {
    log.warn('Ingested turn with $0 cost despite having tool calls — possible parser issue', {
      agent, turnNumber, startedAt, toolCalls: turn.toolCalls.length,
      inputTokens: turn.summary.inputTokens,
      outputTokens: turn.summary.outputTokens,
      file: basename(filePath),
    });
  }

  log.debug('Ingested turn', {
    agent, turnNumber, turnId, startedAt,
    cost: turn.summary.costUsd,
    toolCalls: turn.toolCalls.length,
    hasGameState: !!turn.gameState,
    combatEvents: turn.combatEvents.length,
  });

  // Fire post-ingest hooks (e.g. overseer cost backfill)
  if (postIngestHooks.length > 0) {
    const hookData: PostIngestData = {
      agent,
      turnNumber,
      costUsd: turn.summary.costUsd ?? null,
      inputTokens: turn.summary.inputTokens ?? null,
      outputTokens: turn.summary.outputTokens ?? null,
    };
    for (const hook of postIngestHooks) {
      try { hook(hookData); } catch (err) {
        log.warn('Post-ingest hook error', { agent, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // Insert tool calls
  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (turn_id, sequence_number, tool_name, args_json, result_summary, duration_ms, success)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const tc of turn.toolCalls) {
    insertToolCall.run(
      turnId,
      tc.sequenceNumber,
      tc.toolName,
      tc.argsJson,
      tc.resultSummary,
      null,
      tc.success ? 1 : 0,
    );
  }

  // Insert combat events
  if (turn.combatEvents.length > 0) {
    // Fallback system: use gameState system, or look up last known system from DB
    const fallbackSystem = turn.gameState?.system ?? (db.prepare(
      `SELECT system FROM game_snapshots WHERE agent = ? AND system IS NOT NULL AND system != '' ORDER BY id DESC LIMIT 1`
    ).get(agent) as { system: string } | null)?.system ?? null;

    const insertCombat = db.prepare(`
      INSERT INTO combat_events (
        agent, turn_id, event_type, pirate_name, pirate_tier,
        damage, hull_after, max_hull, died, insurance_payout, system, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Use the turn's startedAt as the event timestamp
    for (const evt of turn.combatEvents) {
      insertCombat.run(
        agent,
        turnId,
        evt.eventType,
        evt.pirateName,
        evt.pirateTier,
        evt.damage,
        evt.hullAfter,
        evt.maxHull,
        evt.died ? 1 : 0,
        evt.insurancePayout,
        evt.system || fallbackSystem,
        startedAt,
      );
    }
  }

  // Insert game snapshot if available
  if (turn.gameState) {
    const gs = turn.gameState;
    db.prepare(`
      INSERT INTO game_snapshots (
        turn_id, agent, credits, fuel, fuel_max, cargo_used, cargo_max,
        system, poi, docked, hull, hull_max, shield, shield_max, ship_name, ship_class
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      turnId,
      agent,
      gs.credits,
      gs.fuel,
      gs.fuelMax,
      gs.cargoUsed,
      gs.cargoMax,
      gs.system,
      gs.poi,
      gs.docked !== null ? (gs.docked ? 1 : 0) : null,
      gs.hull,
      gs.hullMax,
      gs.shield,
      gs.shieldMax,
      gs.shipName,
      gs.shipClass,
    );
  }
}

/**
 * Backfill all turn files for a single agent from a directory.
 * Reads all .jsonl files, sorts by filename, and ingests each.
 */
export function backfillAgent(agent: string, turnDir: string): void {
  if (!existsSync(turnDir)) return;

  const files = readdirSync(turnDir)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  let successCount = 0;
  let skipCount = 0;
  for (const file of files) {
    try {
      const filePath = join(turnDir, file);
      const parsed = parseFilename(filePath);
      if (!parsed) {
        skipCount++;
        continue;
      }
      const content = readFileSync(filePath, 'utf-8');
      const turn = parseTurnFile(content);
      if (!turn.summary) {
        skipCount++;
        continue;
      }
      ingestTurnFile(agent, filePath);
      successCount++;
    } catch (e) {
      log.warn(`Failed to ingest turn file ${file}`, {
        agent,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  if (successCount > 0 || skipCount > 0) {
    log.info(`Backfill complete for ${agent}`, { ingested: successCount, skipped: skipCount, total: files.length });
  } else {
    log.debug(`Backfill: no turn files for ${agent}`, { total: files.length });
  }
}

/**
 * Watch a single directory for new .jsonl files.
 * Calls ingestTurnFile with a 1s delay to let the file finish writing.
 */
function watchDirectory(agent: string, turnDir: string): void {
  if (!existsSync(turnDir)) return;

  watch(turnDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) return;
    // Both 'rename' (mv) and 'change' (cp) events can create files
    if (eventType !== 'rename' && eventType !== 'change') return;

    const filePath = join(turnDir, filename);
    setTimeout(() => {
      try {
        if (existsSync(filePath)) {
          log.debug('Ingesting new turn file', { agent, file: filename });
          ingestTurnFile(agent, filePath);
        }
      } catch (err) {
        log.warn('Failed to ingest watched turn file', {
          agent, file: filename,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, 1000);
  });
}

/**
 * Watch each agent's turn directory for new .jsonl files.
 * Watches both local FLEET_DIR and synced claude-devtools location.
 * Also backfills existing files at startup so the DB is populated from JSONL history.
 */
/**
 * Log a health summary of the analytics pipeline on startup.
 * Catches issues like: no recent data, zero-cost turns, future-dated rows.
 */
function logPipelineHealth(): void {
  try {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM turns').get() as { cnt: number })?.cnt ?? 0;
    const recent = (db.prepare("SELECT COUNT(*) as cnt FROM turns WHERE started_at > datetime('now', '-7 days')").get() as { cnt: number })?.cnt ?? 0;
    const zeroCost = (db.prepare("SELECT COUNT(*) as cnt FROM turns WHERE cost_usd = 0 AND started_at > datetime('now', '-7 days')").get() as { cnt: number })?.cnt ?? 0;
    const futureDated = (db.prepare("SELECT COUNT(*) as cnt FROM turns WHERE started_at > datetime('now', '+1 day')").get() as { cnt: number })?.cnt ?? 0;
    const latest = (db.prepare('SELECT MAX(started_at) as ts FROM turns').get() as { ts: string | null })?.ts ?? 'none';

    log.info('Analytics pipeline health', { total, recent_7d: recent, zero_cost_7d: zeroCost, future_dated: futureDated, latest_turn: latest });

    if (futureDated > 0) {
      log.error(`${futureDated} turns have future-dated timestamps — likely epoch parsing bug`);
    }
    if (recent === 0 && total > 0) {
      log.warn('No turns ingested in the last 7 days — turn file watcher may not be working');
    }
    if (zeroCost > 0 && recent > 0) {
      const pct = Math.round((zeroCost / recent) * 100);
      if (pct > 50) {
        log.warn(`${pct}% of recent turns have $0 cost — possible parser format mismatch`);
      }
    }
  } catch (err) {
    log.warn('Failed to check analytics pipeline health', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function watchTurnFiles(): void {
  // Run health check after backfill completes
  setImmediate(() => setTimeout(logPipelineHealth, 5000));

  for (const agent of AGENTS) {
    try {
      // Watch local FLEET_DIR location (e.g., ~/claude/spacemolt/fleet-agents/logs/turns/{agent})
      const localTurnDir = join(FLEET_DIR, 'logs', 'turns', agent.name);
      watchDirectory(agent.name, localTurnDir);

      // Watch synced location (e.g., ~/.claude/projects/-home-spacemolt/logs/turns/{agent})
      const syncedTurnDir = join(
        resolve(homedir()),
        '.claude',
        'projects',
        '-home-spacemolt',
        'logs',
        'turns',
        agent.name
      );
      watchDirectory(agent.name, syncedTurnDir);

      // Backfill existing files async so server starts immediately
      const localExists = existsSync(localTurnDir);
      const syncedExists = existsSync(syncedTurnDir);
      if (localExists || syncedExists) {
        log.info(`Watching turn files for ${agent.name}`, {
          local: localExists ? 'active' : 'not found',
          synced: syncedExists ? 'active' : 'not found',
        });
        setImmediate(() => {
          if (localExists) backfillAgent(agent.name, localTurnDir);
          if (syncedExists) backfillAgent(agent.name, syncedTurnDir);
        });
      }
    } catch (e) {
      log.error(`Failed to set up turn watcher for ${agent.name}`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

