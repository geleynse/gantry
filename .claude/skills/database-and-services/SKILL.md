---
name: database-and-services
description: Use when adding or modifying persistence — new tables, service modules under server/src/services/, direct SQLite writes from the proxy, or tests that touch bun:sqlite — and when debugging fleet.db schema, locking, or WAL behavior.
---

# Database & Service Layer — Gantry Server

## The database module

Single file: `server/src/services/database.ts`. Everything else imports from it — there is no ORM, no query builder, no separate migration runner.

- `getDb()` — returns the raw `bun:sqlite` `Database` instance. Throws `'Database not initialized — call createDatabase() first'` if called before `createDatabase()`. Import path from a service module: `from "./database.js"`; from a route: `from "../../services/database.js"`.
- `createDatabase(dbPath?: string)` — opens the DB, sets pragmas, runs the full inline schema (`CREATE TABLE IF NOT EXISTS ...` for every table) plus a short list of `ALTER TABLE ... ADD COLUMN` column-upgrade shims (wrapped in try/catch to ignore "duplicate column" on existing DBs). Call with no args in production; call with `':memory:'` (or a temp file path) in tests.
- `getDbIfInitialized()` — like `getDb()` but returns `null` instead of throwing; used by code paths that need to no-op gracefully before startup completes.
- `closeDb()` — clears the prepared-statement cache and closes the connection. Always call in test `afterEach`.
- Typed query helpers — **prefer these over raw `db.prepare()` for simple queries**, they cache prepared statements by SQL string and give you a typed return instead of `as any`:
  - `queryOne<T>(sql, ...params): T | null`
  - `queryAll<T>(sql, ...params): T[]`
  - `queryInsert(sql, ...params): number` — returns `lastInsertRowid`
  - `queryRun(sql, ...params): number` — returns `changes` count
  - All four log a warning and return a safe empty value (`null`/`[]`/`0`) if called before `createDatabase()` — they do not throw.
- For multi-statement transactions or when you need the raw `Statement` object (e.g. `turn-ingestor.ts` building an insert once and reusing `.run()` in a loop), call `getDb()` and use `db.prepare(sql)` / `db.transaction(fn)()` directly — see the transaction pattern below.

## Where `fleet.db` lives

`join(FLEET_DIR, 'data', 'fleet.db')` — resolved inside `createDatabase()` when called with no `dbPath` argument. `FLEET_DIR` itself is resolved in `server/src/config/env.ts` (`resolveFleetDir()`): explicit `FLEET_DIR` env var first, then a documented fallback search — read `env.ts`'s top comment block if you need the exact fallback order, don't assume. **Never point a local dev run or a test at the real `fleet.db`** — use `GANTRY_MOCK=1` for a running server (see `build-and-dev` skill) or `createDatabase(':memory:')` for tests.

## Schema approach: no migration files

The entire schema lives as one large template literal (`SCHEMA_SQL`) at the bottom of `database.ts`, applied via `db.run(SCHEMA_SQL)` on every `createDatabase()` call. Every `CREATE TABLE` uses `IF NOT EXISTS`, every `CREATE INDEX` uses `IF NOT EXISTS` — this is safe to re-run on an existing populated database at every server startup. There is no `migrations/` directory, no version table, no up/down scripts.

**To add a column to an existing table:** don't edit the `CREATE TABLE` block alone (existing on-disk DBs won't pick it up) — add an `ALTER TABLE ... ADD COLUMN ...` to the `columnUpgrades` array in `createDatabase()` (right after `SCHEMA_SQL` runs). The array already has 4 entries as of this writing (e.g. `ALTER TABLE agent_docs ADD COLUMN importance INTEGER NOT NULL DEFAULT 0`) — follow that pattern; the try/catch around the loop swallows "duplicate column name" so it's idempotent.

**To add a new table:** add a `CREATE TABLE IF NOT EXISTS` block (plus any `CREATE INDEX IF NOT EXISTS` you need) directly into `SCHEMA_SQL`. New tables don't need a `columnUpgrades` entry — `IF NOT EXISTS` handles first-run creation for everyone, old and new databases alike.

## Tables and what writes them (representative, not exhaustive — grep `SCHEMA_SQL` in `database.ts` for the full ~44-table list)

