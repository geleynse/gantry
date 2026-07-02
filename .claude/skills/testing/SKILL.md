---
name: testing
description: Use when writing or running tests in Gantry (server routes, proxy modules, React components/hooks), seeing flaky Express/supertest failures, mocking createMcpServer/global.fetch, or preparing a PR that changes behavior.
---

# Testing — Gantry Server

All tests use `bun:test`. No Vitest, no Jest. Tests are **co-located** with source: `foo.ts` → `foo.test.ts` in the same directory (e.g. `src/web/routes/accounts.ts` / `src/web/routes/accounts.test.ts`), except a few suite-level integration/smoke tests that live in `src/proxy/__tests__/` and `src/__tests__/`.

## Running tests

```bash
bun test                                  # full suite (~4200 tests)
bun test src/proxy/__tests__/nudge-state.test.ts   # single file
bun test src/web/routes/accounts.test.ts           # single file (co-located)
bun run test:coverage                     # bun test --coverage
```

The `test` script in `package.json` is `bun test --max-concurrency=1` — the suite is run **serially**, not in parallel. CI (`.github/workflows/ci.yml`) runs plain `bun test` with `continue-on-error: true` and the comment "Known cross-file test pollution — all tests pass individually." In practice: if a test fails only when run as part of the full suite (not standalone), suspect shared/global state leaking between files (e.g. a module-level singleton, an un-restored `global.fetch`, a shared SQLite file) rather than a real bug in your change — re-run the file alone (`bun test path/to/file.test.ts`) to confirm before chasing it.

## Test helper locations

| Path | Provides |
|---|---|
| `server/src/test/index.ts` | Barrel re-export — `import { createMockConfig, createMockSharedState, createMockGameClient, createMockRequest } from "../test/index.js"` (or `@/test/index.js`) |
| `server/src/test/helpers.ts` | `createMockConfig()` (valid `GantryConfig`), `createMockSharedState()` (valid `SharedState` — sessions/cache/proxy/fleet), `createMockGameClient()` (stub `GameClient` — `execute`, `login`, `logout`, `waitForTick`, `refreshStatus`, `getCredentials`, `isConnected`), `createMockRequest()` (minimal Express `Request` stand-in) |
| `server/src/test/http-test-server.ts` | `startTestServer(app, opts?)` / `canBindLocalhost()` — spins up a real ephemeral-port HTTP server for tests that need one (e.g. WS or raw-socket tests where supertest doesn't apply); retries on bind failure |
| `server/src/test/setup.ts` | Preloaded before every test (see bunfig.toml below). Registers happy-dom globals, `@testing-library/jest-dom` matchers, a `localStorage` mock, `mock.restore()` + DOM reset in a global `beforeEach`, and exports `MockEventSource` (registered as `globalThis.EventSource`) |
| `server/src/test/mocks/agents.ts` | `createMockAgentStatus()`, `createMockProxyInfo()`, `createMockActionProxyStatus()`, `createMockFleetStatus()` — frontend `FleetStatus`/`AgentStatus` fixtures |
| `server/src/test/mocks/game-state.ts` | `createMockShipModule()`, `createMockCargoItem()`, `createMockShip()`, `createMockGameState()`, `createMockFleetGameState()` — `AgentGameState` fixtures (types defined locally to avoid pulling React hooks into server test context) |
| `server/src/test/mocks/hooks.ts` | `createMockAuthState()` / `createMockViewerAuthState()` / `createMockLoadingAuthState()`, `createMockSSEResult()`, `mockFetchResponse()`, `mockFetch()` — for hook tests |

Use these instead of hand-rolling fixtures; they keep required fields in sync with the real types.

## HTTP route tests: use supertest, never `fetch()` + `app.listen()`

Bun's `fetch` has a connection-pool bug that drops response bodies (`200 {}`) against ephemeral Express servers under GitHub Actions CI, even though the route handler ran correctly. This was debugged in PR #5 — don't reintroduce it.

**Correct:**
```typescript
import request from "supertest";
import express from "express";

const app = express();
app.get("/health", (_req, res) => res.json({ status: "ok" }));

it("returns health", async () => {
  const res = await request(app).get("/health");
  expect(res.body.status).toBe("ok");
});
```

**Wrong (flaky in CI):**
```typescript
// Don't do this
const server = app.listen(0);
const res = await fetch(`http://localhost:${port}/health`);
```

Real example, `src/web/routes/accounts.test.ts`: build a minimal `express()` app per test, inject `req.auth` via middleware, mount the router under test, assert on `res.status` / `res.body`.

**MCP endpoint caveat:** the MCP Streamable HTTP transport responds `text/plain`, not `application/json`. Supertest only auto-parses `resp.body` when the content-type is JSON — for MCP routes it stays `{}`. Parse `resp.text` manually:

```typescript
const resp = await request(app).post("/mcp").set(headers).send(body);
const data = JSON.parse(resp.text); // resp.body is {} here — don't use it
```

## Mocking `global.fetch` for `createMcpServer()` init

`createMcpServer()` fetches the game's tool schema over `fetch` during startup. Mocked responses must be complete Response-like objects — `fetchGameCommands` calls `.text()` (not `.json()`), and `fetchWithRetry` checks `.status`:

```typescript
function fakeResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  const jsonStr = JSON.stringify(body);
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(jsonStr),  // required — omit it and startup silently hangs/fails
  };
}
```

Real usage is in `src/proxy/integration.test.ts` and `src/proxy/__tests__/smoke.test.ts`: save `global.fetch` before the test, install a `mock(async (url, opts) => ...)` that branches on the URL, restore the original in `afterAll`/cleanup. `global.fetch` is **not** restored automatically — see gotchas below.

## bun:test gotchas

- **`mock.module()` is process-global.** It patches the module for the whole test process, not just the current file/test. Avoid mocking modules that are commonly imported elsewhere, or you'll get cross-file pollution (see the `--max-concurrency=1` note above).
- **`spyOn` requires namespace imports.** `import * as foo from "./foo.js"; spyOn(foo, "bar")` works. `import { bar } from "./foo.js"; spyOn(...)` does not — named imports capture a direct reference bun's spy can't intercept. Structure the module under test (or the test's import) accordingly.
- **`global.fetch` is not restored by `mock.restore()`.** If a test replaces `global.fetch`, save the original first and restore it explicitly (e.g. in `afterAll`), not just rely on the framework's auto-cleanup.

## React component / hook tests

Config lives in `server/bunfig.toml`:
```toml
[test]
preload = ["./src/test/setup.ts"]
testEnvironment = "jsdom"
maxConcurrency = 1
```

`src/test/setup.ts` (preloaded before every test file) does the setup work — you don't need to repeat it per test file:
- Registers `happy-dom` globals via `GlobalRegistrator.register(...)`, then restores the **native** `fetch` (happy-dom's fetch enforces CORS and breaks backend/API tests that also run in the same process).
- Imports `@testing-library/jest-dom` so `expect(...).toBeInTheDocument()` etc. work.
- Installs a working `localStorage` mock, reset per test.
- Runs `mock.restore()` and clears `document.body.innerHTML` in a global `beforeEach` — component tests don't need their own cleanup boilerplate for these.
- Defines and registers `MockEventSource` as `globalThis.EventSource` (happy-dom has none), with `simulateOpen()`, `simulateMessage(type, data)`, `simulateError()`, and a static `.instances` array reset each test — import it via `import { MockEventSource } from '@/test/setup'`.

Component test pattern (`src/components/__tests__/health-bar.test.tsx`):
```typescript
import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { HealthBar } from '../health-bar';

