# Health-details

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Health-details subsystem handles **7 routes** and touches: auth.

## Routes

- `GET` `/sessions/:agent` params(agent) [auth] `[inferred]`
  `server/src/web/routes/health-details.ts`
- `GET` `/latency/:agent` params(agent) [auth] `[inferred]`
  `server/src/web/routes/health-details.ts`
- `GET` `/latency` [auth] `[inferred]`
  `server/src/web/routes/health-details.ts`
- `GET` `/errors/:agent` params(agent) [auth] `[inferred]`
  `server/src/web/routes/health-details.ts`
- `GET` `/errors` [auth] `[inferred]`
  `server/src/web/routes/health-details.ts`
- `GET` `/detailed/:agent` params(agent) [auth] `[inferred]`
  `server/src/web/routes/health-details.ts`
- `GET` `/detailed` [auth] `[inferred]`
  `server/src/web/routes/health-details.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/health-details.ts`

---
_Back to [overview.md](./overview.md)_