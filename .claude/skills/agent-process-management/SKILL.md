---
name: agent-process-management
description: Use when starting, stopping, restarting, or debugging the lifecycle of a fleet agent process — an agent shows offline in the dashboard while still running, a stale PID file, orphaned bun processes after a server restart, missing/stuck log output, or the health-monitor watchdog isn't restarting a crashed agent.
---

# Agent Process Management

## WARNING — this mutates a live fleet

Every function and route documented here spawns, kills, or restarts real bun
processes for real fleet agents against `$FLEET_DIR`. There is no dry-run mode.
When developing or testing against this code, use `mockMode: true` in
`gantry.json` (or `GANTRY_MOCK=1`) and/or point `FLEET_DIR` at a scratch
directory (`FLEET_DIR=./my-test-fleet bun run dev`) — see `docs/mock-mode.md`
and `docs/getting-started.md`. **Never point a dev server's `FLEET_DIR` at a
production fleet directory** — only one Gantry instance may run against a given
`FLEET_DIR` at a time, and start/stop/restart calls have no confirmation step.

## Source of truth: in-memory tracking, not PID files

`server/src/services/process-manager.ts` is the whole story:

- `trackedProcesses: Map<agentName, ChildProcess>` — populated by `newSession()`
  on spawn, cleared by the child's `exit` handler. **This is authoritative.**
  `isProcessAlive(child)` = `exitCode === null && !killed && pid !== undefined`.
- PID files at `$FLEET_DIR/data/pids/<name>.pid` are written by `writePidFile()`
  purely **for external tooling** (e.g. the fleet CLI's improve-loop, which spawns
  outside this server process). They are read for liveness (`isPidFileAlive()`,
  via `process.kill(pid, 0)`) **only as a fallback** when no in-memory ref exists
  for that name.
- `hasSession(name)` checks in-memory first, falls back to the PID file. This
  fallback is exactly why "agent shows offline but is running" happens after a
  server restart — the in-memory map is empty on a fresh process, so liveness
  depends entirely on a correct, non-stale PID file until the health monitor's
  next `hasSession()` call re-observes it.
- Logs: `$FLEET_DIR/logs/<name>.log`. `capturePane(name, lines)` tails it via
  `spawn('tail', ['-n', lines, logFile])` (never shells out with string
  interpolation). `services/log-parser.ts::parseAgentLog()` derives turn count,
  last-turn age, quota/auth hit counts, and a `running`/`backed-off`/`stale`
  state (`stale` = no turn line in the last 1800s) from the tail — this is what
  feeds the dashboard's per-agent status badge, separate from process liveness.
- `scanOrphanedProcesses()` — primary: reads every `*.pid` file under
  `$FLEET_DIR/data/pids/`, checks liveness, and reports any PID that's alive but
  **not** in `trackedProcesses` (i.e. survived a server restart with no
  in-memory ref). Fallback: `ps aux | grep -E 'gantry|fleet-agents'`. Returns
  `{ pid, cmd }[]` and kills nothing — the caller decides. **No API route or
  startup hook currently calls this** (grep confirms it's only referenced from
  its own test file) — to use it operationally today you invoke it from a REPL/
  script, or replicate the same two checks by hand: list
  `$FLEET_DIR/data/pids/*.pid` and cross-reference `ps aux`.

## Start/stop/restart flow

`server/src/services/agent-manager.ts` is the orchestration layer above
`process-manager.ts`; `server/src/web/routes/agents.ts` and
`server/src/web/routes/fleet-control.ts` are the HTTP surface.

**Guards `startAgent()` checks, in order:** fleet-disabled state
(`getFleetDisabledState()`), agent retired (`enabled: false` in config — refuses
permanently, message tells the operator to flip the config and redeploy),
already running (`hasSession`), then clears any overseer stop-cooldown
(`clearCooldownForOperatorStart` — an explicit operator start overrides an
overseer-initiated cooldown), then checks credential health, then clears stale
`stopped_gracefully`/`shutdown`/`inject` signals before spawning.

**`startAgentCanary(name)`** — used by PrayerLang's canary verification (see the
`prayerlang` skill) — is a variant that overrides the system prompt and
**bypasses the fleet-disabled guard**, so it can verify routing even with the
fleet paused. Still refuses if the agent is already running.

