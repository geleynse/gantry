# Logs

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Logs subsystem handles **4 routes**.

## Routes

- `GET` `/:name/logs/stream` params(name) `[inferred]`
  `server/src/web/routes/logs.ts`
- `GET` `/:name/logs/history` params(name) `[inferred]`
  `server/src/web/routes/logs.ts`
- `GET` `/:name/logs/search` params(name) `[inferred]`
  `server/src/web/routes/logs.ts`
- `GET` `/:name/logfile` params(name) `[inferred]`
  `server/src/web/routes/logs.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/logs.ts`

---
_Back to [overview.md](./overview.md)_