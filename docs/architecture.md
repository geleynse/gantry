# Architecture

Gantry is a single Express process running on Bun. It combines an MCP proxy, a REST API, and a React/Next.js dashboard in one service on port 3100.

---

## Request flow

```
Claude Code / Codex CLI
        |
        |  MCP over HTTP (tools/call, tools/list)
        v
Gantry Server :3100
  |
  +-- /mcp/v2          MCP v2 proxy (action dispatch)
  +-- /mcp             MCP v1 proxy (legacy named tools)
  +-- /mcp/overseer    MCP endpoint for the Overseer agent
  +-- /api/*           REST API (status, comms, analytics, market, etc.)
  +-- /                Web dashboard (React + Next.js, static export)
        |
        |  MCP (HTTP)
        v
game.spacemolt.com/mcp  (or your game server)
```

Each agent gets its own MCP session with the game server. Gantry manages MCP sessions, handles session renewal, and serializes game interactions through its proxy pipeline.

---

## Proxy pipeline

Every MCP tool call from an agent passes through the proxy pipeline before reaching the game server. The pipeline runs in this order:

```
Agent tool call (JSON-RPC tools/call)
        |
        v
1. Session binding        -- map MCP session ID → agent name
        |
        v
2. Tool name sanitization -- strip XML artifact suffixes from AI-generated names
        |
        v
3. Guardrails             -- check call limits, denied tools, transit throttle
        |
        v
4. Pre-flight checks      -- combat auto-trigger, auto-flee, signal checks
        |
        v
5. Compound tool routing  -- intercept compound tools (batch_mine, travel_to, etc.)
   OR pass-through        -- forward to game server via MCP
        |
        v
6. Tick wait              -- wait for the game tick to resolve (state-changing tools only)
        |
        v
7. Response enrichment    -- inject fleet orders, battle status, directives, transit warnings
        |
        v
8. Decontamination        -- strip hallucination keywords from response text
        |
        v
9. Logging                -- write tool call record to SQLite, push to SSE stream
        |
        v
Agent receives result
```

### Compound tools

Compound tools are implemented entirely inside Gantry — they never make a single game API call. Instead, they orchestrate multiple game tool calls in sequence, handle tick waits between steps, and return a unified result.

The 8 compound tools (`batch_mine`, `travel_to`, `jump_route`, `multi_sell`, `scan_and_attack`, `loot_wrecks`, `battle_readiness`, `flee`) live in `src/proxy/compound-tools-impl.ts`.

### Injections

After each tool call, Gantry injects context into the response. The injection registry (`src/proxy/injection-registry.ts`) manages 7 built-in injections:

| Priority | Injection | What it adds |
|----------|-----------|-------------|
| 10 | Fleet orders | Pending orders for this agent |
| 20 | Battle status | Active combat state |
| 30 | Critical directives | Urgent rules (injected every call) |
| 40 | Regular directives | Standard rules (injected every 5 calls) |
| 50 | Transit warnings | Location-stuck detector warnings |
| 60 | Market reservations | Cross-agent sell deconfliction |
| 70 | System hints | Contextual error hints based on agent state |

### MCP versions

- **v2** (`/mcp/v2`): All tools are accessed through 6 consolidated `spacemolt(action="...")` dispatchers. Recommended for all new agents.
- **v1** (`/mcp`): Legacy named tools (`mine`, `travel`, `sell`, etc.). Still supported.

The v2→v1 mapping in `gantry-v2.ts` translates action names and remaps parameters before forwarding to the v1 handler.

---

## Event system

Game events arrive via MCP responses from the game server. Gantry maintains an `EventBuffer` per agent that stores recent events in memory. Agents poll events via the `get_notifications` slice of `get_status` — they never call a dedicated event endpoint.

Agent activity is also broadcast to the dashboard via SSE (Server-Sent Events) on `GET /api/tool-calls/stream`. The tool call logger maintains a ring buffer of recent calls and a subscriber list for push delivery.

SSE is used for:
- Live tool call stream (`/api/tool-calls/stream`)
- Activity feed (`/api/activity/stream`)
- Server logs (`/api/server/logs/stream`)

---

## Database

All persistent state lives in a single SQLite file at `$FLEET_DIR/data/fleet.db`.

Key tables:

| Table | Contents |
|-------|----------|
| `proxy_tool_calls` | Every tool call: agent, tool, params, result, duration, status |
| `agent_sessions` | MCP session lifecycle records |
| `overseer_decisions` | Overseer turn log |
| `comms` | Fleet orders and inter-agent messages |
| `captain_logs` | Agent diary / captain's log entries |
| `agent_notes` | Strategy docs, market intel, persistent notes |
| `market_cache` | Cached market data per system/station |
| `signals` | Cross-agent signals (shutdown, pause, etc.) |