**Stop variants:** `forceStopAgent` (SIGTERM → SIGKILL after 2s, no grace),
`softStopAgent` (signals the running session to wind down cleanly), `stopAgent`
(plain backward-compat alias for `softStopAgent`, not a picker). Same
`force`/`soft` split for restart: `forceRestartAgent`, `softRestartAgent`,
`restartAgent` (alias for `softRestartAgent`). Fleet-wide: `startAll`,
`stopAll`, `forceStopAll`.

**Routes** (`agents.ts`, mounted under `/api/agents`):

| Method + path | Behavior |
|---|---|
| `GET /` | List all agents with shutdown/battle status, credential health |
| `GET /fleet-state` | Current fleet-disabled state |
| `POST /fleet-state/enable` / `/disable` | Toggle fleet-wide start guard |
| `POST /start-all` | `startAll()` |
| `POST /stop-all?force=true` | `stopAll()` or `forceStopAll()` |
| `GET /:name` | Full status + last 50 log lines + personality file |
| `PATCH /:name/config` | Change backend/model — **refuses while running** |
| `POST /:name/start` | `startAgent()` — also flips fleet-enabled on |
| `POST /:name/stop?force=true` | `forceStopAgent()` or `softStopAgent()` |
| `POST /:name/restart?force=true` | force/soft restart — also flips fleet-enabled |
| `POST /:name/stop-after-turn` | see below |
| `POST /:name/shutdown` | graceful shutdown request |

**`stop_after_turn`** — the agent finishes its current turn cleanly, then stops.
Two entry points both delegate to the same
`getSessionShutdownManager().requestStopAfterTurn(name, reason)`
(`proxy/session-shutdown.ts`): `POST /api/agents/:name/stop-after-turn`
(`agents.ts`, requires the agent already running) and
`POST /api/agents/:name/order { type: "stop_after_turn" }`
(`fleet-control.ts`, no `message` required for this order type — see
`fleet-control-stop-after-turn.test.ts` for the exact contract: 404 for unknown
agent, normal `message` orders still work unaffected).

## Enrollment

`server/src/web/routes/enrollment.ts` is how a brand-new agent gets onto the
fleet — separate from start/stop of an *existing* agent.

- `GET /api/agents/enrollment-options` — role types (from the `AgentConfigSchema`
  Zod enum), MCP presets (`basic`/`standard`/`full`), empire/faction options and
  role suggestions per empire, for the enrollment form.
- `POST /api/agents/enroll` (admin) — registers a new game account or attaches
  an existing one (`registerAccount`), writes a fleet-config entry
  (role/roleType/faction/mcpPreset/model), deploys the agent's prompt
  (`deployPrompt`), encrypts and stores credentials
  (`credentials-crypto.ts`), and audit-logs the event
  (`logEnrollmentEvent`).
- `POST /api/agents/:name/deploy-prompt`, `GET /api/agents/:name/prompt-preview`
  — redeploy/preview prompt files independent of full enrollment.

## Health monitoring — two distinct systems, don't conflate them

**1. The watchdog** (`services/health-monitor.ts`, exposed at
`GET /api/diagnostics/health-monitor` via `health-monitor-route.ts`) is a
crash-restart loop, not a metrics dashboard. `tick()` calls `hasSession()` per
agent and decides whether to restart:

- Skips entirely if the fleet is disabled, or the agent is retired
  (`enabled: false` — the durable "keep this down" switch, deliberately not
  undone by signal state alone).
- Won't restart if `desiredState === "stopped"` (an explicit prior stop), or if
  `stopped_gracefully`/`shutdown` signals are present (marks `desiredState`
  stopped and, if the stop reason was `rate_limit`, files a `quota_exhausted`
  alert so an operator notices overnight).
- Won't restart during an active overseer stop-cooldown
  (`isRestartSuppressed()`) — an indefinite `hold_offline` cooldown also flips
  `desiredState` to stopped; a timed cooldown just delays the retry.
- Otherwise treats a dead process with `desiredState: "running"` as a crash and
  restarts via `startAgent()` with exponential backoff:
  **30s → 60s → 120s → 300s → 600s (max)**, tracked per-agent as
  `consecutiveRestarts`/`nextRestartAfterMs`. The route surfaces
  `backoffRemainingSec` computed live from `nextRestartAfterMs`.

**2. Connection/session health** (`web/routes/health-details.ts` +
`services/session-metrics.ts` + `services/health-scorer.ts`, under
`/api/health/*`) is a different, unrelated concept: circuit-breaker state per
agent mapped to `connectionStatus` (`connected`/`disconnected`/`reconnecting`
from `closed`/`open`/`half-open`), latency percentiles, error-rate breakdown,
last successful command. This tells you if the game-server *connection* is
healthy, not whether the agent *process* is alive — an agent can be
`connected` and still be about to get restarted by the watchdog for an
unrelated reason, or vice versa.

