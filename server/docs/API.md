# Gantry REST API

This document covers all REST endpoints exposed by the Gantry fleet-management server.

## Base URL

By default the server runs on `http://localhost:3100`. All paths below are relative to this base.

---

## Auth

Gantry uses role-based access control with pluggable adapters (see [CONFIG.md](./CONFIG.md)).

| Role | Access |
|------|--------|
| **admin** | All endpoints including writes and mutations |
| **viewer** | All `GET` endpoints |
| **none** | A handful of public endpoints (health, ping) |

**Rules enforced by middleware:**
- Public routes (`/api/ping`, `/health`, `/health/instability`) — no auth required.
- All `GET` routes — accessible to viewers and admins.
- All non-`GET` routes (POST, PUT, DELETE) — require **admin**.
- MCP endpoints (`/mcp`, `/sessions`) — require **admin** (or localhost bypass for agent connections).
- `/api/action-proxy/sessions/credentials` — **localhost only**.

---

## System / Misc

### `GET /api/ping`

**Auth:** none  
**Description:** Health check. Always returns `200`.  
**Response:**
```json
{ "ok": true, "timestamp": "2026-02-25T10:00:00.000Z" }
```

---

## Fleet Status

### `GET /api/status`

**Auth:** viewer  
**Description:** Full fleet status snapshot — all agents, proxies, turn interval.  
**Response:**
```json
{
  "agents": [
    {
      "name": "my-agent",
      "backend": "claude/claude-3-5-sonnet-20241022",
      "model": "claude-3-5-sonnet-20241022",
      "role": "miner",
      "llmRunning": true,
      "state": "running",
      "turnCount": 42,
      "lastTurnAge": "2m 5s",
      "lastTurnAgeSeconds": 125,
      "quotaHits": 0,
      "authHits": 0,
      "shutdownPending": false,
      "lastGameOutput": ["Mining copper..."],
      "healthScore": 95,
      "healthIssues": [],
      "proxy": "general",
      "sessionStartedAt": "2026-02-25T09:00:00Z",
      "lastToolCallAt": "2026-02-25T10:00:00Z",
      "latencyMetrics": { "agent": "my-agent", "p50Ms": 340, "p95Ms": 800, "p99Ms": 1200, "avgMs": 420 },
      "errorRate": { "agent": "my-agent", "totalCalls": 1000, "successRate": 98, "errorsByType": {} },
      "connectionStatus": "connected"
    }
  ],
  "proxies": [
    { "name": "general", "port": 1081, "host": "35.x.x.x", "status": "up", "agents": ["agent-alpha"] }
  ],
  "actionProxy": { ... },
  "turnInterval": 90,
  "timestamp": "2026-02-25T10:00:00.000Z",
  "fleetName": "Alpha Fleet"
}
```

### `GET /api/status/stream`

**Auth:** viewer  
**Description:** Server-Sent Events (SSE) stream. Pushes `status` events every 5 seconds with the same payload as `GET /api/status`.  
**Content-Type:** `text/event-stream`

---

## Agents

### `GET /api/agents/:name`

**Auth:** viewer  
**Description:** Detailed status for a single agent including recent process output and personality file.  
**Response:**
```json
{
  "name": "my-agent",
  "...": "all fields from /api/status agent entry",
  "logLines": "recent log lines (last 50 lines)",
  "personality": "personality/values file content or null"
}
```
**404** — agent not found.

### `GET /api/agents/:name/prompts`

**Auth:** viewer  
**Description:** Returns the agent's raw prompt files.  
**Response:**
```json
{
  "main": "...main prompt text or null",
  "personality": "...personality/values text or null",
  "commonRules": "...common-rules.txt content or null",
  "personalityRules": "...personality-rules.txt content or null"
}
```
**404** — agent not found.

### `POST /api/agents/start-all`

**Auth:** admin  
**Description:** Start all agents (creates background processes).  
**Response:** `{ "ok": true, "messages": ["my-agent started", ...] }`

### `POST /api/agents/stop-all`

**Auth:** admin  
**Query params:** `force=true` — force-kill instead of graceful shutdown  
**Description:** Soft-stop (default) or force-stop all agents.  
**Response:** `{ "ok": true, "messages": [...] }`

### `POST /api/agents/:name/start`

