# Map

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Map subsystem handles **4 routes** and touches: cache.

## Routes

- `GET` `/positions` [cache] `[inferred]`
  `server/src/web/routes/map.ts`
- `GET` `/explored-systems` [cache] `[inferred]`
  `server/src/web/routes/map.ts`
- `GET` `/wormholes` [cache] `[inferred]`
  `server/src/web/routes/map.ts`
- `GET` `/system-detail` [cache] `[inferred]`
  `server/src/web/routes/map.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/map.ts`

---
_Back to [overview.md](./overview.md)_