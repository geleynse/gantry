# gantry — Overview

> **Navigation aid.** This article shows WHERE things live (routes, models, files). Read actual source files before implementing new features or making changes.

**gantry** is a typescript project built with next-app, express, organized as a monorepo.

**Workspaces:** `gantry` (`server`)

## Scale

194 API routes · 68 UI components · 29 middleware layers · 29 environment variables

## Subsystems

- **[Auth](./auth.md)** — 2 routes — touches: auth, cache, ai
- **[Accounts](./accounts.md)** — 2 routes — touches: auth
- **[Action-proxy](./action-proxy.md)** — 15 routes — touches: auth, db, cache
- **[Activity](./activity.md)** — 3 routes
- **[Agents](./agents.md)** — 11 routes — touches: auth, cache, ai
- **[Alerts](./alerts.md)** — 3 routes — touches: auth
- **[Analytics-db](./analytics-db.md)** — 11 routes — touches: auth
- **[Broadcast](./broadcast.md)** — 1 routes
- **[Captains-logs](./captains-logs.md)** — 4 routes
- **[Combat](./combat.md)** — 7 routes — touches: db
- **[Comms](./comms.md)** — 8 routes — touches: auth
- **[Context-summary](./context-summary.md)** — 1 routes — touches: auth, cache, ai
- **[Coordinator](./coordinator.md)** — 5 routes — touches: auth, db
- **[Credentials](./credentials.md)** — 3 routes — touches: auth, db
- **[Diagnostics](./diagnostics.md)** — 2 routes — touches: db
- **[Directives](./directives.md)** — 4 routes — touches: db
- **[Economy](./economy.md)** — 4 routes — touches: auth
- **[Enrollment](./enrollment.md)** — 4 routes — touches: auth, ai
- **[Fleet-capacity](./fleet-capacity.md)** — 1 routes — touches: cache
- **[Fleet-control](./fleet-control.md)** — 2 routes — touches: auth
- **[Game-state](./game-state.md)** — 1 routes — touches: cache
- **[Health-details](./health-details.md)** — 7 routes — touches: auth
- **[Health-monitor-route](./health-monitor-route.md)** — 1 routes
- **[Inject](./inject.md)** — 4 routes — touches: db
- **[Intel](./intel.md)** — 2 routes — touches: cache
- **[Knowledge](./knowledge.md)** — 3 routes
- **[Logs](./logs.md)** — 4 routes
- **[Lore](./lore.md)** — 2 routes — touches: db
- **[Map](./map.md)** — 4 routes — touches: cache
- **[Market](./market.md)** — 5 routes — touches: db, cache
- **[Mcp-factory](./mcp-factory.md)** — 5 routes — touches: auth, db, cache, payment
- **[Mock-ws-game-server](./mock-ws-game-server.md)** — 2 routes
- **[Notes](./notes.md)** — 6 routes
- **[Nudge-integration](./nudge-integration.md)** — 3 routes — touches: auth
- **[Outbound-review](./outbound-review.md)** — 5 routes — touches: auth, db
- **[Overseer](./overseer.md)** — 2 routes
- **[Ping](./ping.md)** — 1 routes — touches: auth, cache
- **[Prompts](./prompts.md)** — 5 routes — touches: auth
- **[Proxy-health](./proxy-health.md)** — 2 routes
- **[Rate-limits](./rate-limits.md)** — 1 routes
- **[Rate-limits.test](./rate-limits.test.md)** — 1 routes — touches: auth
- **[Resources](./resources.md)** — 1 routes — touches: db
- **[Security](./security.md)** — 1 routes — touches: auth
- **[Status](./status.md)** — 1 routes — touches: auth, cache
- **[Survivability](./survivability.md)** — 7 routes — touches: cache
- **[Tool-calls](./tool-calls.md)** — 5 routes — touches: auth, db, cache
- **[Trust proxy](./trust proxy.md)** — 1 routes — touches: auth, cache, ai
- **[Turns](./turns.md)** — 2 routes
- **[Websocket](./websocket.md)** — 3 routes
- **[Websocket.test](./websocket.test.md)** — 3 routes
- **[Infra](./infra.md)** — 11 routes — touches: auth, db, cache, payment

**UI:** 68 components (react) — see [ui.md](./ui.md)

## High-Impact Files

Changes to these files have the widest blast radius across the codebase:

- `server/src/lib/logger.ts` — imported by **125** files
- `server/src/services/database.ts` — imported by **123** files
- `server/src/config.ts` — imported by **84** files
- `server/src/routines/types.ts` — imported by **40** files
- `server/src/shared/types.ts` — imported by **28** files
- `server/src/proxy/instability-metrics.ts` — imported by **26** files

## Required Environment Variables

- `BUILD_VERSION` — `server/build.ts`
- `BUN_ENV` — `server/src/config/env.ts`
- `CF_TUNNEL` — `server/src/web/auth/index.ts`
- `DANGER_POLL_INTERVAL_MS` — `server/src/config/env.test.ts`
- `FLEET_DIR` — `server/src/config/env.ts`
- `GANTRY_AGENT_HOME` — `server/src/services/agent-manager.ts`
- `GANTRY_AGENT_USER` — `server/src/services/agent-manager.ts`
- `GANTRY_ENV` — `server/src/config/env.ts`
- `GANTRY_EXTERNAL` — `server/src/web/auth/index.ts`
- `GANTRY_HOST` — `server/src/index.ts`
- `GANTRY_PORT` — `server/src/config/env.ts`
- `GANTRY_PUBLIC_DIR` — `server/src/app.ts`
- _...17 more_

---
_Back to [index.md](./index.md) · Generated 2026-04-09_