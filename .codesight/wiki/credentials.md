# Credentials

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Credentials subsystem handles **3 routes** and touches: auth, db.

## Routes

- `POST` `/:agent/update` params(agent) [auth, db] `[inferred]`
  `server/src/web/routes/credentials.ts`
- `DELETE` `/:agent` params(agent) [auth, db] `[inferred]`
  `server/src/web/routes/credentials.ts`
- `GET` `/audit` [auth, db] `[inferred]`
  `server/src/web/routes/credentials.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/credentials.ts`

---
_Back to [overview.md](./overview.md)_