**Auth:** admin  
**Description:** Start a specific agent.  
**Response:** `{ "ok": true, "message": "my-agent started" }`  
**404** — agent not found.

### `POST /api/agents/:name/stop`

**Auth:** admin  
**Query params:** `force=true` — force-kill  
**Description:** Soft-stop (default) or force-stop a specific agent.  
**Response:** `{ "ok": true, "message": "..." }`  
**404** — agent not found.

### `POST /api/agents/:name/restart`

**Auth:** admin  
**Query params:** `force=true` — force-restart  
**Description:** Soft-restart (default) or force-restart a specific agent.  
**Response:** `{ "ok": true, "message": "..." }`  
**404** — agent not found.

---

## Agent Logs

### `GET /api/agents/:name/logs/stream`

**Auth:** viewer  
**Description:** SSE stream of the agent's log file. Sends an initial tail of 100 lines, then pushes new lines as they appear (200ms poll).  
**Events:** `log` (lines + offset), `status` (when file is empty/missing), `meta` (file size)

### `GET /api/agents/:name/logs/history`

**Auth:** viewer  
**Query params:** `offset` (byte offset, default 0), `limit` (lines, default 100)  
**Description:** Paginated log history by byte offset.  
**Response:** `{ "lines": [...], "offset": 4096 }`

### `GET /api/agents/:name/logs/search`

**Auth:** viewer  
**Query params:** `q` (required), `limit` (default 50)  
**Description:** Full-text search through an agent's log file.  
**Response:** `{ "results": [{ "line": "...", "lineNumber": 42 }], "count": 1 }`

### `GET /api/agents/:name/logfile`

**Auth:** viewer  
**Query params:** `lines` (default 200)  
**Description:** Raw log file tail (backward-compat endpoint).  
**Response:** `{ "lines": "...raw log content..." }`

---

## Agent Signals (Inject / Shutdown)

### `GET /api/agents/:name/inject`

**Auth:** viewer  
**Description:** Consume a pending inject instruction (one-shot read — clears the signal).  
**Response:** `{ "instruction": "Do this now" }` or `{ "instruction": null }`  
**404** — agent not found.

### `POST /api/agents/:name/inject`

**Auth:** admin  
**Body:** `{ "instruction": "string (max 10,240 chars)" }`  
**Description:** Set a one-shot instruction that the agent will consume on next turn.  
**Response:** `{ "ok": true }`  
**400** — missing/empty instruction or over length limit.  
**404** — agent not found.

### `GET /api/agents/:name/shutdown`

**Auth:** viewer  
**Description:** Check if a shutdown signal is pending for the agent.  
**Response:** `{ "pending": true }`

### `POST /api/agents/:name/shutdown`

**Auth:** admin  
**Body:** `{ "message": "optional reason" }`  
**Description:** Set a shutdown signal for the agent.  
**Response:** `{ "ok": true }`

### `DELETE /api/agents/:name/shutdown`

**Auth:** admin  
**Description:** Clear a pending shutdown signal.  
**Response:** `{ "ok": true }`

---

## Health

### `GET /api/health`

**Auth:** viewer  
**Description:** Computed health scores for all agents (from log analysis).  
**Response:**
```json
[{ "name": "my-agent", "backend": "claude/opus", "score": 95, "issues": [] }]
```

### `GET /api/health/sessions`

**Auth:** viewer  
**Description:** Session start time and last tool call timestamp for all agents.  
**Response:**
```json
[{ "agent": "my-agent", "sessionStartedAt": "2026-02-25T09:00:00Z", "lastToolCallAt": "2026-02-25T10:00:00Z" }]
```

### `GET /api/health/sessions/:agent`

**Auth:** viewer  
**Description:** Session info for a specific agent.  
**404** — agent not found.

### `GET /api/health/latency`

**Auth:** viewer  
**Description:** Tool-call latency percentiles (p50/p95/p99) for all agents.  
**Response:**
```json
[{ "agent": "my-agent", "p50Ms": 340, "p95Ms": 800, "p99Ms": 1200, "avgMs": 420 }]
```

### `GET /api/health/latency/:agent`

**Auth:** viewer  
**Description:** Latency metrics for a specific agent.  
**404** — agent not found.

### `GET /api/health/errors`

**Auth:** viewer  
**Description:** Error rate and breakdown by error type for all agents.  
**Response:**
```json
[{ "agent": "my-agent", "totalCalls": 1000, "successRate": 98, "errorsByType": { "timeout": 15 } }]
```

