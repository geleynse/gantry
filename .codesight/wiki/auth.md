# Auth

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Auth subsystem handles **2 routes** and touches: auth, cache, ai.

## Routes

- `GET` `/api/auth/me` [auth, cache, ai] `[inferred]`
  `server/src/app.ts`
- `GET` `/api/auth/debug` [auth, cache, ai] `[inferred]`
  `server/src/app.ts`

## Middleware

- **auth** (auth) — `docs/auth.md`
- **auth-provider.test** (auth) — `server/src/components/__tests__/auth-provider.test.tsx`
- **auth-provider** (auth) — `server/src/components/auth-provider.tsx`
- **auth-handlers.test** (auth) — `server/src/proxy/auth-handlers.test.ts`
- **auth-handlers** (auth) — `server/src/proxy/auth-handlers.ts`
- **auth-debug.test** (auth) — `server/src/web/auth/auth-debug.test.ts`
- **auth.test** (auth) — `server/src/web/auth/auth.test.ts`
- **middleware.test** (auth) — `server/src/web/auth/middleware.test.ts`
- **middleware** (auth) — `server/src/web/auth/middleware.ts`
- **agent-online.test** (auth) — `server/src/web/middleware/agent-online.test.ts`
- **agent-online** (auth) — `server/src/web/middleware/agent-online.ts`
- **rate-limit** (auth) — `server/src/web/middleware/rate-limit.ts`
- **rate-limits.test** (auth) — `server/src/web/routes/rate-limits.test.ts`
- **authMiddleware** (auth) — `server/src/app.ts`
- **sessionLimiter** (auth) — `server/src/web/routes/action-proxy.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `server/src/app.ts`

---
_Back to [overview.md](./overview.md)_