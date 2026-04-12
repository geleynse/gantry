# Diagnostics

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Diagnostics subsystem handles **2 routes** and touches: db.

## Routes

- `GET` `/schema` [db] `[inferred]`
  `server/src/web/routes/diagnostics.ts`
- `GET` `/migrations` [db] `[inferred]`
  `server/src/web/routes/diagnostics.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/diagnostics.ts`

---
_Back to [overview.md](./overview.md)_