### `GET /api/health/errors/:agent`

**Auth:** viewer  
**Description:** Error breakdown for a specific agent.  
**404** — agent not found.

### `GET /api/health/detailed`

**Auth:** viewer  
**Description:** Comprehensive health details for all agents — combines latency, error rates, last successful command, and real-time connection status derived from the circuit breaker.  
**Response:**
```json
[{
  "agent": "my-agent",
  "latency": { ... },
  "errorRate": { ... },
  "lastSuccessfulCommand": "2026-02-25T10:00:00Z",
  "connectionStatus": "connected"
}]
```
`connectionStatus` values: `"connected"` (circuit closed), `"disconnected"` (circuit open or no session), `"reconnecting"` (circuit half-open).

### `GET /api/health/detailed/:agent`

**Auth:** viewer  
**Description:** Comprehensive health details for a specific agent.  
**404** — agent not found.

---

## Server Status

### `GET /api/server-status`

**Auth:** viewer  
**Description:** Game server health snapshot — circuit breaker state, game tick, version, instability metrics.  
**Response:**
```json
{
  "status": "up",
  "version": "v0.140.0",
  "tick": 12345,
  "circuit_breaker": { "state": "closed", "failures": 0, "totalTransitions": 2 },
  "notes": "All systems nominal",
  "check_interval_seconds": 10,
  "stale": false
}
```
`status` values: `"up"`, `"down"`, `"degraded"`.

### `GET /api/server-status/stream`

**Auth:** viewer  
**Description:** SSE stream pushing `server-status` events every 10 seconds.  
**Content-Type:** `text/event-stream`

---

## Game State

### `GET /api/game-state/all`

**Auth:** viewer  
**Description:** In-process status cache for all agents — normalized game state (credits, location, ship, cargo, skills).  
**Response:**
```json
{
  "my-agent": {
    "credits": 50000,
    "current_system": "Arkon Prime",
    "current_poi": "Station Beta",
    "docked_at_base": "Station Beta",
    "ship": {
      "name": "Dustrunner",
      "class": "freighter",
      "hull": 80, "max_hull": 100,
      "shield": 60, "max_shield": 80,
      "fuel": 50, "max_fuel": 100,
      "cargo_used": 20, "cargo_capacity": 100,
      "modules": [...],
      "cargo": [...]
    },
    "skills": { "mining": { "level": 5, "xp": 2400, "xp_to_next": 600 } }
  }
}
```

### `GET /api/game-state/:agent`

**Auth:** viewer  
**Description:** Normalized game state for one agent. Returns `null` (200) if the agent has no cached state yet.

---

## Analytics

### `GET /api/analytics`

**Auth:** viewer  
**Description:** High-level analytics summary for all agents (turn counts, quota hits, success rate).  
**Response:** `[{ "name": "my-agent", "backend": "claude/opus", "totalTurns": 100, "quotaHits": 2, "successRate": 98 }]`

### `GET /api/analytics/:name`

**Auth:** viewer  
**Description:** Analytics summary for one agent.  
**404** — agent not found.

---

## Analytics (Time-Series DB)

All endpoints accept optional query params:
- `hours` — filter to the last N hours
- `agent` — filter to a specific agent name

### `GET /api/analytics-db/cost`

**Auth:** viewer  
**Description:** API cost over time (per-turn cost in USD).  
**Response:** `[{ "timestamp": "...", "agent": "my-agent", "cost": 0.02 }]`

### `GET /api/analytics-db/tools`

**Auth:** viewer  
**Description:** Tool call frequency — how often each tool is called.  
**Response:** `[{ "tool_name": "mine", "count": 500, "agent": "my-agent" }]`

### `GET /api/analytics-db/credits`

**Auth:** viewer  
**Description:** Agent credits over time.  
**Response:** `[{ "timestamp": "...", "agent": "my-agent", "credits": 50000 }]`

### `GET /api/analytics-db/hull-shield`

**Auth:** viewer  
**Description:** Ship hull and shield readings over time.  
**Response:** `[{ "timestamp": "...", "agent": "my-agent", "hull": 80, "shield": 60 }]`

### `GET /api/analytics-db/comparison`

**Auth:** viewer  
**Description:** Cross-agent comparison metrics (credits earned, tool calls, error rates).