## Overseer — 15-second version, full detail in `docs/overseer.md`

The Overseer is an optional 6th "agent" that supervises the fleet instead of
playing the game. It connects via a **dedicated MCP endpoint**,
`POST /mcp/overseer` (mounted in `proxy/mcp-factory.ts`, server built by
`createOverseerMcpServer()` in `proxy/overseer-mcp.ts`) — not the normal game
MCP session. Each turn, Gantry builds a fleet-state prompt
(`services/overseer-prompt.ts::buildSystemPrompt`/`buildUserPrompt`) and the
Overseer picks an action from the 5 lifecycle/order tools registered in
`overseer-mcp.ts` — `issue_order`, `trigger_routine`, `start_agent`,
`stop_agent`, `reassign_role` — then reports it via the `log_decision` tool.
`overseer-mcp.ts` actually registers 13 tools total: those 5 action tools,
`log_decision`, and 7 read-only fleet-state query tools (`get_fleet_status`,
`get_decision_history`, `get_agent_details`, `get_agent_comms`,
`get_forum_posts`, `query_catalog`, `query_known_resources`). `no_action` is
**not** a registered MCP tool — it's a valid `action_type` value documented in
the system prompt (`overseer-prompt.ts`) for when the Overseer logs a decision
with no actions taken; a separate legacy `OVERSEER_TOOLS` schema array in
`services/overseer-actions.ts` (Anthropic tool-call format, includes
`no_action`) exists but isn't wired into the MCP tool registration — don't
confuse it with the actual `overseer-mcp.ts` registry.
`start_agent`/`stop_agent` share a 5-minute per-agent lifecycle cooldown to
prevent flapping — this is the cooldown `startAgent()`/the health monitor check
against above. Every decision (reasoning + actions + results) is written to the
`overseer_decisions` table (`services/overseer-agent.ts`). Opt-in and
manual-start only; config lives under `overseer` in `gantry.json`. Status/
history: `GET /api/overseer/status`, `GET /api/overseer/decisions[?limit=]`,
`GET /api/overseer/decisions/:id`.

## Common debugging scenarios

**Agent shows offline but a process is clearly running (`ps aux` finds it):**
Almost always a post-restart in-memory/PID-file mismatch. Check whether
`$FLEET_DIR/data/pids/<name>.pid` exists and holds the right PID; if the PID
file is missing or stale, `hasSession()` reports offline regardless of the real
process. This self-heals once the agent's *next* natural start/stop cycle
re-registers it — or you can restart Gantry itself once the true process count
is confirmed via `ps aux | grep -E 'gantry|fleet-agents'`.

**Orphaned processes after a server restart:** there's no route for this —
call `scanOrphanedProcesses()` directly or do the manual equivalent: diff
`$FLEET_DIR/data/pids/*.pid` liveness against `ps aux | grep -E
'gantry|fleet-agents'`. It only reports, never kills.

**Stale PID file (process died via external `kill -9`, bypassing the exit
handler):** `isPidFileAlive()` self-cleans on the next liveness check — a
failed `process.kill(pid, 0)` deletes the PID file in its `catch` block. If a
dashboard keeps showing an agent as running after you know it's dead, force a
liveness check (any `hasSession`-touching route, e.g. `GET /:name`) rather than
assuming it needs a manual file delete.

**Logs not appearing:** `capturePane()` returns `''` if
`$FLEET_DIR/logs/<name>.log` doesn't exist yet — this is normal for an agent
that has never started. If the agent *has* started and logs are still empty,
check the spawn's `stdio` wiring in `newSession()` (it opens the log file with
`openSync(path, 'a')` before spawn) rather than assuming a parsing bug — the
log parser (`log-parser.ts`) only interprets an already-populated file, it
doesn't affect whether lines get written.

**Watchdog not restarting a crashed agent:** check, in order: is the fleet
disabled (`GET /fleet-state`)? Is the agent `enabled: false` in config? Is
there a `stopped_gracefully` or `shutdown` signal still set (an intentional
stop the monitor won't undo)? Is an overseer cooldown active
(`isRestartSuppressed`)? Only after ruling those out does `nextRestartAfterMs`
backoff apply — `GET /api/diagnostics/health-monitor` shows
`backoffRemainingSec` directly.