it('renders with a label when provided', () => {
  render(<HealthBar value={50} max={100} label="Hull" />);
  expect(screen.getByText('Hull')).toBeInTheDocument();
});
```

Hook test pattern (`src/hooks/__tests__/use-fleet-status.test.ts`) — drive SSE-backed hooks via `MockEventSource` and `@testing-library/react`'s `renderHook`/`act`/`waitFor`:
```typescript
import { renderHook, act, waitFor } from '@testing-library/react';
import { useFleetStatus } from '../use-fleet-status';
import { MockEventSource } from '@/test/setup';
import { createMockFleetStatus } from '@/test/mocks/agents';

const { result } = renderHook(() => useFleetStatus());
act(() => {
  MockEventSource.instances[0].simulateOpen();
  MockEventSource.instances[0].simulateMessage('status', createMockFleetStatus());
});
await waitFor(() => expect(result.current.data).not.toBeNull());
```

Use the `@/...` path alias (maps to `src/`) freely in tests — it's configured in both tsconfigs.

## What CI runs

`.github/workflows/ci.yml`, on every push/PR to `main`:
```bash
bun install          # (working-directory: server)
bun run build        # build:server + build:client
bun test              # continue-on-error: true, see pollution note above
```
Locally, match this with `bun run build && bun test` before opening a PR — a clean `bun run build` catches type errors in the client tree (esbuild itself doesn't type-check) and bundling errors in the server tree.

## PR testing requirements (from CONTRIBUTING.md)

- **Every PR that changes behavior must include tests.**
- **Proxy changes** — add/update the corresponding `*.test.ts`.
- **New compound tools** — cover the full happy path **plus at least two error cases**.
- **Web routes** — test with a mocked database service (`createMockSharedState()` / hand-rolled mock, per `src/web/routes/accounts.test.ts`), not a live SQLite connection.
- No unrelated changes in the same PR ("while I was in here" edits go in a separate PR).
