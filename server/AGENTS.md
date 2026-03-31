# Gantry Server — Agent Instructions

Unified Express server combining the MCP action proxy and fleet web dashboard into a single process on port 3100.

**Repo:** `github.com/geleynse/gantry`

## Getting Started

```bash
cd gantry/server
bun install
bun run build          # server (esbuild) + dashboard (Next.js)
bun run dev            # dev mode with watch
bun test               # ~4200 tests
```

Dashboard at `http://localhost:3100`. Config at `$FLEET_DIR/gantry.json` — see [docs/configuration.md](../docs/configuration.md).

### Common First Tasks

- **Add a new API route:** Copy an existing route in `src/web/routes/`, add to `ROUTE_REGISTRATIONS` in `src/web/route-config.ts`
- **Add a new compound tool:** Create file in `src/proxy/compound-tools/`, export from `index.ts`, register in `tool-registry.ts`
- **Add a new routine:** Create in `src/routines/`, add to `ROUTINE_REGISTRY` in `routine-runner.ts`
- **Modify proxy behavior:** Start in `src/proxy/pipeline.ts` (guardrails/injections) or `passthrough-handler.ts` (tool execution)
- **Frontend changes:** Edit `src/app/` or `src/components/`, then `bun run build:client`

### Key Documentation

- **[docs/configuration.md](../docs/configuration.md)** — Full configuration reference with examples
- **[docs/API.md](docs/API.md)** — REST API endpoint reference
- **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — Code style, testing, PR guidelines

## Architecture

```
AI Agent (Claude/Codex/Gemini)  --(MCP/HTTP)-->  Gantry Server  --(MCP HTTP)-->  Game Server
                                                       |
                                                  Express app :3100
                                                  ├── /mcp, /mcp/v2     (MCP proxy)
                                                  ├── /api/*             (Web dashboard API)
                                                  └── /                  (SPA frontend)
```

The server manages agent processes directly using PID files (`$FLEET_DIR/data/pids/*.pid`) and captures output by tailing log files (`$FLEET_DIR/logs/*.log`).

## Directory Layout

| Directory | Contents |
|-----------|----------|
| `src/proxy/` | MCP proxy: modular architecture (see Proxy Modules below), game-client, session-manager, compound tools, summarizers, schema |
| `src/web/routes/` | Express route modules (status, agents, logs, comms, notes, analytics, etc.) |
| `src/services/` | Service layer: database, notes-db, comms-db, process-manager, log-parser, analytics |
| `src/routines/` | 18 multi-step routines (mine, craft, sell, navigate, patrol, trade, refuel, jump, etc.) |
| `src/shared/` | Shared types between server and frontend |
| `src/app/` | React 19 + Next.js 15 frontend (static export to `dist/public/`) |
| `src/components/` | Shared React components (agent-card, galaxy-map, health-bar, etc.) |
| `src/hooks/` | React hooks (use-fleet-status, use-game-state) |
| `src/lib/` | Frontend utilities (api, utils with agent colors/names) |
| `src/config/` | Config parsing, schemas, environment variables, constants |
| `src/app.ts` | Express app factory (mounts proxy + web routes + static files) |
| `src/index.ts` | Entry point (config, database, app, timers, graceful shutdown) |

## Proxy Modules (`src/proxy/`)

The MCP proxy is decomposed into focused modules with dependency injection:

| Module | Purpose |
|--------|---------|
| `server.ts` | Interfaces (SharedState, BattleState), v1 `createGantryServer` factory |
| `gantry-v2.ts` | v2 `createGantryServerV2` factory, v2→v1 action mapping |
| `mcp-factory.ts` | Top-level `createMcpServer()` orchestrator: schema fetch, health poller, Express router |
| `tool-registry.ts` | v1 passthrough + compound tool registration, TOOL_SCHEMAS |
| `passthrough-handler.ts` | Shared `handlePassthrough()` — nav, auto-undock, execute, tick wait, enrichment |
| `proxy-constants.ts` | STATE_CHANGING_TOOLS, CONTAMINATION_WORDS, response formatting |
| `pipeline.ts` | Request pipeline: guardrails, injections, decontamination, agent tracking |
| `compound-tools/` | 8 compound tools: batch_mine, travel_to, jump_route, multi_sell, scan_and_attack, loot_wrecks, battle_readiness, flee |
| `auth-handlers.ts` | Login/logout handlers shared by v1 and v2 |
| `cached-queries.ts` | STATUS_SLICE_EXTRACTORS for cached status queries |
| `doc-tools.ts` | Handler functions for diary/doc/report/search_memory |
| `tool-call-logger.ts` | Two-phase logging (pending→complete), ring buffer, SSE subscriber push |

