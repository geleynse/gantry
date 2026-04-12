# Accounts

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Accounts subsystem handles **2 routes** and touches: auth.

## Routes

- `POST` `/:username/assign` params(username) [auth] `[inferred]`
  `server/src/web/routes/accounts.ts`
- `POST` `/:username/release` params(username) [auth] `[inferred]`
  `server/src/web/routes/accounts.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/accounts.ts`

---
_Back to [overview.md](./overview.md)_