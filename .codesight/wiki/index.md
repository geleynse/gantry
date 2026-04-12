# gantry — Wiki

_Generated 2026-04-09 — re-run `npx codesight --wiki` if the codebase has changed._

Structural map compiled from source code via AST. No LLM — deterministic, 200ms.

> **How to use safely:** These articles tell you WHERE things live and WHAT exists. They do not show full implementation logic. Always read the actual source files before implementing new features or making changes. Never infer how a function works from the wiki alone.

## Articles

- [Overview](./overview.md)
- [Auth](./auth.md)
- [Accounts](./accounts.md)
- [Action-proxy](./action-proxy.md)
- [Activity](./activity.md)
- [Agents](./agents.md)
- [Alerts](./alerts.md)
- [Analytics-db](./analytics-db.md)
- [Broadcast](./broadcast.md)
- [Captains-logs](./captains-logs.md)
- [Combat](./combat.md)
- [Comms](./comms.md)
- [Context-summary](./context-summary.md)
- [Coordinator](./coordinator.md)
- [Credentials](./credentials.md)
- [Diagnostics](./diagnostics.md)
- [Directives](./directives.md)
- [Economy](./economy.md)
- [Enrollment](./enrollment.md)
- [Fleet-capacity](./fleet-capacity.md)
- [Fleet-control](./fleet-control.md)
- [Game-state](./game-state.md)
- [Health-details](./health-details.md)
- [Health-monitor-route](./health-monitor-route.md)
- [Inject](./inject.md)
- [Intel](./intel.md)
- [Knowledge](./knowledge.md)
- [Logs](./logs.md)
- [Lore](./lore.md)
- [Map](./map.md)
- [Market](./market.md)
- [Mcp-factory](./mcp-factory.md)
- [Mock-ws-game-server](./mock-ws-game-server.md)
- [Notes](./notes.md)
- [Nudge-integration](./nudge-integration.md)
- [Outbound-review](./outbound-review.md)
- [Overseer](./overseer.md)
- [Ping](./ping.md)
- [Prompts](./prompts.md)
- [Proxy-health](./proxy-health.md)
- [Rate-limits](./rate-limits.md)
- [Rate-limits.test](./rate-limits.test.md)
- [Resources](./resources.md)
- [Security](./security.md)
- [Status](./status.md)
- [Survivability](./survivability.md)
- [Tool-calls](./tool-calls.md)
- [Trust proxy](./trust proxy.md)
- [Turns](./turns.md)
- [Websocket](./websocket.md)
- [Websocket.test](./websocket.test.md)
- [Infra](./infra.md)
- [Ui](./ui.md)

## Quick Stats

- Routes: **194**
- Models: **0**
- Components: **68**
- Env vars: **29** required, **0** with defaults

## How to Use

- **New session:** read `index.md` (this file) for orientation — WHERE things are
- **Architecture question:** read `overview.md` (~500 tokens)
- **Domain question:** read the relevant article, then **read those source files**
- **Database question:** read `database.md`, then read the actual schema files
- **Before implementing anything:** read the source files listed in the article
- **Full source context:** read `.codesight/CODESIGHT.md`

## What the Wiki Does Not Cover

These exist in your codebase but are **not** reflected in wiki articles:
- Routes registered dynamically at runtime (loops, plugin factories, `app.use(dynamicRouter)`)
- Internal routes from npm packages (e.g. Better Auth's built-in `/api/auth/*` endpoints)
- WebSocket and SSE handlers
- Raw SQL tables not declared through an ORM
- Computed or virtual fields absent from schema declarations
- TypeScript types that are not actual database columns
- Routes marked `[inferred]` were detected via regex and may have lower precision
- gRPC, tRPC, and GraphQL resolvers may be partially captured

When in doubt, search the source. The wiki is a starting point, not a complete inventory.

---
_Last compiled: 2026-04-09 · 54 articles · [codesight](https://github.com/Houseofmvps/codesight)_