# Fleet-control

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Fleet-control subsystem handles **2 routes** and touches: auth.

## Routes

- `POST` `/:name/order` params(name) [auth] `[inferred]`
  `server/src/web/routes/fleet-control.ts`
- `POST` `/:name/routine` params(name) [auth] `[inferred]`
  `server/src/web/routes/fleet-control.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/fleet-control.ts`

---
_Back to [overview.md](./overview.md)_