| Table | Written by | Purpose |
|---|---|---|
| `turns`, `tool_calls` (legacy), `game_snapshots` | `services/turn-ingestor.ts` | Per-turn cost/token/duration ingestion from agent turn-log files |
| `proxy_tool_calls` | `proxy/tool-call-logger.ts` (`logToolCallStart`/`logToolCallComplete`) | Live per-call log the dashboard streams via SSE; two-phase (pending→complete) |
| `mcp_sessions` | `proxy/session-store.ts` | MCP session lifecycle/expiry tracking |
| `proxy_game_state`, `proxy_battle_state` | proxy pipeline (game state cache persistence) | Crash-recoverable snapshot of `sharedState.cache.status`/`.battle` |
| `agent_diary`, `agent_docs` | `services/notes-db.ts` | Per-agent diary entries + typed notes (strategy/discoveries/market-intel/report/thoughts) |
| `fleet_orders`, `fleet_order_deliveries`, `fleet_comms_log` | `services/comms-db.ts` | Admin-issued orders to agents + delivery receipts + audit log |
| `captains_logs` | `services/captains-logs-db.ts` | Structured per-agent captain's log entries synced from game log IDs |
| `combat_events` | `services/turn-ingestor.ts` | Per-battle damage/hull/insurance events, parsed out of turn logs alongside `turns`/`tool_calls` |
| `agent_directives` | `services/directives.ts` | Standing orders per agent (priority, expiry) |
| `agent_alerts` | `services/alerts-db.ts` | Operator-facing alerts, ack state |
| `coordinator_state`, `coordinator_quotas` | `services/coordinator.ts` / `coordinator-state.ts` | Fleet coordinator tick snapshots + mining/crafting quota assignments |
| `market_history`, `galaxy_pois` | `services/market-history.ts`, `galaxy-poi-registry.ts` | Learned galaxy/market knowledge, accumulated across runs |
| `overseer_decisions` | `services/overseer-agent.ts` | Overseer agent decision log |
| `overseer_stop_cooldowns`, `overseer_stop_history` | `services/overseer-stop-cooldown.ts` | Auto-restart suppression state |
| `outbound_review` | `services/outbound-review.ts` | Pending-review queue for agent-authored outbound comms |
| `enrollment_audit` | `services/enrollment-audit.ts` | Audit trail for credential/prompt changes |

## Direct-write pattern (no HTTP round-trip)

The MCP proxy (`server/src/proxy/**`) writes tool calls, sessions, and game state straight to SQLite via `getDb()`/`queryInsert`/`queryRun` from the same process — it does not call back into the `/api/*` Express routes to persist anything. This is why `sharedState` (in-memory caches: `sharedState.cache.status`, `.battle`, `.market`) exists alongside the DB: the proxy updates both the DB (durable) and the in-memory cache (fast reads for the dashboard) on every tool call. Routes under `web/routes/` read from `sharedState` for hot data and from the DB (via service modules) for historical/queryable data — know which one a given route needs before wiring it up.

## Service module conventions

One file per domain under `server/src/services/`, named `<domain>.ts` or `<domain>-db.ts` when the module is primarily a thin SQL wrapper (`notes-db.ts`, `comms-db.ts`, `alerts-db.ts`, `captains-logs-db.ts`, `agent-shutdown-db.ts`, `signals-db.ts`). Non-`-db` service files (`process-manager.ts`, `log-parser.ts`, `analytics-query.ts`, `health-scorer.ts`, ...) mix DB access with other logic (file I/O, process management, computed scoring) — the `-db` suffix is a hint, not a hard rule.