---

## Turns

### `GET /api/turns/:id`

**Auth:** viewer  
**Description:** Detailed record of a specific agent turn by its DB id.  
**404** — turn not found.  
**400** — invalid id.

### `GET /api/turns/agent/:name`

**Auth:** viewer  
**Query params:** `hours`, `limit` (default 20), `offset` (default 0)  
**Description:** Paginated turn history for an agent.  
**Response:** `{ "turns": [...], "total": 42 }`  
**404** — agent not found.

---

## Tool Calls

### `POST /api/tool-calls`

**Auth:** admin  
**Body:** Single record or array of records:
```json
{
  "agent": "my-agent",
  "tool_name": "mine",
  "args_summary": "{}",
  "result_summary": "{\"ore\": 5}",
  "success": true,
  "duration_ms": 150,
  "is_compound": false,
  "error_code": null
}
```
**Description:** Ingest tool call records (backward-compat HTTP path — direct DB writes preferred).  
**Response:** `{ "ok": true, "ids": [42] }`

### `GET /api/tool-calls`

**Auth:** viewer  
**Query params:** `agent`, `tool`, `since` (ISO timestamp), `limit` (max 500, default 50)  
**Description:** Query tool call history.  
**Response:** `{ "tool_calls": [...] }`

### `GET /api/tool-calls/stream`

**Auth:** viewer  
**Query params:** `agent` — filter by agent  
**Description:** SSE stream of live tool calls. Backfills last 50 from the in-memory ring buffer, then pushes new ones in real-time.  
**Events:** `tool_call` (array of records)

### `DELETE /api/tool-calls/prune`

**Auth:** admin  
**Query params:** `hours` (default 168 — 7 days)  
**Description:** Delete tool call records older than N hours.  
**Response:** `{ "ok": true, "deleted": 1234 }`

---

## Comms (Orders & Reports)

### `GET /api/comms`

**Auth:** viewer  
**Description:** Legacy compat — returns last 10 orders and last 20 timeline entries.  
**Response:** `{ "orders": [...], "timeline": [...] }`

### `GET /api/comms/orders`

**Auth:** viewer  
**Description:** List all orders with delivery status.  
**Response:** `{ "orders": [{ "id": 1, "message": "Mine iron", "target_agent": null, "priority": "normal", "created_at": "...", "deliveries": [] }] }`

### `POST /api/comms/orders`

**Auth:** admin  
**Body:**
```json
{
  "message": "Mine iron",
  "target_agent": "my-agent",
  "priority": "normal",
  "expires_at": "2026-02-26T00:00:00Z"
}
```
`target_agent` and `priority` and `expires_at` are optional.  
**Response:** `{ "ok": true, "id": 1 }`  
**400** — missing message.  
**404** — unknown `target_agent`.

### `GET /api/comms/orders/pending/:agent`

**Auth:** viewer  
**Description:** Undelivered orders for a specific agent.  
**Response:** `{ "orders": [...] }`  
**404** — agent not found.

### `POST /api/comms/orders/:id/delivered`

**Auth:** admin  
**Body:** `{ "agent": "my-agent" }`  
**Description:** Mark an order as delivered to an agent.  
**Response:** `{ "ok": true }`  
**400** — invalid id or missing agent.

### `GET /api/comms/log`

**Auth:** viewer  
**Description:** Full comms timeline (all orders and reports in chronological order).  
**Response:** `{ "entries": [...] }`

### `GET /api/comms/timeline`

**Auth:** viewer  
**Description:** Same as `/api/comms/log`.

### `POST /api/comms/report`

**Auth:** admin  
**Body:** `{ "agent": "my-agent", "message": "Mining complete" }`  
**Description:** Store an agent report. Also auto-generates fleet orders from the report content (via report-parser pipeline).  
**Response:** `{ "ok": true }`

### `POST /api/comms/handoff`

**Auth:** admin  
**Body:** `{ "agent": "my-agent", "location_system": "Station Alpha", "credits": 5000, ... }`  
**Description:** Store a session handoff record (agent state to transfer between runs).  
**Response:** `{ "ok": true, "id": 1 }`  
**400** — invalid agent.

### `GET /api/comms/handoff/:agent`

