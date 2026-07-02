---
name: debug-proxy
description: Use when an agent gets a bad/unexpected tool result or error through the Gantry MCP proxy — investigating stuck sessions, stale cache, guard false-positives, retry storms, circuit-breaker trips, or instability warnings.
---

# Debugging the Proxy — Gantry

Systematic approach for "an agent got a weird result" or "an agent is stuck"
reports. Work top-down: logs → tool-call history → session state → server
health, before touching guard/injection code.

## 1. Turn up logging

```bash
LOG_LEVEL=debug bun run dev      # or set in the environment before `bun dist/index.js`
```

Format (from `src/lib/logger.ts`, `createLogger(category)`):

```
[2026-07-01T12:34:56.789Z] [DEBUG] [passthrough] jump BEFORE | agent: rust-vane, system: sol_prime, dest: void_reach, fuel: 42, tick: 118, server_tick: 119, drift: 1
```

`[LEVEL] [category] message | key: value, key2: value2`. Useful categories
to grep for: `pipeline`, `passthrough`, `registry`, `gantry-v2`,
`compound-tools`, `fuel-floor-guard`, `circuit-breaker`, `session`,
`instability-hints`, `instability-metrics`, `proxy` (constants/reformat).
`console.error` is used for WARN/ERROR, `console.log` for INFO/DEBUG — pipe
accordingly if you're filtering stdout vs stderr.

## 2. Read the tool-call history — two-phase pending→complete records

Every tool call writes a row to the `proxy_tool_calls` SQLite table
(`$FLEET_DIR/data/fleet.db`) via `tool-call-logger.ts`:

- `logToolCallStart(agent, toolName, args, opts)` inserts a row with
  `status = "pending"` and returns a numeric `pendingId`.
- `logToolCallComplete(pendingId, agent, toolName, result, durationMs, opts)`
  updates that same row to `status = "complete"` or `"error"`, filling in
  `result_summary`, `duration_ms`, `success`, `error_code`.

Columns worth querying directly: `agent`, `tool_name`, `args_summary`,
`result_summary`, `success`, `error_code`, `duration_ms`, `is_compound`,
`status`, `trace_id`, `parent_id` (compound tools log sub-calls with
`parent_id` pointing at the parent row — same mechanism PrayerLang uses to
build its execution tree), `timestamp`.

A row stuck at `status = "pending"` with no matching complete update means
the call never returned — either it's still in flight, or the process
crashed/restarted mid-call (the `pendingId` insert survives; nothing ever
calls `logToolCallComplete` for it). That's a strong signal to check for a
server restart or an unhandled exception around that timestamp.

**Where to look besides raw SQL**: `GET /api/tool-calls` (REST, backed by the
same table) and `GET /api/tool-calls/stream` (SSE, dashboard `/activity`
page) — both live in `src/web/routes/tool-calls.ts`. The logger also keeps an
in-memory 200-entry ring buffer (`getRingBuffer()`) and pushes to subscribers
synchronously on both start and complete, independent of the SQLite write —
if SQLite writes are failing (caught and logged as a warning, non-fatal), the
live dashboard feed can still show data the DB doesn't have.

## 3. Session / login problems

Common error strings and what they mean:

- `"not logged in — call login first"` — `getAgentForSession()` found no
  agent bound to this MCP session ID. Check `sessionAgentMap`, then
  `sessionStore.getSession(sessionId)` (persistent fallback), then the
  restart-recovery path (exactly one unmapped authenticated client → auto-
  bind). If restart recovery logs `"ambiguous restart recovery"`, more than
  one agent is unmapped and the proxy refuses to guess.
- `"no session"` — agent is bound to the MCP session, but
  `sessions.getClient(agentName)` returned nothing (game client never
  created, or was torn down).
- `"ERROR: Proxy session has expired or is offline. Please login again."` —
  v2-only, from `isProxySessionActive()` in `checkGuardrailsV2` — the
  `sessionStore` doesn't consider this session valid.
