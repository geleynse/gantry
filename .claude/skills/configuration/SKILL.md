---
name: configuration
description: Use when editing gantry.json, adding/removing a config field, debugging why a config change didn't take effect, tracing FLEET_DIR/GANTRY_ENV resolution, or explaining hot-reload vs snapshot config behavior.
---

# Configuration — Gantry Server

Two layers: `gantry.json` (fleet/agent settings, hot-reloaded) and environment variables (port, paths, secrets, set once at process start). Full field-by-field reference: `docs/configuration.md`. This skill covers the *mechanics* — resolution, reload, and the copy-block gotcha — that the reference doc doesn't.

## Config file location

`server/src/config/fleet.ts::resolveConfigPath(fleetDir)` tries, in order, and uses the first that exists:

1. `$FLEET_DIR/gantry.$GANTRY_ENV.json` — only if `GANTRY_ENV` env var is set
2. `$FLEET_DIR/gantry.json`
3. `$FLEET_DIR/fleet-config.json` — backward-compat name

Throws with the full list of tried paths if none exist.

`FLEET_DIR` itself is resolved by `server/src/config/env.ts::resolveFleetDir()`, in order:

1. `FLEET_DIR` env var, if set — **throws immediately if the directory doesn't exist** (no fallback)
2. `../fleet-agents` relative to `process.cwd()` — the monorepo dev layout; used only if `FLEET_DIR` is unset
3. In tests (`NODE_ENV=test` or `BUN_ENV=test`): `/dev/null` placeholder — tests must call `setConfigForTesting()`
4. Otherwise: throws `FLEET_DIR not configured`

```bash
GANTRY_ENV=staging bun run dev   # loads $FLEET_DIR/gantry.staging.json
```

## Hot-reload: what's live vs what's a snapshot

`fleet.ts` calls `watchFile(configPath, { interval: 5000 }, ...)` — polls the resolved config file **every 5 seconds** and re-parses on change via the same `loadConfig()` used at startup. On success it updates `AGENTS`, `AGENT_NAMES`, `TURN_SLEEP_MS`/`TURN_INTERVAL` and the module-level `cachedConfig`. On parse failure it logs and **keeps serving the last good config** — a bad edit doesn't crash the process.

Two ways code reads config, with different freshness:

- **`getConfig()`** (`config/fleet.ts`) — always returns the current `cachedConfig`, i.e. picks up hot-reloaded values. Call sites that deliberately re-fetch this per-request for hot-reload support: `agentDeniedTools` deny checks, `prayEnabled` checks, `routineMode` checks, `outbound.forum`/`outbound.chat` policy lookups (all in `proxy/gantry-v2.ts`).
- **`createGantryServerV2(config, shared, allowedTools?)`** (`proxy/gantry-v2.ts`) — takes `config: GantryConfig` as a **parameter**, captured once when the MCP server/session is created. Fields read only from this captured snapshot do *not* pick up a hot-reload without a new connection.

Rule of thumb: if you're adding logic that should react to a `gantry.json` edit without an agent reconnect, call `getConfig()` inside the handler — don't rely on the `config` closure param.

## The loadConfig field-copy gotcha (verified live example)

`loadConfig()` in `server/src/config/fleet.ts` does **not** return `fleetConfig` (the Zod-parsed object) directly. It builds a new object by hand:

- **Per-agent fields**: `agents = fleetConfig.agents.map(a => ({ ...a, socksPort, mcpPreset }))` — a **spread**, so every field in `AgentConfigSchema` passes through automatically. Protected by a real test: `server/src/config/fleet.test.ts` → `"loadConfig preserves all AgentConfigSchema fields"` (iterates `Object.keys(AgentConfigSchema.shape)` and asserts each round-trips). This guards against a *future* refactor away from the spread, not against forgetting a field today.
- **Top-level `GantryConfig` fields**: built as a literal object listing each field individually (`agents, gameUrl, gameApiUrl, ..., cargoSaturationGuard`). **There is no analogous test that iterates `FleetConfigSchema.shape` for the top level.** Nothing fails CI if you add a field to `FleetConfigSchema` (schemas.ts) and `GantryConfig` (types.ts) but forget to add it to this return block — the config validates fine, TypeScript is happy (the field is optional on the interface), and the value is silently `undefined` at runtime.

**This is not hypothetical — it's currently true for `survivability`.** `survivability` is defined in `FleetConfigSchema` (schemas.ts) and in the `GantryConfig` interface (types.ts), it's documented in `docs/configuration.md`, and it's read via `config.survivability` in `proxy/auto-cloak.ts` and `web/routes/survivability.ts`. But the `loadConfig()` return block in `fleet.ts` never copies `fleetConfig.survivability` — so a `survivability` block in `gantry.json` passes schema validation and then vanishes; `getConfig().survivability` is always `undefined`. Treat this as the canonical illustration of the gotcha, not as something already fixed by the existing test.

### How to add a new top-level `gantry.json` field, end to end

