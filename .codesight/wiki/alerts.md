# Alerts

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Alerts subsystem handles **3 routes** and touches: auth.

## Routes

- `GET` `/count` [auth] `[inferred]`
  `server/src/web/routes/alerts.ts`
- `POST` `/acknowledge-all` [auth] `[inferred]`
  `server/src/web/routes/alerts.ts`
- `POST` `/:id/acknowledge` params(id) [auth] `[inferred]`
  `server/src/web/routes/alerts.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/alerts.ts`

---
_Back to [overview.md](./overview.md)_