**Auth:** viewer  
**Description:** Get the unconsumed handoff for an agent.  
**Response:** `{ "handoff": { "id": 1, "agent": "...", "credits": 5000, ... } }` or `{ "handoff": null }`  
**404** — agent not found.

### `POST /api/comms/handoff/:id/consume`

**Auth:** admin  
**Description:** Mark a handoff as consumed.  
**Response:** `{ "ok": true }`  
**400** — invalid id.

---

## Notes & Memory

### `GET /api/notes/:name`

**Auth:** viewer  
**Description:** List all notes for an agent.  
**Headers:** `X-Diary-Entries: <count>` — number of diary entries.  
**Response:** `[{ "name": "strategy", "size": 1024, "updated_at": "2026-02-25" }]`  
**404** — agent not found.

### `GET /api/notes/:name/diary`

**Auth:** viewer  
**Query params:** `count` (default 10)  
**Description:** Most recent diary entries for an agent.  
**Response:** `{ "entries": [...] }`

### `POST /api/notes/:name/diary`

**Auth:** admin  
**Body:** `{ "entry": "Found rich deposits at Alpha-7" }`  
**Description:** Add a diary entry.  
**Response:** `{ "ok": true, "id": 42 }`  
**400** — missing entry.  
**404** — agent not found.

### `GET /api/notes/:name/:type`

**Auth:** viewer  
**Description:** Get a specific note by type (e.g. `strategy`, `discoveries`, `market-intel`, `report`).  
**Response:** `{ "content": "..." }`

### `PUT /api/notes/:name/:type`

**Auth:** admin  
**Body:** `{ "content": "...", "mode": "append" }` (`mode` defaults to overwrite)  
**Description:** Write or append a note. For `type=report`, also auto-generates fleet orders.  
**Response:** `{ "ok": true }`

### `GET /api/notes/:name/search`

**Auth:** viewer  
**Query params:** `q` (required), `limit` (default 20, max 100)  
**Description:** Full-text search through an agent's diary and notes.  
**Response:** `{ "results": [{ "source": "diary", "text": "...", "created_at": "...", "id": 42 }], "query": "crystal" }`  
**400** — missing `q`.  
**404** — agent not found.

### `GET /api/notes/fleet/search`

**Auth:** viewer  
**Query params:** `q` (required), `limit` (default 20, max 100), `agent` (optional filter)  
**Description:** Search across all agents' notes and diary.  
**Response:** `{ "results": [{ "agent": "agent-bravo", "source": "diary", "text": "...", "created_at": "..." }], "query": "crystal", "agent": "all" }`  
**400** — missing `q`.  
**404** — unknown `agent` filter.

---

## Usage

### `GET /api/usage`

**Auth:** viewer  
**Description:** LLM token usage summaries for all agents.  
**Response:**
```json
[{ "name": "my-agent", "backend": "claude", "model": "claude-3-5-sonnet-20241022", "turnCount": 100, "totalCost": 1.50 }]
```

### `GET /api/usage/:name`

**Auth:** viewer  
**Query params:** `detail=true` — include per-turn entries  
**Description:** Usage summary for a specific agent.  
**Response:**
```json
{
  "summary": { "turnCount": 100, "totalCost": 1.50 },
  "entries": [ ... ]   // only present with ?detail=true
}
```
**404** — agent not found.

---

## Map

### `GET /api/map`

**Auth:** viewer  
**Description:** Galaxy topology (system graph). Fetches from the game's public API and caches for 5 minutes.  
**Response:** Raw game API map payload (array of systems with connections).

---

## Market

### `POST /api/market/scan`

**Auth:** admin  
**Description:** Trigger a market scan across all game stations.  
**Response:** Market scan result object.  
**500** — if the scan fails.

---

## Server Logs

### `GET /api/server/logs/stream`

**Auth:** viewer  
**Description:** SSE stream of the Gantry server log file (`$FLEET_DIR/logs/server.log`). Tails the last 100 lines then streams new output.  
**Events:** `log` (lines + offset), `status` (if file empty/missing)

---

## Accounts (Account Pool)

These endpoints are only meaningful when `accountPool` is configured in `gantry.json`.

### `GET /api/accounts`

**Auth:** viewer  
**Description:** List all accounts with status, faction, assignment info. Passwords are never returned.  
**Response:**
```json
{
  "enabled": true,
  "poolFile": "/path/to/account-pool.json",
  "accounts": [{ "username": "my-character", "status": "active", "faction": "traders", "assignedTo": "my-agent" }],
  "config": { ... }
}
```

