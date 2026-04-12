# Infra

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Infra subsystem handles **11 routes** and touches: auth, db, cache, payment.

## Routes

- `POST` `/mcp` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `POST` `/mcp/v2` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `POST` `/mcp/overseer` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/mcp` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/mcp/v2` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/mcp/overseer` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/health` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/health/instability` [auth, db, cache, payment] `[inferred]`
  `server/src/proxy/mcp-factory.ts`
- `GET` `/` [auth] `[inferred]`
  `server/src/web/routes/accounts.ts`
- `POST` `/` `[inferred]`
  `server/src/web/routes/broadcast.ts`
- `GET` `/status` `[inferred]`
  `server/src/web/routes/catalog.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/proxy/mcp-factory.ts`
- `server/src/web/routes/accounts.ts`
- `server/src/web/routes/broadcast.ts`
- `server/src/web/routes/catalog.ts`

---
_Back to [overview.md](./overview.md)_