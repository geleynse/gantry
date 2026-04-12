# Coordinator

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Coordinator subsystem handles **5 routes** and touches: auth, db.

## Routes

- `POST` `/tick` [auth, db] `[inferred]`
  `server/src/web/routes/coordinator.ts`
- `POST` `/enable` [auth, db] `[inferred]`
  `server/src/web/routes/coordinator.ts`
- `GET` `/quotas` [auth, db] `[inferred]`
  `server/src/web/routes/coordinator.ts`
- `POST` `/quotas` [auth, db] `[inferred]`
  `server/src/web/routes/coordinator.ts`
- `DELETE` `/quotas/:id` params(id) [auth, db] `[inferred]`
  `server/src/web/routes/coordinator.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/coordinator.ts`

---
_Back to [overview.md](./overview.md)_