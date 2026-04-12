# Survivability

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Survivability subsystem handles **7 routes** and touches: cache.

## Routes

- `GET` `/threat/:system` params(system) [cache] `[inferred]`
  `server/src/web/routes/survivability.ts`
- `GET` `/policy/:agent` params(agent) [cache] `[inferred]`
  `server/src/web/routes/survivability.ts`
- `GET` `/mods/:agent` params(agent) [cache] `[inferred]`
  `server/src/web/routes/survivability.ts`
- `GET` `/cloak-stats` [cache] `[inferred]`
  `server/src/web/routes/survivability.ts`
- `GET` `/thresholds` [cache] `[inferred]`
  `server/src/web/routes/survivability.ts`
- `POST` `/thresholds` [cache] `[inferred]`
  `server/src/web/routes/survivability.ts`
- `POST` `/cloak-policy` [cache] `[inferred]`
  `server/src/web/routes/survivability.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/survivability.ts`

---
_Back to [overview.md](./overview.md)_