### `POST /api/accounts/:username/assign`

**Auth:** admin  
**Body:** `{ "agentName": "my-agent" }`  
**Description:** Explicitly assign an account to an agent.  
**Response:** `{ "ok": true, "username": "my-character", "agentName": "my-agent" }`  
**409** — account already assigned or not found.  
**503** — account pool not configured.

### `POST /api/accounts/:username/release`

**Auth:** admin  
**Description:** Release an account back to available status.  
**Response:** `{ "ok": true, "username": "my-character", "previousAgent": "my-agent" }`  
**404** — account not found.  
**503** — account pool not configured.

---

## Action Proxy

Internal endpoints used by the in-process MCP proxy and for proxy health monitoring.

### `GET /api/action-proxy`

**Auth:** viewer  
**Description:** Current action proxy status (active sessions, tool count, uptime).

### `POST /api/action-proxy/start`

**Auth:** admin  
**Description:** No-op. The proxy runs in-process; returns `{ "ok": true }`.

### `POST /api/action-proxy/stop`

**Auth:** admin  
**Description:** Returns 400 — to stop, stop the server process.

### `POST /api/action-proxy/restart`

**Auth:** admin  
**Description:** Returns 400 — to restart, restart the server process.

### `POST /api/action-proxy/kick/:agent`

**Auth:** admin  
**Description:** Immediately disconnect a specific agent's game client session (forces re-login on next turn).  
**Response:** `{ "ok": true, "status": "kicked", "agent": "my-agent" }`  
**404** — no active session.  
**503** — session manager not initialized.

### `GET /api/action-proxy/logs`

**Auth:** viewer  
**Description:** Capture recent output from the server log file.  
**Response:** `{ "lines": [...] }`

### `GET /api/action-proxy/sessions`

**Auth:** viewer  
**Description:** List persisted agent sessions (agent name + game username; no passwords).  
**Response:** `[{ "agentName": "my-agent", "credentials": { "username": "my-character" } }]`

### `GET /api/action-proxy/sessions/credentials`

**Auth:** localhost only  
**Description:** Full persisted sessions including encrypted passwords (used for agent restoration after restart).

### `POST /api/action-proxy/sessions`

**Auth:** admin  
**Body:** Array of `{ "agentName": "...", "credentials": { "username": "...", "password": "..." } }` (max 50 entries)  
**Description:** Persist sessions (passwords are encrypted at rest). Replaces all existing sessions atomically.  
**Response:** `{ "ok": true, "count": 3 }`

### `GET /api/action-proxy/game-state`

**Auth:** viewer  
**Description:** All persisted proxy game states (raw, from SQL — not normalized).

### `PUT /api/action-proxy/game-state/:agent`

**Auth:** admin  
**Body:** Raw game state object  
**Description:** Persist game state for an agent.  
**Response:** `{ "ok": true }`

### `GET /api/action-proxy/battle-state`

**Auth:** viewer  
**Description:** All persisted battle states.

### `PUT /api/action-proxy/battle-state/:agent`

**Auth:** admin  
**Body:** Battle state object or `null` to clear.  
**Response:** `{ "ok": true }`

### `GET /api/action-proxy/call-trackers`

**Auth:** viewer  
**Description:** All persisted call-limit tracker state.

### `PUT /api/action-proxy/call-trackers/:agent`

**Auth:** admin  
**Body:** `{ "counts": { "mine": 5 }, "lastCallSig": null, "calledTools": ["mine", "travel"] }`  
**Response:** `{ "ok": true }`

### `DELETE /api/action-proxy/caches/:agent`

**Auth:** admin  
**Description:** Delete all cached state (game-state, battle-state, call-trackers) for one agent.  
**Response:** `{ "ok": true }`

---

## MCP Endpoints (Agent Connection)

These are the MCP protocol endpoints used by Claude/Codex agents. Not for direct REST use.

### `POST /mcp`

**Auth:** admin (localhost bypass for agent connections)  
**Description:** MCP v1 endpoint. Agents connect here via `mcp.json`.

### `POST /mcp/v2`

**Auth:** admin  
**Query params:** `preset` — tool preset (`basic`, `standard`, `full`; default: first available)  
**Description:** MCP v2 endpoint with consolidated tools. Agents connect via `mcp-v2.json`.

