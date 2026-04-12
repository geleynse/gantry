# Inject

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Inject subsystem handles **4 routes** and touches: db.

## Routes

- `GET` `/:name/inject` params(name) [db] `[inferred]`
  `server/src/web/routes/inject.ts`
- `POST` `/:name/inject` params(name) [db] `[inferred]`
  `server/src/web/routes/inject.ts`
- `GET` `/:name/shutdown` params(name) [db] `[inferred]`
  `server/src/web/routes/inject.ts`
- `DELETE` `/:name/shutdown` params(name) [db] `[inferred]`
  `server/src/web/routes/inject.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/inject.ts`

---
_Back to [overview.md](./overview.md)_