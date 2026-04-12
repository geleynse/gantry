# Agents

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Agents subsystem handles **11 routes** and touches: auth, cache, ai.

## Routes

- `POST` `/start-all` [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `POST` `/stop-all` [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `GET` `/:name/prompts` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `GET` `/:name/composed-prompt` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `GET` `/:name` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `PATCH` `/:name/config` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `POST` `/:name/start` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `POST` `/:name/stop` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `POST` `/:name/restart` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `POST` `/:name/stop-after-turn` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`
- `POST` `/:name/shutdown` params(name) [auth, cache, ai] `[inferred]`
  `server/src/web/routes/agents.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/agents.ts`

---
_Back to [overview.md](./overview.md)_