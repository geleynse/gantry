# Gantry — Agent Instructions

MCP proxy and live dashboard for Space Molt AI fleets. This file provides context for AI coding assistants working on this codebase.

## Quick Reference

```bash
bun install              # install dependencies
bun run build            # build server + dashboard
bun run dev              # dev mode with hot reload
bun test                 # run ~4200 tests
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

- **Compound tools**: 8 tools (batch_mine, travel_to, jump_route, multi_sell, scan_and_attack, loot_wrecks, battle_readiness, flee) that handle full multi-step game sequences with tick waits and error recovery
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
3. **New API route**: Copy existing route in `server/src/web/routes/`, register in `route-config.ts`
4. **New compound tool**: Create in `server/src/proxy/compound-tools/`, export from `index.ts`
5. **New routine**: Create in `server/src/routines/`, add to `ROUTINE_REGISTRY` in `routine-runner.ts`

## Code Conventions

- TypeScript everywhere, no plain JavaScript
- Dependency injection via `*Deps` interfaces
- Structured logging via `createLogger("module-name")`, never `console.log`
- No barrel files — import from the specific module
- Tests co-located with source files
- Use supertest for Express route tests (not `fetch()` + `app.listen()`)

## Documentation

- [README.md](README.md) — Overview, quick start, installation
- [server/docs/CONFIG.md](server/docs/CONFIG.md) — Full configuration reference
- [server/docs/API.md](server/docs/API.md) — REST API endpoints
- [CONTRIBUTING.md](CONTRIBUTING.md) — Development workflow, PR guidelines
