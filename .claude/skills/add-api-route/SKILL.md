---
name: add-api-route
description: Use when adding, modifying, or debugging a REST endpoint under /api/*, including plain JSON routes and SSE (Server-Sent Events) streams — covers file placement, router registration, auth classification, and the supertest pattern for route tests.
---

# Adding an API Route — Gantry Server

## 1. Where the file goes

New route module: `server/src/web/routes/<name>.ts`. Test: `server/src/web/routes/<name>.test.ts` (co-located).

**Canonical example to copy:** `server/src/web/routes/directives.ts` + `directives.test.ts` — simple CRUD over one service module, clean auth story, in-memory DB test. For an SSE example, copy `server/src/web/routes/status.ts` (`GET /stream`) or read `server/src/web/routes/sse.test.ts` / `agent-stream.test.ts`.

**Stale doc warning:** `AGENTS.md` (both root and `server/`) says "register in `ROUTE_REGISTRATIONS` in `route-config.ts`". **That file does not exist.** The real registration point is `server/src/web/routes/api-routes.ts`, which manually mounts every sub-router with `router.use(...)` inside `createApiRoutes()`. Two source comments (`map.ts`, `credentials.ts`) still say "route-config" too — ignore them, they're leftover from a prior refactor.

## 2. Two router shapes

Pick based on whether the route needs shared state / DB deps at construction time:

**A. Plain router, default export** — no constructor args, imports its own service functions directly (`notes.ts`, `directives.ts`, `comms.ts`, `tool-calls.ts`):

```typescript
import { Router } from 'express';
import { validateAgentName } from '../config.js';
import { getFoo, createFoo } from '../../services/foo-db.js';

const router: Router = Router();

router.get('/:name', (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  res.json(getFoo(name));
});

export default router;
```

**B. Factory function** — needs `sharedState` slices, `sessions`, `config`, etc. injected (`status.ts`, `market.ts`, `game-state.ts`, `accounts.ts`):

```typescript
export function createFooRouter(statusCache: Map<string, AgentStatus>, config: GantryConfig): Router {
  const router: Router = Router();
  router.get('/', (_req, res) => res.json([...statusCache.values()]));
  return router;
}
```

Factories are called once in `api-routes.ts::createApiRoutes()`, which receives `{ config, sharedState, sessions, registeredToolCount, healthMonitor, overseerAgent, fleetDir }` (see `ApiRouteDeps` in `api-routes.ts`). `sharedState` is the object returned by `createMcpServer()` in `proxy/server.ts` — grep its shape (`sharedState.cache.status`, `.cache.battle`, `.cache.market`, `.proxy.breakerRegistry`, `.proxy.serverMetrics`, `.fleet.coordinator`, `.sessions.active`) before wiring a new factory.

## 3. Register the route

In `server/src/web/routes/api-routes.ts`:
1. Import the router/factory at the top with the other imports.
2. Mount it inside `createApiRoutes()`:
   ```typescript
   router.use('/foo', fooRoutes);                    // plain router
   router.use('/foo', createFooRouter(sharedState.cache.status, config));  // factory
   ```
3. **Mount-order matters when paths overlap.** `agentRouter` uses `/:name` as a catch-all under `/agents`; routers with static sub-paths (`enrollment-options`, directives, sessions, etc.) must mount *before* it or Express matches `:name` first. See the comment above `router.use("/agents", createEnrollmentRouter())` in `api-routes.ts`.
4. There's a catch-all 404 (`router.use((_req, res) => res.status(404).json(...))`) at the bottom of `createApiRoutes()` — new routers must be mounted above it (they will be, since it's added last in the function body; just don't add anything after it).

No separate "compile" step — `bun run dev` picks it up via esbuild watch (server-only; see `build-and-dev` skill if this is a dashboard-facing route and you need the UI to reflect it).

## 4. Auth classification

Enforced centrally in `server/src/web/auth/middleware.ts` (`authMiddleware`), *not* per-route. You opt a route into stricter rules by adding to a list there — you rarely write auth checks inline.

Default rule (`isAdminRoute()`):
- **Any non-GET method → admin.** (POST/PUT/DELETE always require admin, no exceptions list needed.)
- **GET → viewer**, UNLESS the path matches one of:
  - `ADMIN_ONLY_PREFIXES` — currently `/devtools`, `/api/prompts`, `/api/comms`, `/api/overseer`, `/api/notes`, `/api/captains-logs`, `/api/fleet/broadcast`, `/api/credentials`, `/api/outbound`. Add your prefix here if the *entire* route family (including its GETs) should be admin-only.
  - `ADMIN_ONLY_PATTERNS` — regexes for specific per-agent paths that live under an otherwise-viewer prefix (e.g. `/api/agents/:name/inject`, `/directives(/|$)`, `/shutdown`). Add a regex here instead of a prefix when only some sub-paths under `/api/agents/:name/...` need lockdown.
- `PUBLIC_ROUTES` (exact path match, no auth at all): `/health`, `/health/instability`, `/api/ping`.
- `AUTH_OPTIONAL_ROUTES`: currently only `/api/auth/me`. **Gotcha:** auth-optional is NOT the same as public. Public routes skip `adapter.authenticate()` entirely, so `req.auth` is `undefined`. Auth-optional routes DO call `adapter.authenticate()` (populating `req.auth` when possible, falling back to `{ role: 'viewer' }` on error) but never block on the result. If you need `req.auth.identity` populated for a route that also shouldn't 403 viewers, add it to `AUTH_OPTIONAL_ROUTES`, not `PUBLIC_ROUTES`.
- **MCP localhost bypass:** any path under `/mcp` or `/sessions`, when the request originates from `127.0.0.1`/`::1`, gets `req.auth = { role: 'admin', identity: 'localhost' }` unconditionally — this is how agent processes (which connect from localhost) get admin without credentials. Don't rely on this for anything outside the MCP prefixes.
- Auth adapter errors fail closed (503), except on auth-optional routes (fall back to viewer).

After adding an admin-gated route, add it to `server/docs/API.md`'s Auth table if it's a new prefix, and note `**Auth:** admin` / `**Auth:** viewer` under the new endpoint entry (see step 6).

## 5. SSE endpoints

Use `initSSE(req, res)` / `writeSSE(res, event, data)` from `server/src/web/sse.ts` — do not hand-roll headers.

```typescript
import { initSSE, writeSSE } from '../sse.js';

router.get('/stream', async (req, res) => {
  initSSE(req, res);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    while (!aborted) {
      try {
        writeSSE(res, 'status', buildPayload());
      } catch (err) {
        if (aborted) break;
        log.error(`SSE error: ${err}`);
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  } finally {
    res.end();
  }
});
```

`initSSE` sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`, flushes headers, and installs a 30s heartbeat comment (`: ping\n\n`) to survive Cloudflare's ~100s idle timeout — you get this for free, don't duplicate it. `writeSSE(res, event, data)` writes `event: <event>\ndata: <JSON.stringify(data)>\n\n`.

**Two SSE patterns in this codebase:**
- **Poll-and-push** (`status.ts` `/stream`): loop with `setTimeout`, rebuild the payload each tick, write it. Simple, used when the underlying data has no natural event source.
- **Subscriber push** (`tool-calls.ts` backed by `proxy/tool-call-logger.ts`): `subscribe(callback)` / `unsubscribe(callback)` register a per-connection callback invoked synchronously when new data arrives (e.g. `logToolCall(...)`); the route calls `writeSSE` from inside that callback and calls `unsubscribe` on `req.on('close', ...)`. Use this when you already have a service emitting discrete events (ring buffer + subscriber list) instead of polling a cache on a timer.

**SSE routes are exempt from the general rate limiter** by path suffix (`/stream`) — see `rate-limit.ts` — don't add a limiter to a stream endpoint; reconnect storms will trip it.

## 6. Update `server/docs/API.md`

Find the right `##` section (or add one) and insert a `### METHOD /api/path` entry following the existing format exactly:

```markdown
### `GET /api/foo/:name`

**Auth:** viewer  
**Description:** One-line description.  
**Response:**
\`\`\`json
{ "...": "..." }
\`\`\`
```

For SSE endpoints, note `**Content-Type:** text/event-stream` instead of a JSON response block (see the `/api/status/stream` entry for the exact wording to mirror). If the route introduces a new admin-only prefix, also add it to the Auth table near the top of the doc.

## 7. Testing — supertest, mocked/in-memory DB, never live SQLite or `fetch()`+`listen()`

Per `CONTRIBUTING.md`: use `supertest` (in-process), never `fetch()` + `app.listen()` — Bun's `fetch` has a connection-pool bug that silently drops response bodies (`200 {}`) under GitHub Actions CI, even though it passes locally. "Mocked database" in practice means: point `createDatabase()` at `:memory:` (real `bun:sqlite`, not the real `fleet.db`) inside `beforeEach`, and `closeDb()` in `afterEach`. This is NOT a mock of the database module — it's a real, ephemeral SQLite instance, which is what "not a live SQLite connection" means (not the persistent `$FLEET_DIR/data/fleet.db`).

Copy this skeleton from `server/src/web/routes/directives.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, closeDb } from '../../services/database.js';

// Mock modules your route imports transitively that aren't relevant to this test
// (rate limiters, nudge state, etc.) — do this BEFORE importing the router under test.
mock.module('../middleware/rate-limit.js', () => ({
  agentControlLimiter: (_req: any, _res: any, next: any) => next(),
  generalPostLimiter: (_req: any, _res: any, next: any) => next(),
}));

import fooRouter from './foo.js';

const app = express();
app.use(express.json());
app.use('/api/foo', fooRouter);

describe('foo routes', () => {
  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('returns 404 for unknown agent', async () => {
    const res = await request(app).get('/api/foo/unknown-agent');
    expect(res.status).toBe(404);
  });

  it('creates and reads back a record', async () => {
    const post = await request(app).post('/api/foo/drifter-gale').send({ text: 'hi' });
    expect(post.status).toBe(201);
    const get = await request(app).get('/api/foo/drifter-gale');
    expect(get.body).toHaveProperty('id', post.body.id);
  });
});
```

If the route reads `AGENTS`/`config` (e.g. `validateAgentName`), use `setConfigForTesting(testConfig)` from `../../config.js` inside `beforeEach` — do NOT `mock.module('../config.js')`, it's process-global under CI's `maxConcurrency=1` and will contaminate unrelated test files (see the comment at the top of `directives.test.ts`).

For factory-style routers with no DB (e.g. `map.ts`, which proxies an external HTTP call), mock `globalThis.fetch` directly instead of the DB — see `map.test.ts`.

For SSE routes: unit-test `initSSE`/`writeSSE` in isolation with a hand-rolled mock `Response` (`{ setHeader, flushHeaders, write }`, no real socket — see `sse.test.ts`'s `describe("initSSE")` block), then integration-test the live stream with `supertest` for the 400/validation paths only (per `agent-stream.test.ts`, streaming itself needs a raw `node:http` client with a timed collection window — see `sse.test.ts`'s `openStream()` helper — supertest's default request/response cycle isn't built for a connection that never resolves).

### Bun testing gotchas (from `CONTRIBUTING.md`)
- `mock.module()` is process-global — avoid mocking commonly-imported modules (config, database) unless you have no alternative.
- `spyOn` requires namespace imports; named imports capture direct references `spyOn` can't intercept.
- `global.fetch` is not restored by `mock.restore()` — save `const originalFetch = globalThis.fetch` and restore manually in `afterEach`.
- Run one file in isolation while iterating: `bun test server/src/web/routes/foo.test.ts`.
