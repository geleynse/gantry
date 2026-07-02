# Gantry Skill Library

Task-scoped playbooks for working on Gantry — the MCP proxy + live dashboard for
SpaceMolt AI fleets (Bun runtime, Express 5, React 19 / Next.js 15 static export,
`bun:sqlite`). Each skill is a self-contained, verified procedure aimed at a
mid-level engineer or Sonnet-class model with zero prior context.

Skills auto-activate on their `description` triggers. This index is the map.

## Where to start

- New to the repo? Read `build-and-dev`, then `mock-mode` (so you never point a
  dev server at a live fleet), then the skill for your task below.
- Root context lives in `AGENTS.md`, `server/AGENTS.md`, `CONTRIBUTING.md`, and
  `docs/`. Skills call out where those docs have gone stale.

## Skills by area

### Build, test, run
| Skill | Use it when |
|-------|-------------|
| `build-and-dev` | Building server/dashboard, the dev loop, the binary, or a UI change "won't show up" after editing `.tsx`. |
| `testing` | Writing/running tests, flaky supertest failures, mocking `createMcpServer`/`global.fetch`, prepping a PR. |
| `mock-mode` | Running locally with no live fleet/game — verify UI, reproduce a proxy bug, demo. Read before any local run. |

### Proxy (MCP request path)
| Skill | Use it when |
|-------|-------------|
| `proxy-pipeline` | Adding a guardrail/injection, changing tick-wait/enrichment, or reasoning about v1 vs v2 dispatch and the hot-reload snapshot gotcha. |
| `add-compound-tool` | Adding a multi-step proxy-side tool (batch_mine/travel_to/flee style). |
| `add-v2-action` | Exposing a new action on the v2 `spacemolt(action="...")` dispatch surface. |
| `debug-proxy` | An agent gets a bad/unexpected tool result: stuck sessions, stale cache, guard false-positives, retry storms, circuit-breaker trips. |
| `prayerlang` | Extending/debugging the PrayerLang DSL (the `spacemolt_pray` bounded scripts). |

### Web server, data, frontend
| Skill | Use it when |
|-------|-------------|
| `add-api-route` | Adding/debugging a REST or SSE endpoint under `/api/*`. |
| `database-and-services` | New tables, service modules, direct SQLite writes, or `fleet.db` schema/WAL issues. |
| `frontend-dashboard` | Editing `src/app/` or `src/components/`, adding a page, wiring a hook/SSE, admin-gating a control. |

### Config, auth, fleet ops, deploy
| Skill | Use it when |
|-------|-------------|
| `configuration` | Editing `gantry.json`, adding a config field, hot-reload vs snapshot behavior, `FLEET_DIR`/`GANTRY_ENV` resolution. |
| `auth` | Configuring/debugging auth adapters, unexpected 403s or admin access, wiring a new adapter. |
| `add-routine` | Adding/debugging a deterministic multi-step game routine (`sell_cycle`, `mining_loop`, …). |
| `agent-process-management` | Agent lifecycle: shows offline but running, orphaned processes, stale PID, missing logs, watchdog. Mutates a live fleet — use mock mode / scratch `FLEET_DIR` in dev. |
| `deploy-and-release` | Docker/systemd/binary deploy, cutting a release, what CI actually gates, production auth/env. |

## Known stale docs (flagged inside the relevant skills)

These were found during authoring and are corrected in the skills, not in the
source docs (fixing docs is out of scope for the skill library):

- `AGENTS.md` says register routes in `ROUTE_REGISTRATIONS`/`route-config.ts` —
  that file does not exist; real point is `web/routes/api-routes.ts`
  (`createApiRoutes()`). See `add-api-route`.
- `CONTRIBUTING.md`/`docs/compound-tools.md` cite `compound-tools-impl.ts` as
  canonical — it is now a re-export shim; real code is per-file under
  `compound-tools/`. See `add-compound-tool`.
- `docs/prayer.md` predicate/command lists and defaults are out of date vs the
  real parser (`max_steps`/`timeout` defaults, required parens, missing
  predicates/commands). See `prayerlang`.
- `docs/auth.md`: `layered.adminDomains` is accepted but never read; `deny` and
  `domain` adapters exist but are undocumented; `local-network` default ranges
  also include `127.0.0.1/32`. See `auth`.
- `docs/configuration.md` `LOG_LEVEL` default and `turnInterval` (deprecated for
  `turnSleepMs`) are stale. See `configuration`.
- `docs/architecture.md` "7 injections" — real default registry has more. See
  `proxy-pipeline`.

## Live bugs surfaced during authoring (not fixed here — file/fix separately)

- `survivability` is in the config schema and consumed by
  `proxy/auto-cloak.ts` + `web/routes/survivability.ts`, but is missing from the
  `loadConfig()` field-copy block in `config/fleet.ts` — so it is always
  `undefined` at runtime. This is the exact "forgot to add the field to the copy
  block" gotcha the `configuration` skill warns about.
- CI's `bun test` step is `continue-on-error: true` — a red suite does not fail
  CI; only `bun run build` is a hard gate (see `testing`/`deploy-and-release`).
