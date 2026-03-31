# Contributing to Gantry

Thanks for your interest in contributing. This document covers the workflow, code standards, and PR guidelines.

## Getting Started

### Fork and Clone

```bash
# Fork on GitHub, then:
git clone https://github.com/your-username/gantry.git
cd gantry
bun install
```

### Build

```bash
bun run build        # server + dashboard
bun run build:server # server only (faster for proxy changes)
bun run build:client # dashboard only (Next.js static export)
```

### Development Mode

```bash
bun run dev
```

Starts the server in watch mode (hot reload on TypeScript changes). The dashboard requires a separate build step (`bun run build:client`) after React/Next.js changes.

### Run Tests

```bash
bun test                         # all tests (~4200)
```

All tests use `bun:test`. No Vitest, no Jest. Tests are co-located with source files.

## Code Style

- **TypeScript everywhere** — no plain JavaScript in the server
- **Explicit types** — avoid `any`; use the existing interfaces in `src/shared/`
- **Dependency injection** — new proxy modules get a `*Deps` interface, not direct imports of shared state
- **Structured logging** — use `createLogger("module-name")` from `src/lib/logger.ts`; never `console.log`
- **No barrel files** — import from the specific module, not from an `index.ts`

Look at `compound-tools-impl.ts` for the canonical proxy module pattern. Look at `web/routes/status.ts` for the canonical Express route pattern.

## Testing Requirements

**Every PR that changes behavior must include tests.**

- Proxy changes: add/update tests in the corresponding `*.test.ts` file
- New compound tools: test the full happy path plus at least two error cases
- Web routes: test with mocked database service, not a live SQLite connection

Test helpers are in `src/proxy/__tests__/` and `src/web/__tests__/`. Use them.

### Bun Testing Gotchas

- `mock.module()` is process-global — avoid mocking commonly-imported modules
- `spyOn` requires namespace imports (named imports capture direct references that spyOn cannot intercept)
- `global.fetch` is not restored by `mock.restore()` — save and restore manually

### HTTP Testing: Use supertest, Not Real TCP

**Do not use `fetch()` + `app.listen()` for Express route tests.** Use `supertest` instead.

Bun's `fetch` has a connection pool bug that causes empty response bodies (`{}`) when making requests to ephemeral Express servers in GitHub Actions CI. This manifests as:
- Tests pass locally on the exact same Bun version
- Tests fail in CI with `200 {}` instead of the expected JSON body
- The Express route handler IS being called (the server is running), but Bun's HTTP layer drops the response body

This was debugged extensively in PR #5 (March 2026). The root cause is in Bun's `node:http` compat layer — when servers are created/closed rapidly between tests, the connection pool misroutes or drops response data.

**Correct pattern (supertest — in-process, no TCP):**
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

**Wrong pattern (real HTTP — flaky in CI):**
```typescript
// ❌ Don't do this — breaks in GitHub Actions
const server = app.listen(0);
const res = await fetch(`http://localhost:${port}/health`);
```

**MCP endpoint caveat:** The MCP Streamable HTTP transport returns `text/plain` content-type, not `application/json`. Supertest only auto-parses `resp.body` for JSON content types. For MCP endpoints, parse `resp.text` manually:
```typescript
const resp = await request(app).post("/mcp").set(headers).send(body);
const data = JSON.parse(resp.text); // Don't use resp.body — it's {}
```

**Mock fetch responses:** When mocking `global.fetch` for `createMcpServer` initialization, return complete Response-like objects with `.text()`, `.status`, and `.headers`. The `fetchGameCommands` function calls `.text()` (not `.json()`) and `fetchWithRetry` checks `.status`:
```typescript
function fakeResponse(body: unknown, init?: { ok?: boolean; status?: number }) {
  const jsonStr = JSON.stringify(body);
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(jsonStr),  // Required!
  };
}
```

## PR Guidelines

**One feature per PR.** If you're fixing a bug and noticed another one, file a separate issue.

**Tests are required.** PRs without tests for changed behavior will not be merged.

**Squash commits.** Keep the main branch history clean. GitHub squash merge is fine.

**Describe the "why".** The PR description should explain the motivation, not just list what changed. What problem does this solve? What trade-off did you make?

### PR Title Format

```
feat: Add flee tool with evasive stance detection
fix: Correct jump arrival tick detection for multi-hop routes
docs: Add troubleshooting section to getting-started
chore: Update bun to 1.2.0
```

### What Makes a Good PR

- Clear title in the format above
- Description: what changed, why, what trade-offs were made
- Tests: all new behavior covered
- No unrelated changes (no "while I was in here" edits)
- Build passes: `bun run build && bun test`

## Reporting Issues

File issues on GitHub with:

1. **Gantry version** (git commit hash or release tag)
2. **What you expected** to happen
3. **What actually happened** (error message, log output, etc.)
4. **Reproduction steps** — minimal config and commands that trigger the issue

For suspected proxy issues, set `LOG_LEVEL=debug` and include the relevant log lines.

## Architecture Notes

Before making larger changes, read:

- `server/CLAUDE.md` — Server architecture, module map, key gotchas
- `server/src/proxy/compound-tools/` — Compound tool implementations
- `server/docs/API.md` — API endpoint reference

The proxy uses dependency injection throughout. Adding a new module means defining a `*Deps` interface and receiving shared state explicitly — no singletons, no global imports of mutable state.

The dashboard is a static Next.js export. Changes to React components require `bun run build:client` before they appear. The API shape between server routes and React hooks must stay in sync — see `src/shared/types.ts`.
