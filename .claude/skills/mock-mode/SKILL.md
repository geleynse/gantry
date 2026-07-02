---
name: mock-mode
description: Use when running Gantry locally without a live fleet/game connection — verifying a UI change, reproducing a proxy bug, demoing the dashboard, or writing/running tests that shouldn't hit game.spacemolt.com. Never point a dev server at a production fleet — use this instead.
---

# Mock Mode — Gantry Server

Mock mode swaps the real `GameClient` for `MockGameClient` (`server/src/proxy/mock-game-client.ts`), which returns canned JSON and simulates lightweight per-agent state (credits, fuel, cargo) in memory. No game account, no network call to `game.spacemolt.com`, no `fleet-credentials.json` required. Full config reference: `docs/mock-mode.md`. This skill covers enabling it correctly, what's real vs faked, and how it's used in tests — so you never need to point a dev instance at a real fleet just to check a change.

## Enabling it

Two independent mechanisms, with a precedence rule (`server/src/config/fleet.ts::loadConfig()`):

```bash
# Env var — zero gantry.json changes, best for CI / quick local checks
GANTRY_MOCK=1 bun dist/index.js
```

```jsonc
// gantry.json — fine-grained control, wins over the env var
{ "mockMode": true }
// or the object form:
{ "mockMode": { "enabled": true, "responsesFile": "./my-responses.json", "tickIntervalMs": 0, "initialState": { "credits": 10000, "fuel": 100 } } }
```

**Precedence, verified in `fleet.ts`**: if `mockMode` is present anywhere in `gantry.json` (including explicitly `{ enabled: false }`), that value wins outright — the env var is never consulted. `GANTRY_MOCK=1` only takes effect when the `mockMode` key is **absent** from the config file entirely. This means setting `mockMode: { enabled: false }` in `gantry.json` will keep a dev server pointed at the real game server even with `GANTRY_MOCK=1` set — a common trap if you copy a teammate's config that has mock mode explicitly disabled.

`env.ts`: `export const GANTRY_MOCK = process.env.GANTRY_MOCK === "1"` — only the literal string `"1"` activates it; `"true"` does not.

## What else mock mode skips at startup (`server/src/index.ts`)

Two startup side-effects are gated on `!config.mockMode?.enabled` and silently skipped in mock mode, on top of the game client swap itself:

- **Credential validation** (`validateAllCredentials`) — normally does an advisory login against the real game API on startup even when `validateCredentialsOnStartup` isn't explicitly false; skipped entirely in mock mode.
- **Catalog fetch** (`fetchAndCacheCatalog`) — normally fetches items/recipes/ships from the real game API (24h file cache); skipped in mock mode.

So mock mode is genuinely zero-network for game-server calls, not just for tool execution.

## Canned responses (`examples/mock-responses.json`, default `responsesFile`)

Flat JSON object, one key per tool/action name (e.g. `"login"`, `"get_status"`, `"travel_to"`), value is the literal response object returned to the agent for that call. A `"default"` key is the fallback for any action not explicitly listed — this is what keeps unfamiliar tool calls (combat, forum) from erroring out a session instead of just returning a canned success. `_comment`/`_docs`/`_usage` keys throughout are documentation-only, ignored by the loader. Point `responsesFile` at your own JSON to override/extend — same flat shape. Unlike other file-path config fields (e.g. proxy `.conf` paths), `responsesFile` is used as-is (`mock-game-client.ts::loadResponses()`), not joined against `FLEET_DIR` — a relative value resolves against the process's working directory, so prefer an absolute path or run from the expected cwd.

`MockGameClient` also maintains its own `initialState`-seeded in-memory state (`server/src/config/types.ts::MockInitialState`: `credits`, `fuel`, `location`, `dockedAt`, `cargo`) independent of the canned-response file — the two combine: canned response *shape*, live-mutated state *values*.

## What is and isn't simulated

**Stateful (Tier-2)** — mutates the in-memory `MockAgentState` on each call, so multi-step flows show plausible progressions: `login`/`logout` (session flag), `get_status`/`get_credits`/`get_fuel`/`get_location`/`get_cargo`/`get_cargo_summary` (reads), `get_system` (returns canned system, patches `id` to whatever was requested), `travel_to` (−8 fuel, updates `poi`/`dockedAt`), `jump` (−10 fuel, clears docked state), `dock`/`undock`, `mine`/`batch_mine` (adds `iron_ore`), `refuel` (fuel↑, credits↓), `sell`/`multi_sell`/`buy` (cargo↔credits at a small hardcoded price table — `iron_ore: 12`, `steel_plate: 45`, `copper_ore: 10`, `fuel_cell: 5`, else `8`/`10` sell/buy default), `repair` (hull→100 at 5cr/hp, no-op if already full), `craft` (2 `iron_ore` → 1 `steel_plate`), `view_market`/`view_storage`, `get_notifications` (empty list — prevents agent parse errors), `analyze_market`, `scan`, `get_missions` (explicit handler, not the generic default), note/log/doc tools.

