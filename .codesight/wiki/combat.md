# Combat

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Combat subsystem handles **7 routes** and touches: db.

## Routes

- `GET` `/summary` [db] `[inferred]`
  `server/src/web/routes/combat.ts`
- `GET` `/log` [db] `[inferred]`
  `server/src/web/routes/combat.ts`
- `GET` `/systems` [db] `[inferred]`
  `server/src/web/routes/combat.ts`
- `GET` `/encounters` [db] `[inferred]`
  `server/src/web/routes/combat.ts`
- `GET` `/encounters/:id` params(id) [db] `[inferred]`
  `server/src/web/routes/combat.ts`
- `GET` `/death-heatmap` [db] `[inferred]`
  `server/src/web/routes/combat.ts`
- `GET` `/timeline` [db] `[inferred]`
  `server/src/web/routes/combat.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/combat.ts`

---
_Back to [overview.md](./overview.md)_