Gantry uses direct SQLite access via `bun:sqlite` (Bun's native SQLite) — no ORM, no HTTP round-trips between proxy and database.

---

## Session management

MCP sessions are scoped per agent turn. When an agent starts a turn, it sends an MCP `initialize` request which creates a new session. The session is bound to the agent name via the `sessionAgentMap`.

Sessions expire after inactivity (60-second cleanup interval). When an agent stops, `expireAgentSessions(name)` immediately marks its sessions as expired.

The `SessionStore` (`src/proxy/session-store.ts`) tracks live sessions. The `SessionManager` (`src/proxy/session-manager.ts`) handles the MCP transport lifecycle.

---

## Shared state

The top-level `createMcpServer()` in `mcp-factory.ts` assembles `SharedState` — a single object threaded through all proxy modules via dependency injection:

```
SharedState
├── sessions
│   ├── active          Map<sessionId, McpSession>
│   ├── store           SessionStore
│   └── agentMap        Map<sessionId, agentName>
├── cache
│   ├── status          Map<agentName, { data, fetchedAt }>
│   ├── battle          Map<agentName, BattleState | null>
│   ├── market          AnalyzeMarketCache
│   └── events          Map<agentName, EventBuffer>
├── proxy
│   ├── gameTools       game tool registry
│   ├── serverDescriptions  tool descriptions from game schema
│   ├── gameHealthRef   current game server health
│   ├── callTrackers    Map<agentName, AgentCallTracker>
│   ├── breakerRegistry circuit breakers per tool
│   └── serverMetrics   instability metrics window
└── fleet
    ├── galaxyGraph     system graph for route planning
    ├── sellLog         recent sell history (deconfliction)
    ├── arbitrageAnalyzer
    ├── coordinator     multi-agent coordinator
    ├── marketReservations  advisory cross-agent inventory
    └── overseerEventLog
```

Each module (`passthrough-handler`, `pipeline`, `compound-tools-impl`, etc.) declares a `*Deps` interface and receives only the fields it needs. No global singletons in the proxy layer.

---

## Dashboard

The web dashboard is a Next.js 15 app with React 19, compiled to a static export at build time (`dist/public/`). It's served by the same Express server.

Pages:

| Route | What it shows |
|-------|---------------|
| `/` | Fleet overview — agent cards, status summary |
| `/agent/[name]` | Per-agent detail: tool calls, notes, controls |
| `/analytics` | Credits, costs, iterations over time |
| `/combat` | Combat log, encounter cards |
| `/map` | Galaxy map (505 systems, agent positions) |
| `/activity` | Live activity feed (SSE) |
| `/comms` | Fleet orders and inter-agent messages |
| `/logs` | Server log tail |
| `/leaderboard` | Fleet performance ranking |
| `/overseer` | Overseer status and decision history |
| `/prompts` | Prompt viewer/editor |
| `/rate-limits` | Tool call rate limit status |

The dashboard fetches data from the REST API (`/api/*`) and uses SSE for live updates. Admin actions (start/stop agent, send orders) require admin role.

---

## Key source files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — config, database init, Express app, timers, graceful shutdown |
| `src/app.ts` | Express app factory — mounts proxy + web routes + static files |
| `src/config.ts` | Config loader — parses `gantry.json`, hot-reload, agent helpers |
| `src/proxy/mcp-factory.ts` | Top-level MCP server factory — wires schema, health, session management |
| `src/proxy/server.ts` | v1 `createGantryServer` factory — SharedState types, v1 endpoint |
| `src/proxy/gantry-v2.ts` | v2 `createGantryServerV2` factory — action dispatch, v2→v1 mapping |
| `src/proxy/pipeline.ts` | Shared pipeline functions — guardrails, injections, decontamination |
| `src/proxy/passthrough-handler.ts` | Single-tool pass-through — nav, auto-undock, tick wait, enrichment |
| `src/proxy/compound-tools-impl.ts` | Compound tool implementations |
| `src/proxy/tool-call-logger.ts` | Two-phase logging, ring buffer, SSE push |
| `src/proxy/injection-registry.ts` | Fleet order/directive injection registry |
| `src/services/database.ts` | SQLite access — `queryAll`, `queryOne`, `queryInsert` |
| `src/web/auth/` | Pluggable auth adapters |
| `src/web/routes/` | Express route modules (one file per API area) |
| `src/app/` | React/Next.js dashboard pages |
