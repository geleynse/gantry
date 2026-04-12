# Action-proxy

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Action-proxy subsystem handles **15 routes** and touches: auth, db, cache.

## Routes

- `POST` `/start` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `POST` `/stop` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `POST` `/restart` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `POST` `/kick/:agent` params(agent) [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `GET` `/logs` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `GET` `/sessions` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `GET` `/sessions/credentials` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `POST` `/sessions` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `GET` `/game-state` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `PUT` `/game-state/:agent` params(agent) [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `GET` `/battle-state` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `PUT` `/battle-state/:agent` params(agent) [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `GET` `/call-trackers` [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `PUT` `/call-trackers/:agent` params(agent) [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`
- `DELETE` `/caches/:agent` params(agent) [auth, db, cache] `[inferred]`
  `server/src/web/routes/action-proxy.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/web/routes/action-proxy.ts`

---
_Back to [overview.md](./overview.md)_