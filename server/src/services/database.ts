import { Database, type SQLQueryBindings, type Statement } from 'bun:sqlite';
import { join } from 'node:path';
import { FLEET_DIR } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('db');

let db: Database | null = null;
let dbInstanceId: string | null = null;

// Cache for prepared statements (keyed by SQL)
const statementCache = new Map<string, Statement>();

export function createDatabase(dbPath?: string): void {
  const path = dbPath ?? join(FLEET_DIR, 'data', 'fleet.db');
  const isTestDatabase = !!dbPath;
  // Close any existing connection before opening a new one
  if (db) {
    try { 
      // Clear statement cache when closing DB
      statementCache.clear();
      db.close(); 
    } catch { /* ignore */ }
    db = null;
  }
  db = new Database(path);
  dbInstanceId = Math.random().toString(36).slice(2);

  // Enable WAL mode for concurrency (readers don't block writers)
  // We enable it even for tests now to ensure consistent behavior under load.
  // Exceptions: :memory: databases or environments with limited filesystem support.
  try {
    db.run('PRAGMA journal_mode = WAL');
  } catch (e) {
    log.warn('Failed to enable WAL mode, falling back to default', { error: e });
  }

  // Busy timeout: retry for up to 5s if database is locked (helps with concurrent writes)
  db.run('PRAGMA busy_timeout = 5000');

  // Synchronous: NORMAL is recommended for WAL mode for best performance/safety balance
  if (isTestDatabase) {
    db.run('PRAGMA synchronous = OFF');
  } else {
    db.run('PRAGMA synchronous = NORMAL');
  }

  // Cache size: larger cache reduces disk I/O during high-volume writes
  // (20MB cache, up from default ~2MB)
  db.run('PRAGMA cache_size = -20000');

  // Temp store in memory: faster temporary table operations
  db.run('PRAGMA temp_store = MEMORY');

  // Limit WAL file size to prevent it from growing indefinitely
  db.run('PRAGMA journal_size_limit = 67108864'); // 64MB

  // Memory mapping for faster I/O
  db.run('PRAGMA mmap_size = 268435456'); // 256MB

  // Foreign keys: required for referential integrity in our schema
  // Disabled for test databases to avoid constraint issues
  if (!isTestDatabase) {
    db.run('PRAGMA foreign_keys = ON');
  }

  // Create all tables inline — no versioned migration files needed.
  db.run(SCHEMA_SQL);

  // Column-upgrade shims: safely add columns that were added after initial schema deployment.
  // SQLite's ADD COLUMN always appends — safe to run on existing databases.
  // "no such column" errors on existing DBs are prevented this way.
  const columnUpgrades = [
    `ALTER TABLE agent_docs ADD COLUMN importance INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agent_diary ADD COLUMN importance INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE galaxy_pois ADD COLUMN dockable INTEGER`,
  ];
  for (const sql of columnUpgrades) {
    try {
      db.run(sql);
    } catch {
      // Column already exists — ignore "duplicate column name" errors
    }
  }

  log.info('Database initialized');
}

export function getDb(): Database {
  if (!db) {
    throw new Error('Database not initialized — call createDatabase() first');
  }
  return db;
}

/**
 * Returns a cached prepared statement for the given SQL.
 * Statement is created if not already cached.
 */
function getPreparedStatement(sql: string): Statement {
  let stmt = statementCache.get(sql);
  if (!stmt) {
    stmt = getDb().prepare(sql);
    statementCache.set(sql, stmt);
  }
  return stmt;
}

export function getDbIfInitialized(): Database | null {
  return db;
}

export function getDbInstanceId(): string | null {
  return dbInstanceId;
}

export function verifyDatabaseWorks(): boolean {
  try {
    const result = getPreparedStatement('SELECT 1 as test').get() as { test: number } | undefined;
    return result?.test === 1;
  } catch {
    return false;
  }
}

export function closeDb(): void {
  if (db) {
    statementCache.clear();
    db.close();
    db = null;
  }
}

// ---------------------------------------------------------------------------
// Typed query helpers — eliminates `as any` casts on SQLite result rows
// ---------------------------------------------------------------------------

/**
 * Execute a SELECT that returns a single row (or null).
 * Usage: `queryOne<{ id: number; name: string }>('SELECT ...', param1, param2)`
 */
