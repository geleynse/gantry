# Outbound-review

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Outbound-review subsystem handles **5 routes** and touches: auth, db.

## Routes

- `GET` `/pending/count` [auth, db] `[inferred]`
  `server/src/web/routes/outbound-review.ts`
- `GET` `/pending` [auth, db] `[inferred]`
  `server/src/web/routes/outbound-review.ts`
- `POST` `/approve/:id` params(id) [auth, db] `[inferred]`
  `server/src/web/routes/outbound-review.ts`
- `POST` `/reject/:id` params(id) [auth, db] `[inferred]`
  `server/src/web/routes/outbound-review.ts`
- `POST` `/approve-all` [auth, db] `[inferred]`
  `server/src/web/routes/outbound-review.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/outbound-review.ts`

---
_Back to [overview.md](./overview.md)_