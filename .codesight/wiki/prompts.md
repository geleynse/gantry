# Prompts

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Prompts subsystem handles **5 routes** and touches: auth.

## Routes

- `GET` `/agents` [auth] `[inferred]`
  `server/src/web/routes/prompts.ts`
- `GET` `/files` [auth] `[inferred]`
  `server/src/web/routes/prompts.ts`
- `GET` `/common-rules` [auth] `[inferred]`
  `server/src/web/routes/prompts.ts`
- `GET` `/assembled/:agentName` params(agentName) [auth] `[inferred]`
  `server/src/web/routes/prompts.ts`
- `PUT` `/files/:filename` params(filename) [auth] `[inferred]`
  `server/src/web/routes/prompts.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/prompts.ts`

---
_Back to [overview.md](./overview.md)_