Convention inside a `*-db.ts` module:
```typescript
import { queryAll, queryOne, queryRun, queryInsert, getDb } from "./database.js";

export interface Foo { id: number; agent: string; /* ... */ }

export function createFoo(input: { agent: string; text: string }): number {
  return queryInsert(`INSERT INTO foo (agent, text) VALUES (?, ?)`, input.agent, input.text);
}

export function listFoo(agent: string, limit = 50): Foo[] {
  return queryAll<Foo>(`SELECT * FROM foo WHERE agent = ? ORDER BY id DESC LIMIT ?`, agent, limit);
}
```
- No classes, no DI container for services — plain exported functions, imported directly by whatever route or proxy module needs them (this is the "no barrel files" rule from `AGENTS.md`: import `from "../../services/notes-db.js"`, not from an `index.ts`).
- Validation that maps to a 400 (e.g. `validateNoteType()` in `notes-db.ts`) lives in the service and throws a plain `Error` with a descriptive message — the calling route catches it and maps to `res.status(400).json({ error: err.message })`. Don't push this validation into the route.
- Escaping for `LIKE` patterns: services that build dynamic `LIKE` clauses (search) manually escape `%`, `_`, `\` and use `ESCAPE '\\'` — see `searchFleetMemory()` in `notes-db.ts` for the exact pattern if you're adding another search function.

## Transactions and prepared statements

For multi-statement writes that must be atomic, use `db.transaction(fn)()` (note: called immediately, it returns a wrapped function you invoke):
```typescript
export function createOrder(input: CreateOrderInput): number {
  const db = getDb();
  let orderId = 0;
  db.transaction(() => {
    orderId = queryInsert(`INSERT INTO fleet_orders (...) VALUES (...)`, /* ... */);
    queryRun(`INSERT INTO fleet_comms_log (...) VALUES (...)`, /* ... */);
  })();
  return orderId;
}
```
(`services/comms-db.ts::createOrder`, verbatim pattern.)

For a hot loop inserting many rows with the same shape (e.g. ingesting a batch of tool calls from one turn file), prepare once and reuse:
```typescript
const db = getDb();
const insertTurn = db.prepare(`INSERT OR IGNORE INTO turns (...) VALUES (...)`);
const info = insertTurn.run(agent, turnNumber, /* ... */);
if (info.changes === 0) return; // INSERT OR IGNORE hit a UNIQUE constraint — duplicate, bail
const turnId = info.lastInsertRowid;
```
(`services/turn-ingestor.ts::ingestTurnFile`, verbatim pattern.) `INSERT OR IGNORE` + checking `info.changes === 0` is the codebase's idempotency pattern for at-least-once ingestion (turn files can be re-read after a crash).

`queryOne`/`queryAll`/`queryInsert`/`queryRun` already cache prepared statements internally keyed by SQL string — you don't need to hand-roll caching for single-statement calls, only for the loop-reuse case above where you want one `Statement` object across many `.run()` calls without going through the cache lookup each time.

## Testing services and routes that touch the DB

Every service test (`*.test.ts` next to the service) and every route test that touches persistence follows the same setup:
```typescript
import { createDatabase, closeDb } from "./database.js"; // or "../../services/database.js" from a route test

beforeEach(() => {
  createDatabase(":memory:");
});

afterEach(() => {
  closeDb();
});
```
This is a **real `bun:sqlite` in-memory database**, schema and all — not a mock of the `database.ts` module. Every test gets a fresh, empty DB (WAL mode and `synchronous=OFF` are skipped/relaxed for `:memory:` and test paths — see the `isTestDatabase` branch in `createDatabase()`). This is what `CONTRIBUTING.md` means by "mocked database service, not a live SQLite connection": never point a test at `$FLEET_DIR/data/fleet.db`, always pass an explicit path (`:memory:` for unit/route tests).

Run one service test file in isolation while iterating: `bun test server/src/services/notes-db.test.ts`.

## WAL / locking / concurrency gotchas

From the pragmas set in `createDatabase()` (non-test path):
- `PRAGMA journal_mode = WAL` — readers don't block writers; multiple proxy modules and route handlers can read concurrently while a write is in flight. Explicitly re-enabled for test DBs too "to ensure consistent behavior under load" (the pragma call is wrapped in try/catch since `:memory:` doesn't support WAL — failure there is expected and logged as a warning, not fatal).
- `PRAGMA busy_timeout = 5000` — a writer waiting on a lock retries for up to 5s before SQLite raises `SQLITE_BUSY`. If you see intermittent `database is locked` errors in logs, it means something held a write lock for >5s — look for a missing `db.transaction()` wrapper around a multi-statement sequence, or an unusually large single write.
- `PRAGMA synchronous = NORMAL` in production (safe with WAL — full durability except in an OS crash, not just process crash) vs `OFF` for test databases (faster, acceptable since test DBs are throwaway).
- `PRAGMA foreign_keys = ON` in production only — disabled for test databases "to avoid constraint issues" (tests often insert child rows without bothering to create the parent row first).
- `PRAGMA journal_size_limit = 67108864` (64MB) — caps WAL file growth; without periodic checkpointing this could otherwise grow unbounded under sustained write load.
- `PRAGMA cache_size = -20000` (20MB) and `PRAGMA mmap_size = 268435456` (256MB) — tuned for a single-process, high-write-volume workload (this is a proxy logging every tool call from every agent), not defaults.
- Statement cache (`statementCache` Map in `database.ts`) is cleared on both `createDatabase()` (before opening a new connection) and `closeDb()` — if you ever see a "table not found" error right after a schema change in a long-running dev session, it's very unlikely to be stale-statement related since the cache is keyed fresh per connection, but `closeDb()`+`createDatabase()` is still the reset button if something looks wedged.
