# Captains-logs

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Captains-logs subsystem handles **4 routes**.

## Routes

- `GET` `/:agent` params(agent) `[inferred]`
  `server/src/web/routes/captains-logs.ts`
- `POST` `/:agent/search` params(agent) `[inferred]`
  `server/src/web/routes/captains-logs.ts`
- `GET` `/:agent/location/:system` params(agent, system) `[inferred]`
  `server/src/web/routes/captains-logs.ts`
- `GET` `/:agent/stats` params(agent) `[inferred]`
  `server/src/web/routes/captains-logs.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/captains-logs.ts`

---
_Back to [overview.md](./overview.md)_