- `"Session iteration limit exceeded"` / `"turn has exceeded the maximum
  duration"` / `"idle too long"` — `checkIterationLimit` /
  `checkTurnTimeoutAndIdle` in `pipeline.ts`. Turn timeout has a 2-minute
  grace period during which cleanup calls (logout, captain's log) are still
  allowed — check whether the agent is inside that grace window before
  assuming a hard block.
- `SessionManager` (`session-manager.ts`) owns account-pool assignment and
  the game client map. `STALE_SESSION_THRESHOLD_MS` (5 min) controls whether
  a graceful logout is attempted on shutdown vs skipped as already-dead.
- `HttpGameClientV2` (`http-game-client-v2.ts`) has its own renewal circuit
  breaker: it used to trip `session_renewal_exhausted` (freezing
  `statusCache` — stale nav/cargo forever) after counting **lifetime**
  renewals; it's now a sliding window (max 5 renewals within a 180s window)
  so long healthy runs don't accumulate false trips. If you see frozen
  nav/cargo data that never updates despite the agent clearly still playing,
  suspect this breaker or a `refreshStatus()` failure loop — check for
  `renewSession`/`reauthPromise` log lines around that agent's `label`.

## 4. Error classification and hints

- `error-classifier.ts` maps HTTP status / network errno / MCP error code /
  game error code to `{ category, action, retryable }`. `action` is one of
  `retry | wait_retry | backoff | mark_down | log | pass` — this is what
  decides whether the transport layer retries automatically, backs off, or
  gives up and marks the server down. If an agent is retry-storming, check
  what category its error falls into and whether `retryable` should be
  `false` for that code.
- `error-hints.ts`'s `addErrorHint(errorMessage, context?)` appends a
  human-readable `Hint: ...` line to error text before it reaches the agent
  (wired in at the very end of `handlePassthrough()`'s error path, section
  "4. Error path"). Context-aware hints (cargo/credits/fuel-specific,
  location-specific) are tried first via `getContextualHint()`, falling back
  to a flat substring/regex list (`ERROR_HINTS`). If an agent is looping on
  an error without ever getting corrective guidance, check whether that error
  string matches (or nearly matches) a pattern here — hint patterns are
  substring-based and case-lowered, so near-misses are easy to spot by eye.

## 5. Circuit breaker

`circuit-breaker.ts`'s `CircuitBreaker` (closed → open → half-open) gates new
game-server connection attempts per label (one breaker per agent, via
`BreakerRegistry`, so one agent's outage doesn't block the fleet). Defaults:
`failureThreshold: 3` consecutive failures trips it open,
`successThreshold: 2` half-open probes close it, `cooldownMs: 60_000`. Check
`GET`-style breaker status (aggregate or per-agent) exposed through the
health endpoint if an agent's calls are all failing instantly without
hitting the network — that's `allowConnection()` returning `false` because
the breaker is open, not the game server itself.

## 6. Server-wide instability

`instability-metrics.ts`'s `MetricsWindow` computes a rolling `ServerStatus`
over a 10-minute window from request/error counts:

| Status | Condition |
|---|---|
| `healthy` | error rate < 3% |
| `degraded` | 3–10% error rate — agents warned, continue normally |
| `unstable` | > 10% error rate — agents warned, expect failures |
| `recovering` | was down, now probing |
| `down` | no successful request for 2+ minutes |

`instability-hints.ts`'s `checkToolBlocked(toolName, status)` **hard-blocks**
non-safe tools only when status is `down` (a fixed `SAFE_TOOLS` allowlist —
status/info/login/logout/notes — always passes). `degraded`/`unstable`/
`recovering` never block, only warn via the `instability-hint` injection
(`server_notice` key). If an agent reports being unable to do anything, check
`ctx.serverMetrics.getMetrics().status` — if it's `down`, that's global and
expected; if it's anything else, the block is coming from a different guard
and the instability gate is not the cause.

## 7. Known failure modes worth checking first

- **Fuel-floor / cargo-full-dock guards failing open on stale cache**:
  both guards (`fuel-floor-guard.ts`) explicitly refuse to block when the
  cached status is older than `GUARD_STALE_CEILING_MS` (5 minutes) — a
  frozen "0 fuel" reading is worse than no guard, since it could itself
  cause the stranding it exists to prevent. If a guard "isn't working," check
  whether the cache is in fact fresher than 5 minutes; if it's stale, the
  guard is behaving correctly by staying out of the way.
- **YAML `toolResultFormat` breaks Codex/rmcp**: an agent configured with
  `toolResultFormat: "yaml"` gets responses reformatted by
  `reformatResponse()` in `proxy-constants.ts`. Codex's `rmcp` client library
  expects JSON-RPC text content and chokes on YAML. If a non-Claude backend
  agent is failing to parse every tool result, check
  `config.agents[].toolResultFormat` for that agent first.
- **Contamination stripping removing real content**: `decontaminateLog()` +
  `CONTAMINATION_WORDS` (see the `proxy-pipeline` skill) will silently drop
  or redact captain's-log entries containing any listed word/phrase — the
  filter has no per-agent exception list. If a captain's log entry the agent
  clearly wrote is missing, check whether it tripped a contamination word
  (common false-positive source: legitimate use of "sync" as a system name,
  called out in the word list's own comments as a known tension).
- **Pre-dock / dock-verification false negatives**: the pre-dock non-
  dockable check and post-dock verification retry
  (`passthrough-handler.ts`, sections "1e" and the `dock` branch of "3")
  both trust `statusCache` — a stale `current_poi` can produce either a
  false `known_non_dockable` block or a false `dock_verification_failed`
  after a real dock succeeds. Check `cache_age_ms` in the accompanying log
  line before trusting either.

## 8. Reproducing locally without a live fleet

Mock mode replaces the game client with `MockGameClient` — canned responses,
no network/game account needed:

```bash
GANTRY_MOCK=1 bun dist/index.js
```

or set `"mockMode": true` (or an object with `initialState`/`responsesFile`)
in `gantry.json`. See `docs/mock-mode.md` for the full config surface
(there's a dedicated skill for authoring mock-mode fixtures if you need more
than the quick-start). Use this to reproduce guard/pipeline bugs without
risking a live agent's game state.