### `DELETE /sessions/:agent`

**Auth:** admin  
**Description:** Kick an agent's MCP session (logout + remove session state).  
**Response:** `{ "status": "kicked", "agent": "my-agent" }`  
**404** — no active session.

### `GET /game-state/all`

**Auth:** admin  
**Description:** Raw (un-normalized) status cache for all agents directly from the MCP proxy.

### `GET /game-state/:agent`

**Auth:** admin  
**Description:** Raw status cache for one agent.  
**404** — agent not in cache.

---

## Internal Health (Proxy)

These routes are on the MCP router, not the web API router.

### `GET /health`

**Auth:** none  
**Description:** MCP proxy health — circuit breaker state, game server info, instability metrics, active sessions.

### `GET /health/instability`

**Auth:** none  
**Description:** Raw instability metrics from the proxy layer.

---

## Fleet Control

### `POST /api/agents/:name/order`

**Auth:** admin  
**Body:** Fleet order instruction  
```json
{
  "instruction": "Mine copper for 30 minutes"
}
```
**Description:** Send a one-shot order to a specific agent.  
**Response:** `{ "ok": true }`  
**404** — agent not found.

### `POST /api/agents/:name/routine`

**Auth:** admin  
**Body:** Routine configuration  
```json
{
  "routine": "mining_loop",
  "params": { "duration": 25, "target": "copper" }
}
```
**Description:** Start a routine on a specific agent.  
**Response:** `{ "ok": true }`  
**404** — agent not found.

### `GET /api/routines`

**Auth:** viewer  
**Description:** List available routine names.  
**Response:** `{ "routines": ["mining_loop", "sell_cycle"] }`

### `GET /api/routines/jobs`

**Auth:** viewer  
**Query:** `agent`, `status=running|completed|error`, `limit`  
**Description:** Recent routine job history, including async Codex routine jobs. The in-memory history is bounded to the latest 200 jobs and is reset when Gantry restarts.  
**Response:**
```json
{
  "jobs": [
    {
      "id": "rust-vane-1776547689153-ab12cd",
      "agent": "rust-vane",
      "routine": "mining_loop",
      "status": "running",
      "started_at": "2026-04-18T19:48:09.153Z",
      "duration_ms": 42000,
      "trace_id": "trace-123"
    }
  ]
}
```

### `GET /api/routines/jobs/:id`

**Auth:** viewer  
**Description:** One routine job by id.  
**404** — routine job not found.

---

## Combat

### `GET /api/combat/summary`

**Auth:** viewer  
**Description:** Overall combat statistics for the fleet.  
**Response:**
```json
{
  "totalEncounters": 42,
  "agentWins": 38,
  "agentLosses": 4,
  "successRate": 90.5
}
```

### `GET /api/combat/log`

**Auth:** viewer  
**Query params:** `agent`, `limit` (default 50)  
**Description:** Combat encounter history.  
**Response:** `{ "encounters": [...] }`

---

## Knowledge

### `GET /api/knowledge/faction-caps`

**Auth:** viewer  
**Description:** Faction reputation caps and current standings.  
**Response:**
```json
{
  "traders": { "cap": 100, "current": 45 },
  "miners": { "cap": 100, "current": 78 }
}
```

### `GET /api/knowledge/items`

**Auth:** viewer  
**Description:** Complete item catalog (names, types, properties).  
**Response:** `{ "items": [...] }`

### `GET /api/knowledge/recipes`

**Auth:** viewer  
**Description:** Crafting recipe list.  
**Response:** `{ "recipes": [...] }`

---

## Activity Feed

### `GET /api/activity/feed`

**Auth:** viewer  
**Query params:** `limit` (default 50), `agent` (optional filter)  
**Description:** Recent fleet activity (logins, sales, battles, etc.).  
**Response:** `{ "events": [...] }`

### `GET /api/activity/stream`

**Auth:** viewer  
**Query params:** `agent` (optional filter)  
**Description:** SSE stream of real-time activity events.  
**Content-Type:** `text/event-stream`

---

## Captain's Logs

### `GET /api/captains-logs/:agent`

**Auth:** viewer  
**Query params:** `limit` (default 20)  
**Description:** Agent's captain's log entries.  
**Response:** `{ "logs": [...] }`  
**404** — agent not found.

