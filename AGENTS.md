# Gantry — Agent Instructions

MCP proxy and live dashboard for Space Molt AI fleets. This file provides context for AI coding assistants working on this codebase.

## Quick Reference

```bash
bun install              # install dependencies
bun run build            # build server + dashboard
bun run dev              # dev mode with hot reload
bun run test:isolated    # run ~5,500 tests, one process per file (what CI gates on)
bun test <file>          # single file — a full `bun test` false-reds ~60% of the time
```

Dashboard at `http://localhost:3100`.

## Repository Structure

```
gantry/
├── server/              # Express server (MCP proxy + REST API + dashboard)
│   ├── src/
│   │   ├── proxy/       # MCP proxy modules (compound tools, pipeline, guardrails)
│   │   ├── routines/    # 18 multi-step game routines
│   │   ├── web/         # Express routes, auth adapters, middleware
│   │   ├── services/    # Database, notes, comms, analytics
│   │   ├── app/         # React 19 + Next.js 15 frontend
│   │   ├── components/  # Shared React components
│   │   ├── hooks/       # React hooks
│   │   ├── shared/      # Shared TypeScript types
│   │   ├── config/      # Config parsing and schemas
│   │   └── lib/         # Utilities (logger, api helpers)
│   ├── docs/
│   │   ├── CONFIG.md    # Full configuration reference
│   │   └── API.md       # REST API documentation
│   └── scripts/         # Setup and build scripts
├── examples/
│   └── agent-template/  # Template for creating new agents
├── docker-compose.yml   # Docker deployment
└── CONTRIBUTING.md      # Code style, testing, PR guidelines
```

## Architecture

```
AI Agent (Claude/Codex/Gemini)
        │
        │  MCP (HTTP)
        ▼
Gantry Server :3100
  ├── /mcp/v2        MCP proxy (compound tools, guardrails, injections)
  ├── /api/*         REST API (agent status, comms, analytics, notes)
  └── /              Web dashboard (React + Next.js, SSE streams)
        │
        │  MCP (HTTP)
        ▼
game.spacemolt.com/mcp
```

Single Express process on Bun. All data in SQLite (`fleet.db`).

## Key Concepts

- **Compound tools**: 11 tools (batch_mine, travel_to, jump_route, multi_sell, scan_and_attack, battle_readiness, loot_wrecks, flee, get_craft_profitability, craft_path_to, passenger_run) that handle full multi-step game sequences with tick waits and error recovery
- **Proxy pipeline**: Request guardrails, injections (fleet orders, battle state, events), decontamination (strips hallucination keywords), and agent tracking
- **v2 action-dispatch**: All game tools consolidated into 6 namespaces using `spacemolt(action="...")` syntax
- **Dependency injection**: Each proxy module defines a `*Deps` interface — no global mutable state
- **Hot-reload config**: `gantry.json` is watched and reloaded every 5 seconds without restart

## Build System

- **Runtime**: Bun (not Node.js)
- **Server build**: esbuild via `build.ts` → `dist/index.js`
- **Frontend build**: Next.js 15 static export → `dist/public/`
- **Binary build**: `bun run build:binary` → standalone `dist/gantry` (~200MB, embedded assets)
- **Tests**: `bun:test` (co-located `*.test.ts` files)
- **Two tsconfigs**: `tsconfig.json` (server), `tsconfig.next.json` (React/Next.js)

## Development Workflow

1. **Server changes**: Edit `server/src/`, run `bun run dev` (auto-rebuilds)
2. **Frontend changes**: Edit `server/src/app/` or `server/src/components/`, run `bun run build:client`
3. **New API route**: Copy existing route in `server/src/web/routes/`, add a `router.use(...)` in the `createApiRoutes()` factory in `server/src/web/routes/api-routes.ts`
4. **New compound tool**: Create in `server/src/proxy/compound-tools/`, export from `index.ts`, register in the `buildCompoundActions` dispatch table in `tool-registry.ts`
5. **New routine**: Create in `server/src/routines/`, add it to the `BUILTIN_ROUTINES` array in `routine-runner.ts` (populates `ROUTINE_REGISTRY`)

## Code Conventions

- TypeScript everywhere, no plain JavaScript
- Dependency injection via `*Deps` interfaces
- Structured logging via `createLogger("module-name")`, never `console.log`
- No barrel files — import from the specific module
- Tests co-located with source files
- Use supertest for Express route tests (not `fetch()` + `app.listen()`)

## Talking to the game: verify fields against the live spec

The game's OpenAPI spec is public and authoritative:
`GET https://game.spacemolt.com/api/openapi.json` (`info.x-gameserver-version` gives the live
version). Most response schemas are `additionalProperties: false`, so a field absent from the spec
is a field the server will never send.

**Check parameter names, types, and response fields against that spec before writing code that
depends on them.** A 2026-08 sweep found four bugs of exactly this shape, all silent in production:
a routine sending a parameter the endpoint does not accept; two compound tools gating on a response
field that cannot exist; and a routine reading a result key its own callee never returns.

**The reason these survive is fixtures.** Each was covered by a test whose mock supplied the missing
field or accepted any payload — the suite was green and the behaviour was wrong. So:

- A mock that returns a response shape must return a shape the real server can actually produce.
- A mock that stands in for an outbound call should assert the payload, not accept anything.
- When a test supplies a value the production code depends on, ask what supplies it in production.
  If the answer is "nothing", the test is describing a system that does not exist.

Known live example of the last point: `HttpGameClientV2.waitForTick()` does not wait for a tick — it
performs a status refresh. Tests stub it as a no-op and advance mock state on every read, which is
where the appearance of tick pacing comes from. See [docs/api-drift-2026-08.md](docs/api-drift-2026-08.md).

`server/src/proxy/schema-drift.test.ts` diffs the proxied command set against the live server and
fails on a removed command — but note it needs network, and CI currently does not gate on test
failures at all (`continue-on-error`), so a green CI run is not evidence the suite passed.

## Documentation

- [README.md](README.md) — Overview, quick start, installation
- [server/docs/CONFIG.md](server/docs/CONFIG.md) — Full configuration reference
- [server/docs/API.md](server/docs/API.md) — REST API endpoints
- [CONTRIBUTING.md](CONTRIBUTING.md) — Development workflow, PR guidelines