**Not simulated (Tier-3, canned `default` only)** — `attack`, `get_battle_status`, `scan_and_attack`, `install_mod`, `get_skills`, `forum_*`, `trade_offer`, `chat`, and anything else not in the responses file (this does *not* include `get_missions`, which has its own explicit handler — see Tier-2 above). These always return `{ status: "ok", message: "Mock response: action completed successfully." }` regardless of arguments — no combat math, no forum content. Don't use mock mode to test combat logic or anything forum/social beyond the diary/doc/captain's-log/missions tools.

## Typical workflows

- **Verify a dashboard/UI change**: `GANTRY_MOCK=1 bun dist/index.js` (after `bun run build` — see the `build-and-dev` skill for why `bun run dev` alone won't rebuild a `.tsx` change), open `http://localhost:3100`. No `fleet-credentials.json` or real account needed.
- **Reproduce a proxy bug**: set `tickIntervalMs: 0` for instant responses (default is 500ms simulated tick delay) and a matching `initialState` if the bug depends on specific credits/fuel/cargo values; drive the same tool-call sequence a real agent would through the MCP endpoint.
- **Prompt iteration**: run a real agent CLI (`claude -p ...`) against a mock-mode Gantry instance — burns no game-API calls, only LLM API cost, while you tune wording/instructions.
- **Demo**: mock mode plus a populated `initialState`/custom `responsesFile` gives a fleet with plausible-looking data without any credentials at all.

## Limitations

- No real game economy, no other players, no persistence of the simulated world across restarts (state resets with the process — `defaultState()` reinitializes per session).
- Tier-3 tools never fail and never do anything meaningful — a test that asserts on combat/mission outcomes needs the real game server (or a hand-written mock response with a specific canned shape, not the stateful simulation).
- `MockGameClient` still goes through the real proxy pipeline (guardrails, injections, decontamination, tool-call logging) — it only replaces the game transport layer. Bugs in the pipeline itself reproduce fine in mock mode; bugs in real game-server behavior do not.

## Tests

Mock mode is the standard way Gantry's own test suite exercises multi-step flows without live network access:

- `server/src/__tests__/mock-mode-integration.test.ts` — drives `MockGameClient` directly (no HTTP), `tickIntervalMs: 0` for speed, covers a mining loop (`travel_to` → `mine` → `travel_to` station → `multi_sell`) plus the Tier-2 handlers above.
- `server/src/proxy/__tests__/smoke.test.ts` — full MCP pipeline end-to-end (`createMcpServer()` with `mockMode` enabled in the test `GantryConfig`), exercising initialize → login → tool call → verify, without any real WebSocket connection.
- `server/src/proxy/mock-game-client.test.ts` — unit tests on `MockGameClient` itself.

If you're adding a new compound tool or routine and want a CI-safe test (per `CONTRIBUTING.md`'s "test the full happy path plus at least two error cases" rule), build it on `MockGameClient` with `tickIntervalMs: 0` rather than mocking `fetch`/WebSocket by hand — it's the pattern the rest of the suite already uses.

## Where the client swap actually happens

`server/src/proxy/session-manager.ts::createClient(agentName, agentConfig)` checks `this.config.mockMode?.enabled` and instantiates `new MockGameClient(mockMode)` instead of the real `GameTransport` — **per agent, per session**, not a single process-wide swap. All downstream code (compound tools, routines, discovery service) is typed against `GameTransport | MockGameClient` and calls the same `execute()`/`login()`/`logout()`/`waitForTick()` interface either way, which is why mock mode exercises the real proxy pipeline rather than a separate code path.

`responsesFile` resolution: if omitted, `mock-game-client.ts` computes `DEFAULT_RESPONSES_FILE` relative to its own file location (`src/proxy/` → three levels up → `gantry/examples/mock-responses.json`) — this only works from the standard monorepo checkout layout. If you relocate the responses file, set `mockMode.responsesFile` explicitly rather than relying on the default path resolution.

## Related skills

- `configuration` — the `mockMode` schema (boolean shorthand vs object form), and where it fits among other `gantry.json` sections.
- `build-and-dev` — `GANTRY_MOCK=1 bun dist/index.js` as the recommended way to sanity-check a build without a live fleet.
- `testing` — general `bun:test` patterns; this skill covers the mock-mode-specific test helpers layered on top.

## The one rule this skill exists to enforce

Never set `FLEET_DIR` to a real fleet directory with real `fleet-credentials.json` and start a dev server without `mockMode`/`GANTRY_MOCK` unless you specifically intend to hit the live game server and burn real game-API calls under a real account. When in doubt, default to `GANTRY_MOCK=1`.
