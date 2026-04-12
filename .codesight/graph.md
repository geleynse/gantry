# Dependency Graph

## Most Imported Files (change these carefully)

- `server/src/lib/logger.ts` — imported by **125** files
- `server/src/services/database.ts` — imported by **123** files
- `server/src/config.ts` — imported by **84** files
- `server/src/routines/types.ts` — imported by **40** files
- `server/src/shared/types.ts` — imported by **28** files
- `server/src/proxy/instability-metrics.ts` — imported by **26** files
- `server/src/proxy/server.ts` — imported by **23** files
- `server/src/proxy/circuit-breaker.ts` — imported by **23** files
- `server/src/routines/routine-utils.ts` — imported by **21** files
- `server/src/proxy/market-cache.ts` — imported by **20** files
- `server/src/proxy/event-buffer.ts` — imported by **20** files
- `server/src/proxy/pathfinder.ts` — imported by **19** files
- `server/src/proxy/compound-tools/types.ts` — imported by **17** files
- `server/src/web/config.ts` — imported by **17** files
- `server/src/proxy/tool-call-logger.ts` — imported by **15** files
- `server/src/web/auth/types.ts` — imported by **14** files
- `server/src/web/middleware/query-helpers.ts` — imported by **14** files
- `server/src/proxy/session-manager.ts` — imported by **13** files
- `server/src/proxy/game-client.ts` — imported by **13** files
- `server/src/proxy/sell-log.ts` — imported by **13** files

## Import Map (who imports what)

- `server/src/lib/logger.ts` ← `server/src/app.ts`, `server/src/config/fleet.ts`, `server/src/index.ts`, `server/src/lib/prompt-composer.ts`, `server/src/proxy/account-pool.ts` +120 more
- `server/src/services/database.ts` ← `server/src/index.ts`, `server/src/proxy/__tests__/agent-lifecycle.test.ts`, `server/src/proxy/__tests__/concurrent-load.test.ts`, `server/src/proxy/__tests__/reasoning-route.test.ts`, `server/src/proxy/__tests__/reasoning-route.test.ts` +118 more
- `server/src/config.ts` ← `server/src/app.ts`, `server/src/config.test.ts`, `server/src/index.ts`, `server/src/index.ts`, `server/src/proxy/__tests__/concurrent-load.test.ts` +79 more
- `server/src/routines/types.ts` ← `server/src/routines/craft-and-sell.test.ts`, `server/src/routines/craft-and-sell.ts`, `server/src/routines/explore-and-mine.test.ts`, `server/src/routines/explore-and-mine.ts`, `server/src/routines/explore-system.test.ts` +35 more
- `server/src/shared/types.ts` ← `server/src/proxy/cache-persistence.ts`, `server/src/proxy/gantry-v2.ts`, `server/src/proxy/injection-registry.test.ts`, `server/src/proxy/injection-registry.ts`, `server/src/proxy/override-system.test.ts` +23 more
- `server/src/proxy/instability-metrics.ts` ← `server/src/proxy/account-pool.test.ts`, `server/src/proxy/game-client.ts`, `server/src/proxy/gantry-v2.test.ts`, `server/src/proxy/http-game-client.ts`, `server/src/proxy/injection-registry.test.ts` +21 more
- `server/src/proxy/server.ts` ← `server/src/app.ts`, `server/src/proxy/__tests__/concurrent-load.test.ts`, `server/src/proxy/__tests__/smoke.test.ts`, `server/src/proxy/auth-handlers.test.ts`, `server/src/proxy/auth-handlers.ts` +18 more
- `server/src/proxy/circuit-breaker.ts` ← `server/src/proxy/account-pool.test.ts`, `server/src/proxy/circuit-breaker.test.ts`, `server/src/proxy/game-transport.ts`, `server/src/proxy/gantry-v2.test.ts`, `server/src/proxy/http-game-client.ts` +18 more
- `server/src/routines/routine-utils.ts` ← `server/src/routines/craft-and-sell.ts`, `server/src/routines/explore-and-mine.ts`, `server/src/routines/explore-system.ts`, `server/src/routines/fleet-jump.ts`, `server/src/routines/fleet-refuel.ts` +16 more
- `server/src/proxy/market-cache.ts` ← `server/src/proxy/arbitrage-analyzer.test.ts`, `server/src/proxy/arbitrage-analyzer.ts`, `server/src/proxy/gantry-v2.test.ts`, `server/src/proxy/market-cache.test.ts`, `server/src/proxy/market-enrichment.test.ts` +15 more