---

## Coordinator

### `GET /api/coordinator/status`

**Auth:** viewer  
**Description:** Current coordinator state — active quotas, agent assignments, distribution metrics.  
**Response:**
```json
{
  "enabled": true,
  "activeQuotas": 3,
  "distribution": { "miners": 2, "crafters": 1, "traders": 1, "flex": 1 },
  "agentStates": { "my-agent": "mining", "agent-bravo": "crafting" }
}
```

### `GET /api/coordinator/history`

**Auth:** viewer  
**Query params:** `hours` (default 24), `limit` (default 50)  
**Description:** Coordinator decision history.  
**Response:** `{ "decisions": [...] }`

---

## Survivability

### `GET /api/survivability/threat/:system`

**Auth:** viewer  
**Description:** Current threat level in a specific system.  
**Response:**
```json
{
  "system": "Arkon Prime",
  "threatLevel": "high",
  "pirates": [{ "id": "pirate-1", "weapon": "laser" }],
  "recommended_cloak": true
}
```
**404** — system not found.

### `GET /api/survivability/policy/:agent`

**Auth:** viewer  
**Description:** Survivability policy for a specific agent.  
**Response:**
```json
{
  "agent": "my-agent",
  "autoCloakEnabled": true,
  "thresholds": { "base": "medium", "role_override": "high" }
}
```
**404** — agent not found.

---

## Fleet Capacity

### `GET /api/fleet/capacity`

**Auth:** viewer  
**Description:** Fleet-wide cargo and resource capacity.  
**Response:**
```json
{
  "totalCargo": 500,
  "usedCargo": 350,
  "totalFuel": 1000,
  "usedFuel": 450,
  "agents": [
    { "name": "my-agent", "cargo": 100, "fuel": 200 }
  ]
}
```

---

## Diagnostics

### `GET /api/diagnostics/migrations`

**Auth:** viewer  
**Description:** Database migration status and applied migrations.  
**Response:**
```json
{
  "appliedMigrations": ["001_initial.sql"],
  "pendingMigrations": [],
  "status": "up-to-date"
}
```

---

## Auth Debug (Admin Only)

### `GET /api/auth/debug`

**Auth:** admin only  
**Description:** Auth adapter chain status and JWT validation details (for debugging authentication issues).  
**Response:**
```json
{
  "adapter": "layered",
  "strategies": ["local-network", "cloudflare-access"],
  "requestInfo": {
    "ip": "192.168.1.100",
    "hasToken": true,
    "cfJwtStatus": "valid"
  }
}
```

---

## Tool Calls (Sub-endpoints)

### `GET /api/tool-calls/missions?agent=:agent`

**Auth:** viewer  
**Description:** Mission-related tool calls for a specific agent.  
**Response:**
```json
{
  "tool_calls": [
    {
      "tool_name": "start_mission",
      "result_summary": "Mission accepted: Hunt pirates",
      "success": true
    }
  ]
}
```

### `GET /api/tool-calls/turn-costs`

**Auth:** viewer  
**Description:** Per-turn API costs (first tool call per turn only).  
**Response:**
```json
{
  "turn_costs": [
    { "agent": "my-agent", "turn": 42, "cost": 0.032 }
  ]
}
```

---

## Market (Sub-endpoints)

### `GET /api/market/arbitrage`

**Auth:** viewer  
**Description:** Arbitrage opportunities across stations.  
**Response:**
```json
{
  "opportunities": [
    {
      "item": "copper_ore",
      "buy_station": "Station Alpha",
      "sell_station": "Station Beta",
      "buy_price": 10,
      "sell_price": 15,
      "margin": 50
    }
  ]
}
```

### `GET /api/market/reservations`

**Auth:** viewer  
**Description:** Fleet-wide inventory reservations (cross-agent deconfliction).  
**Response:**
```json
{
  "reservations": [
    {
      "agent": "my-agent",
      "item": "copper_ore",
      "quantity": 50,
      "station": "Station Alpha",
      "expiration": "2026-02-26T00:00:00Z"
    }
  ]
}
```

### `DELETE /api/market/reservations/:agent`

**Auth:** admin  
**Description:** Clear all reservations for an agent (e.g., after logout).  
**Response:** `{ "ok": true, "cleared": 3 }`  
**404** — agent not found.
