# Comms

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Comms subsystem handles **8 routes** and touches: auth.

## Routes

- `GET` `/orders` [auth] `[inferred]`
  `server/src/web/routes/comms.ts`
- `POST` `/orders` [auth] `[inferred]`
  `server/src/web/routes/comms.ts`
- `GET` `/orders/pending/:agent` params(agent) [auth] `[inferred]`
  `server/src/web/routes/comms.ts`
- `POST` `/orders/:id/delivered` params(id) [auth] `[inferred]`
  `server/src/web/routes/comms.ts`
- `POST` `/report` [auth] `[inferred]`
  `server/src/web/routes/comms.ts`
- `POST` `/handoff` [auth] `[inferred]`
  `server/src/web/routes/comms.ts`
- `GET` `/handoff/:agent` params(agent) [auth] `[inferred]`
  `server/src/web/routes/comms.ts`
- `POST` `/handoff/:id/consume` params(id) [auth] `[inferred]`
  `server/src/web/routes/comms.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/comms.ts`

---
_Back to [overview.md](./overview.md)_