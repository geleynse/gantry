# Directives

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Directives subsystem handles **4 routes** and touches: db.

## Routes

- `GET` `/:name/directives` params(name) [db] `[inferred]`
  `server/src/web/routes/directives.ts`
- `POST` `/:name/directives` params(name) [db] `[inferred]`
  `server/src/web/routes/directives.ts`
- `DELETE` `/:name/directives/:id` params(name, id) [db] `[inferred]`
  `server/src/web/routes/directives.ts`
- `POST` `/:name/nudge` params(name) [db] `[inferred]`
  `server/src/web/routes/directives.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/directives.ts`

---
_Back to [overview.md](./overview.md)_