export function queryOne<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
  const result = getPreparedStatement(sql).get(...params);
  return (result as T) ?? null;
}

/**
 * Execute a SELECT that returns multiple rows.
 * Usage: `queryAll<{ id: number; name: string }>('SELECT ...', param1, param2)`
 */
export function queryAll<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
  return getPreparedStatement(sql).all(...params) as T[];
}

/**
 * Execute an INSERT and return the lastInsertRowid.
 */
export function queryInsert(sql: string, ...params: SQLQueryBindings[]): number {
  const result = getPreparedStatement(sql).run(...params);
  return Number(result.lastInsertRowid);
}

/**
 * Execute an INSERT/UPDATE/DELETE and return the changes count.
 */
export function queryRun(sql: string, ...params: SQLQueryBindings[]): number {
  const result = getPreparedStatement(sql).run(...params);
  return (result as { changes: number }).changes ?? 0;
}

// ---------------------------------------------------------------------------
// Full database schema — all tables and indexes.
// Uses CREATE TABLE IF NOT EXISTS so this is safe on existing databases.
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  turn_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_create_tokens INTEGER,
  iterations INTEGER,
  model TEXT,
  error_type TEXT,
  UNIQUE(agent, turn_number, started_at)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  sequence_number INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT,
  result_summary TEXT,
  duration_ms INTEGER,
  success INTEGER
);

CREATE TABLE IF NOT EXISTS game_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  agent TEXT NOT NULL,
  credits INTEGER,
  fuel INTEGER,
  fuel_max INTEGER,
  cargo_used INTEGER,
  cargo_max INTEGER,
  system TEXT,
  poi TEXT,
  docked INTEGER,
  hull INTEGER,
  hull_max INTEGER,
  shield INTEGER,
  shield_max INTEGER,
  ship_name TEXT,
  ship_class TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_agent ON turns(agent);
CREATE INDEX IF NOT EXISTS idx_turns_started_at ON turns(started_at);
CREATE INDEX IF NOT EXISTS idx_turns_agent_started_at ON turns(agent, started_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_turn_id ON tool_calls(turn_id);
CREATE INDEX IF NOT EXISTS idx_game_snapshots_agent ON game_snapshots(agent);
CREATE INDEX IF NOT EXISTS idx_game_snapshots_turn_id ON game_snapshots(turn_id);

CREATE TABLE IF NOT EXISTS fleet_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_agent TEXT,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS fleet_order_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES fleet_orders(id),
  agent TEXT NOT NULL,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(order_id, agent)
);

CREATE TABLE IF NOT EXISTS fleet_comms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  agent TEXT,
  message TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  location_system TEXT,
  location_poi TEXT,
  credits INTEGER,
  fuel INTEGER,
  cargo_summary TEXT,
  last_actions TEXT,
  active_goals TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_fleet_orders_target ON fleet_orders(target_agent);
CREATE INDEX IF NOT EXISTS idx_fleet_order_deliveries_order ON fleet_order_deliveries(order_id);
CREATE INDEX IF NOT EXISTS idx_fleet_comms_log_type ON fleet_comms_log(type);
CREATE INDEX IF NOT EXISTS idx_fleet_comms_log_agent ON fleet_comms_log(agent);
CREATE INDEX IF NOT EXISTS idx_fleet_comms_log_created ON fleet_comms_log(created_at);
CREATE INDEX IF NOT EXISTS idx_session_handoffs_agent ON session_handoffs(agent);

CREATE TABLE IF NOT EXISTS agent_diary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  entry TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_diary_agent ON agent_diary(agent);
CREATE INDEX IF NOT EXISTS idx_agent_diary_created ON agent_diary(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_diary_importance ON agent_diary(agent, importance DESC);

CREATE TABLE IF NOT EXISTS agent_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  note_type TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent, note_type)
);

CREATE TABLE IF NOT EXISTS agent_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT,
  UNIQUE(agent, signal_type)
);