**DI pattern**: Each module defines a `*Deps` interface, receives shared state explicitly. v1 and v2 factories both delegate to the same shared handler functions.

## Key Design Decisions

- **Direct SQLite**: Proxy writes game state, tool calls, sessions directly to SQLite via `bun:sqlite` (no HTTP round-trips). Uses `getDb()` from `web/services/database.js`.
- **Shared state**: `createMcpServer()` returns `sharedState` (statusCache, battleCache) passed to web routes via factory functions.
- **SSE helper**: `web/sse.ts` provides `initSSE()`/`writeSSE()` for Express.
- **Tool call logger**: Two-phase logging — `logToolCallStart()` inserts pending record, `logToolCallComplete()` updates with result/duration/status. Subscriber pattern for push-based SSE. Frontend merges by ID.
- **v2 preset default**: Falls back to first available preset in `v2SchemaByPreset`, not hardcoded "standard".
- **Structured logging**: Logger in `src/lib/logger.ts` with 4 levels (DEBUG < INFO < WARN < ERROR). Format: `[LEVEL] [category] message | key: value`.

## Build

```bash
bun run build           # build:server (esbuild) + build:client (next build)
bun run build:server    # server-only esbuild via build.ts
bun run build:client    # Next.js static export to dist/public/
bun test                # bun:test (~4200 tests)
bun run dev             # bun watch mode (server only)

# Single-binary build (no Bun runtime needed on target)
bun run build:binary    # Outputs dist/gantry (Linux x86-64, ~200MB)
                        # Static frontend assets are embedded in the binary
```

**Two tsconfigs**: `tsconfig.json` (server/esbuild), `tsconfig.next.json` (React/Next.js — excludes proxy/web/shared dirs).

## Auth System

Pluggable auth middleware in `src/web/auth/`. Five built-in adapters: `none`, `token`, `cloudflare-access`, `local-network`, `layered` (recommended for production). Config in gantry.json `"auth"` key. See [docs/configuration.md](../docs/configuration.md) for full auth configuration.

- Route classification: GET = viewer, POST/PUT/DELETE + MCP = admin
- MCP localhost bypass for agent connections
- Frontend `AuthProvider` + `useAuth()` hook gates admin controls

**Gotcha**: `/api/auth/me` must be auth-optional, not public. Public routes skip `adapter.authenticate()` entirely, so `req.auth` is never populated.

## Code Style

- **TypeScript everywhere** — no plain JavaScript
- **Dependency injection** — new proxy modules get a `*Deps` interface, not direct imports of shared state
- **Structured logging** — use `createLogger("module-name")` from `src/lib/logger.ts`; never `console.log`
- **No barrel files** — import from the specific module, not from an `index.ts`
- **Tests co-located** — `foo.test.ts` next to `foo.ts`, using `bun:test`

## Testing

```bash
bun test                   # all tests
bun test --coverage       # with coverage
bun test file.test.ts     # specific file
```

### Testing Gotchas

- **Use supertest, not `fetch()` + `app.listen()`** for Express route tests. Bun's fetch has a connection pool bug that drops response bodies in CI. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the correct pattern.
- `mock.module()` is process-global — avoid mocking commonly-imported modules
- `spyOn` requires namespace imports (named imports capture direct references)
- `global.fetch` is not restored by `mock.restore()` — save and restore manually

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` / `GANTRY_PORT` | `3100` | HTTP port |
| `FLEET_DIR` / `AGENT_DIR` | Auto-detect | Path to fleet config directory |
| `LOG_LEVEL` | `debug` | Logging level |
| `GANTRY_SECRET` | Auto-generated | AES-256 encryption key for credentials |
| `GANTRY_ENV` | *(unset)* | Config file selection (`gantry.$GANTRY_ENV.json`) |

See [docs/configuration.md](../docs/configuration.md) for the complete list.

## Gotchas

- **YAML tool results break Codex/rmcp**: `toolResultFormat: "yaml"` causes proxy to reformat responses to YAML. Codex's `rmcp` library expects JSON-RPC. Any non-Claude backend must have YAML disabled.
- **Config hot-reload**: `createGantryServerV2(config)` captures a snapshot. Use `getConfig()` for runtime fields that should reflect hot-reloaded changes.
- **loadConfig field copying**: `loadConfig()` manually copies each field. New schema fields MUST be added to the copy block. A test catches this.