1. Add the field to `FleetConfigSchema` in `server/src/config/schemas.ts` (Zod, `.optional()` unless truly required).
2. Add it to the `GantryConfig` interface in `server/src/config/types.ts` (or derive via `z.infer` if it's a schema-backed type with no name-shape divergence).
3. **Add it to the return object in `loadConfig()`** in `server/src/config/fleet.ts` — apply any default here (`fleetConfig.foo ?? DEFAULT`). This step has no automated safety net for top-level fields; double-check it by hand.
4. Add/extend a test in `server/src/config/fleet.test.ts` (or `server/src/config.test.ts`) that round-trips the field through `loadConfig()` — don't rely on the schema test alone.
5. Document it in `docs/configuration.md` (and `examples/gantry.json.example` if it's something users are likely to set).
6. If it's per-agent instead of top-level, add it to `AgentConfigSchema` — the spread in the agents `.map()` picks it up for free, but still add a case to the `"loadConfig preserves all AgentConfigSchema fields"` test for documentation value.

## Environment variables

| Variable | Read in | Default | Notes |
|---|---|---|---|
| `FLEET_DIR` | `config/env.ts` | `../fleet-agents` if it exists, else error | See resolution order above |
| `PORT` / `GANTRY_PORT` | `config/env.ts` | `3100` | `PORT` wins if both set |
| `GANTRY_ENV` | `config/env.ts` | unset | Selects `gantry.$GANTRY_ENV.json` |
| `LOG_LEVEL` | `config/env.ts` | `"DEBUG"` in code | **Doc mismatch** — `docs/configuration.md` says default `info`; `server/AGENTS.md` says `debug` (matches code). Trust the code: default is `DEBUG`. |
| `GANTRY_SECRET` | credential encryption path | auto-generated, saved to `$FLEET_DIR/data/.gantry-secret` (mode 0600) | Priority is env var > persisted file > auto-generate (`crypto.ts`), so the key survives restarts as long as `$FLEET_DIR/data` persists (it's a declared Docker `VOLUME`). Set explicitly if `$FLEET_DIR/data` isn't persisted across restarts/redeploys. |
| `GANTRY_MOCK` | `config/env.ts` | `false` (`=== "1"` check) | See the `mock-mode` skill |
| `TRUST_PROXY` | `app.ts` (read directly, not centralized in `env.ts`) | unset/`0` | Set `1` behind a reverse proxy so IP-based auth reads `X-Forwarded-For` |
| `GANTRY_URL` | `web/routes/map.ts` (read directly) | `http://localhost:3100` | Self-referencing URL for the internal map proxy |
| `GANTRY_PUBLIC_DIR` | `app.ts` (read directly) | unset (falls back to embedded/on-disk detection) | Set by the Docker image (`ENV GANTRY_PUBLIC_DIR=/app/dist/public`) — not documented in `docs/configuration.md` |
| `DEVTOOLS_URL`, `DEVTOOLS_FLEET_PROJECT_ID` | `lib/devtools.ts`, `web/routes/agent-sessions.ts` | `http://127.0.0.1:3456`, `-home-spacemolt-fleet-agents` | Optional Sessions-tab integration |

Note: only the first handful (`FLEET_DIR`, `PORT`/`GANTRY_PORT`, `GANTRY_ENV`, `LOG_LEVEL`, `GANTRY_MOCK`, plus timing knobs like `MARKET_SCAN_INTERVAL_MS`) are centralized in `config/env.ts`. `TRUST_PROXY`, `GANTRY_URL`, `GANTRY_PUBLIC_DIR`, `DEVTOOLS_*` are read with `process.env.X` at their point of use — grep for the name if you need to trace one.

## `turnInterval` → `turnSleepMs` rename (doc mismatch)

`FleetConfigSchema` accepts both `turnSleepMs` (current) and `turnInterval` (`@deprecated`, backward-compat only). `loadConfig()` prefers `turnSleepMs`, falls back to `turnInterval`, and logs a warning if only the deprecated name is present. **`docs/configuration.md` still shows `turnInterval` as the primary field name** in the schema example, and so does `examples/gantry.json.example` — they haven't been updated for the rename. (`server/docs/CONFIG.md` is just a 3-line stub that redirects to `docs/configuration.md` — the actual mismatch lives there, not in the stub.) Prefer `turnSleepMs` in new configs; don't be surprised the docs disagree.

## Config sections at a glance (see `docs/configuration.md` for full detail)

| Section | Purpose |
|---|---|
| `agents[]` | Per-agent identity, backend/model, MCP version/preset, role, tool format |
| `auth` | Access control adapter + config — see the `auth` skill |
| `mockMode` | Boolean or object — offline testing — see the `mock-mode` skill |
| `accountPool` | Path to `account-pool.json` for centralized credential assignment |
| `agentDeniedTools` / `callLimits` | Per-agent tool blocks and per-tool call caps |
| `coordinator` | Multi-agent role-distribution supervisor |
| `overseer` | Autonomous fleet-monitoring agent |
| `survivability` | Auto-cloak thresholds — **currently dropped by `loadConfig()`, see gotcha above** |
| `outbound` | Review policy (`require_approval` / `auto_approve_with_log` / `disabled`) for forum/chat/discord output |
| `mcpPresets` | Maps preset/role name → v2 tool list, used to filter tools per agent |
| `prayer`, `forumUrl`, `validateCredentialsOnStartup`, `cargoSaturationGuard` | Smaller standalone knobs, self-explanatory in the schema |

## Validation

Config is Zod-validated at load (`FleetConfigSchema.safeParse`) and on every hot-reload poll. Startup failures throw with a field-path list; hot-reload failures log and keep the last good config. `accountPool` path existence is checked eagerly in `loadConfig()` (throws if the file is missing) — this one *does* fail startup, unlike a missing-but-valid optional field.