CREATE TABLE IF NOT EXISTS proxy_sessions (
  agent TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxy_game_state (
  agent TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxy_battle_state (
  agent TEXT PRIMARY KEY,
  battle_json TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxy_call_trackers (
  agent TEXT PRIMARY KEY,
  counts_json TEXT NOT NULL DEFAULT '{}',
  last_call_sig TEXT,
  called_tools_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxy_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_summary TEXT,
  result_summary TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  duration_ms INTEGER,
  is_compound INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'complete',
  assistant_text TEXT,
  trace_id TEXT,
  parent_id INTEGER REFERENCES proxy_tool_calls(id),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proxy_tool_calls_agent_created ON proxy_tool_calls(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_proxy_tool_calls_parent ON proxy_tool_calls(parent_id);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY,
  agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  iteration_count INTEGER NOT NULL DEFAULT 0,
  turn_started_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_created ON mcp_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_expires ON mcp_sessions(expires_at);

CREATE TABLE IF NOT EXISTS combat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  turn_id INTEGER REFERENCES turns(id),
  event_type TEXT NOT NULL,
  pirate_name TEXT,
  pirate_tier TEXT,
  damage INTEGER,
  hull_after INTEGER,
  max_hull INTEGER,
  died INTEGER DEFAULT 0,
  insurance_payout INTEGER,
  system TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_combat_events_agent ON combat_events(agent);
CREATE INDEX IF NOT EXISTS idx_combat_events_created ON combat_events(created_at);
CREATE INDEX IF NOT EXISTS idx_combat_events_type ON combat_events(event_type);
CREATE INDEX IF NOT EXISTS idx_combat_events_system ON combat_events(system);

CREATE TABLE IF NOT EXISTS agent_shutdown_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT UNIQUE NOT NULL,
  state TEXT NOT NULL DEFAULT 'none',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT,
  CHECK (state IN ('none', 'shutdown_waiting', 'draining', 'stopped', 'stop_after_turn'))
);

CREATE INDEX IF NOT EXISTS idx_agent_shutdown_state_agent ON agent_shutdown_state(agent_name);

CREATE TABLE IF NOT EXISTS proxy_market_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proxy_galaxy_graph (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  systems_json TEXT NOT NULL,
  edges_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS captains_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  game_log_id TEXT NOT NULL,
  sequence_number INTEGER,
  entry_text TEXT NOT NULL,
  loc_system TEXT,
  loc_poi TEXT,
  loc_dock_status TEXT,
  cr_credits INTEGER,
  cr_fuel_current INTEGER,
  cr_fuel_max INTEGER,
  cr_cargo_used INTEGER,
  cr_cargo_max INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT,
  UNIQUE(agent, game_log_id)
);

CREATE TABLE IF NOT EXISTS coordinator_state (
  id INTEGER PRIMARY KEY,
  tick_number INTEGER NOT NULL,
  tick_at TEXT DEFAULT (datetime('now')),
  fleet_snapshot TEXT NOT NULL,
  assignments TEXT NOT NULL,
  market_snapshot TEXT,
  metrics TEXT
);
CREATE INDEX IF NOT EXISTS idx_coordinator_tick ON coordinator_state(tick_number DESC);

CREATE TABLE IF NOT EXISTS coordinator_quotas (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  target_quantity INTEGER NOT NULL,
  current_quantity INTEGER DEFAULT 0,
  assigned_to TEXT,
  station_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  status TEXT DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_quotas_status ON coordinator_quotas(status, item_id);

CREATE TABLE IF NOT EXISTS learned_metadata (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT,
  mass REAL,
  value INTEGER,
  legality TEXT,
  base_price INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_recipes (
  id TEXT PRIMARY KEY,
  output_item_id TEXT NOT NULL,
  output_quantity INTEGER NOT NULL DEFAULT 1,
  inputs_json TEXT NOT NULL,
  skills_json TEXT,
  time_seconds INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS market_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  poi_id TEXT NOT NULL,
  price INTEGER NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS galaxy_pois (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  system TEXT NOT NULL,
  type TEXT,
  services_json TEXT,
  dockable INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_captains_logs_agent ON captains_logs(agent);
CREATE INDEX IF NOT EXISTS idx_captains_logs_agent_created ON captains_logs(agent, created_at);
CREATE INDEX IF NOT EXISTS idx_captains_logs_game_id ON captains_logs(game_log_id);
CREATE INDEX IF NOT EXISTS idx_captains_logs_created ON captains_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_market_history_item ON market_history(item_id);
CREATE INDEX IF NOT EXISTS idx_market_history_timestamp ON market_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_galaxy_pois_system ON galaxy_pois(system);

CREATE TABLE IF NOT EXISTS sell_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  station_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sell_log_station ON sell_log(station_id);
CREATE INDEX IF NOT EXISTS idx_sell_log_timestamp ON sell_log(timestamp);

CREATE TABLE IF NOT EXISTS agent_directives (
  id INTEGER PRIMARY KEY,
  agent_name TEXT NOT NULL,
  directive TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  created_by TEXT DEFAULT 'admin'
);
CREATE INDEX IF NOT EXISTS idx_directives_agent ON agent_directives(agent_name, active);

CREATE TABLE IF NOT EXISTS enrollment_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL, -- 'enrolled', 'credential_updated', 'credential_removed', 'prompt_deployed'
  actor TEXT, -- auth identity
  details TEXT -- JSON blob
);
CREATE INDEX IF NOT EXISTS idx_enrollment_audit_agent ON enrollment_audit(agent_name);
CREATE INDEX IF NOT EXISTS idx_enrollment_audit_timestamp ON enrollment_audit(timestamp);

CREATE TABLE IF NOT EXISTS outbound_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  agent_name TEXT NOT NULL,
  channel TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbound_review_status ON outbound_review(status);
CREATE INDEX IF NOT EXISTS idx_outbound_review_agent ON outbound_review(agent_name);
CREATE INDEX IF NOT EXISTS idx_outbound_review_channel ON outbound_review(channel);

CREATE TABLE IF NOT EXISTS agent_action_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  action_type TEXT NOT NULL,
  item TEXT,
  quantity INTEGER,
  credits_delta INTEGER,
  station TEXT,
  system TEXT,
  raw_data TEXT,
  game_timestamp TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_action_log_agent ON agent_action_log(agent);
CREATE INDEX IF NOT EXISTS idx_action_log_type ON agent_action_log(action_type);
CREATE INDEX IF NOT EXISTS idx_action_log_time ON agent_action_log(created_at);
CREATE INDEX IF NOT EXISTS idx_action_log_dedup ON agent_action_log(agent, action_type, game_timestamp);

CREATE TABLE IF NOT EXISTS agent_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  category TEXT,
  message TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_alerts_agent ON agent_alerts(agent);
CREATE INDEX IF NOT EXISTS idx_agent_alerts_acknowledged ON agent_alerts(acknowledged);
CREATE INDEX IF NOT EXISTS idx_agent_alerts_created ON agent_alerts(created_at);

CREATE TABLE IF NOT EXISTS overseer_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick_number INTEGER NOT NULL,
  triggered_by TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  prompt_text TEXT,
  response_json TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_estimate REAL,
  status TEXT NOT NULL DEFAULT 'success',
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_overseer_decisions_created ON overseer_decisions(created_at);
CREATE INDEX IF NOT EXISTS idx_overseer_decisions_status ON overseer_decisions(status);

CREATE TABLE IF NOT EXISTS galaxy_wormholes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_a TEXT NOT NULL,
  system_b TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'heuristic',
  confidence REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(system_a, system_b)
);

CREATE TABLE IF NOT EXISTS poi_lore (
  system TEXT NOT NULL,
  poi_name TEXT NOT NULL,
  note TEXT NOT NULL,
  discovered_by TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  tags TEXT,
  PRIMARY KEY (system, poi_name)
);
CREATE INDEX IF NOT EXISTS idx_poi_lore_system ON poi_lore(system);

CREATE TABLE IF NOT EXISTS resource_knowledge (
  system TEXT NOT NULL,
  station TEXT NOT NULL DEFAULT '',
  resource TEXT NOT NULL,
  quantity_seen INTEGER,
  price_seen REAL,
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  source_agent TEXT NOT NULL,
  PRIMARY KEY (system, station, resource)
);
CREATE INDEX IF NOT EXISTS idx_resource_knowledge_resource ON resource_knowledge(resource);
CREATE INDEX IF NOT EXISTS idx_resource_knowledge_system ON resource_knowledge(system);
CREATE INDEX IF NOT EXISTS idx_resource_knowledge_last_seen ON resource_knowledge(last_seen);

`;
