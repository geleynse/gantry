# Nudge-integration

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Nudge-integration subsystem handles **3 routes** and touches: auth.

## Routes

- `GET` `/agent/:agent_id/nudge-state` params(agent_id) [auth] `[inferred]`
  `server/src/proxy/nudge-integration.ts`
- `GET` `/nudge/agents` [auth] `[inferred]`
  `server/src/proxy/nudge-integration.ts`
- `POST` `/agent/:agent_id/resume` params(agent_id) [auth] `[inferred]`
  `server/src/proxy/nudge-integration.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/proxy/nudge-integration.ts`

---
_Back to [overview.md](./overview.md)_