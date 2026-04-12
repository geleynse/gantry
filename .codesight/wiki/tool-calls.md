# Tool-calls

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Tool-calls subsystem handles **5 routes** and touches: auth, db, cache.

## Routes

- `POST` `/text` [auth, db, cache] `[inferred]`
  `server/src/web/routes/tool-calls.ts`
- `DELETE` `/prune` [auth, db, cache] `[inferred]`
  `server/src/web/routes/tool-calls.ts`
- `GET` `/missions` [auth, db, cache] `[inferred]`
  `server/src/web/routes/tool-calls.ts`
- `GET` `/turn-costs` [auth, db, cache] `[inferred]`
  `server/src/web/routes/tool-calls.ts`
- `POST` `/:name/reasoning` params(name) [auth, db, cache] `[inferred]`
  `server/src/web/routes/tool-calls.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/tool-calls.ts`

---
_Back to [overview.md](./overview.md)_