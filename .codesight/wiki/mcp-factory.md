# Mcp-factory

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Mcp-factory subsystem handles **5 routes** and touches: auth, db, cache, payment.

## Routes

- `DELETE` `/sessions/:agent` params(agent) [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/game-state/all` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/game-state/:agent` params(agent) [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/api/overrides/:agent` params(agent) [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/api/overrides` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/proxy/mcp-factory.ts`

---
_Back to [overview.md](./overview.md)_