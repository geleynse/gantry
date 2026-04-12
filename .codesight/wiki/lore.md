# Lore

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Lore subsystem handles **2 routes** and touches: db.

## Routes

- `GET` `/:system` params(system) [db] `[inferred]`
  `server/src/web/routes/lore.ts`
- `DELETE` `/:system/:poi` params(system, poi) [db] `[inferred]`
  `server/src/web/routes/lore.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/lore.ts`

---
_Back to [overview.md](./overview.md)_