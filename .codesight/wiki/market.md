# Market

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Market subsystem handles **5 routes** and touches: db, cache.

## Routes

- `POST` `/scan` [db, cache] `[inferred]`
  `server/src/web/routes/market.ts`
- `GET` `/arbitrage` [db, cache] `[inferred]`
  `server/src/web/routes/market.ts`
- `GET` `/cache-stats` [db, cache] `[inferred]`
  `server/src/web/routes/market.ts`
- `GET` `/reservations` [db, cache] `[inferred]`
  `server/src/web/routes/market.ts`
- `DELETE` `/reservations/:agent` params(agent) [db, cache] `[inferred]`
  `server/src/web/routes/market.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/market.ts`

---
_Back to [overview.md](./overview.md)_