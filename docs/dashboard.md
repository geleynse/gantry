# Dashboard

The Gantry web dashboard is a React 19 + Next.js 15 single-page application served by the Gantry server at `http://localhost:3100`. It provides real-time visibility into your fleet's activity without requiring SSH access to your servers.

## Accessing the Dashboard

By default the dashboard is open to all local connections. If you configured auth (see [Configuration](configuration.md)), the dashboard splits into:

- **Viewer mode** — Read-only: agent status, tool calls, logs, analytics
- **Admin mode** — Full control: start/stop/restart agents, inject instructions, modify fleet orders

## Main Dashboard

The main page shows all agents as cards. Each card displays:

- **Status badge** — `running`, `idle`, `stopped`, or `error`
- **Health score** — 0–100 derived from recent turn success rates
- **Ship silhouette** — Visual icon based on ship type
- **Credits** — Current credits from the last known game state
- **Faction badge** — Color-coded by in-game faction
- **Active tool** — What the agent is currently doing (if mid-turn)

### Live Connection Indicator

A dot in the top right of the page shows the SSE (Server-Sent Events) connection status:

- Green: Connected, receiving live updates
- Yellow: Reconnecting
- Red: Disconnected — check that the Gantry server is running

### Session Metrics

Below the agent cards, a metrics bar shows:
- Total turns completed today
- Estimated token cost (based on usage logs)
- Active sessions (game sessions currently open)
- Fleet uptime

## Agent Detail Pages

Click any agent card to open that agent's detail page. Tabs:

### Tool Calls

Live stream of tool calls for the current turn. Each entry shows:

- Tool name
- Parameters (collapsed by default, click to expand)
- Status: `pending`, `success`, or `error`
- Duration (ms) — updates when the call completes
- Timestamp

Pending tool calls show an elapsed timer. The stream updates in real time via SSE — no page refresh needed.

### Logs

Raw agent session logs, parsed and displayed with log level coloring. Filter by level using the buttons at the top:

- **All** — Show everything
- **Info** — Session milestones, turn start/end
- **Warn** — Cooldowns, guardrail blocks, fleet warnings
- **Error** — Failed turns, auth errors, game errors

Logs are stored in `$FLEET_DIR/logs/{agent}.log` and ingested by the server.

### Combat Logs

Combat-specific entries extracted from the agent's activity. Shows:
- Battle initiated / won / lost events
- Damage taken and dealt per round
- Loot collected

Useful for tuning combat agent behavior without digging through full logs.

### Market Data

Market intel collected by this agent — items they've seen for sale, stations with demand, price observations. Data comes from the agent's market-intel doc stored in SQLite.

### Analytics

Per-agent charts:

- **Turns per hour** — Activity rate over time
- **Credits over time** — Wealth accumulation curve
- **Tool usage breakdown** — Which tools the agent calls most
- **Cost** — Token cost per turn, cumulative cost

Charts have time range selectors: 1h, 6h, 24h, 7d.

### Notes

The agent's persistent documents:

- **Strategy doc** — Long-term goals and current focus. Full content displayed.
- **Discoveries** — Locations, faction intel, resource finds
- **Market intel** — Station demand data, price observations

Notes are read-only in viewer mode. In admin mode, you can edit them directly.

### Inject Instructions

(Admin only) Send a one-shot instruction that gets prepended to the agent's next turn prompt. Use this for manual overrides:

- "Travel to Nexus Core immediately and wait for orders"
- "Stop mining and report status"
- "Sell all copper ore before doing anything else"

Instructions are injected into the next turn via SQLite. They fire once and are cleared.

### Controls

(Admin only) Start, stop, restart the agent:

- **Start** — Launch the agent's background process.
- **Stop (soft)** — Inject a "save and quit" instruction, wait up to 3 minutes for a clean exit
- **Stop (force)** — Kill the background process immediately (may leave a game session open)
- **Restart** — Soft stop followed by start

## Galaxy Map

The galaxy map page shows an interactive force-graph visualization of the 505-system Space Molt galaxy. Features:

- **Faction colors** — Systems are colored by controlling faction
- **Agent positions** — Agents appear as labeled dots on their current system
- **System labels** — Hover a node to see the system name
- **Zoom/pan** — Scroll to zoom, drag to pan
- **Click to select** — Click a system to see connected systems and jump routes

Agent positions update when the agent's status cache refreshes (after each turn).

## Analytics

The fleet-wide analytics page shows aggregate data across all agents:

- **Total credits earned** — Across all agents, all time
- **Total cost** — Token cost breakdown by agent and model
- **Turns per agent** — Comparative activity chart
- **Tool usage heatmap** — Which tools are called most, across all agents

Time range selectors: 1h, 6h, 24h, 7d, all-time.

## Comms

The comms page shows fleet orders and inter-agent signals:

- **Fleet orders** — Current standing orders visible to all agents. Injected automatically into tool responses.
- **Comms timeline** — Reports filed by agents (`write_report` tool calls), in chronological order
- **Session handoffs** — Notes left by one agent session for the next

Fleet orders are managed through the admin panel (admin mode only).

## Screenshots

_(Screenshots will be added after UI polish is complete.)_

## Local vs. Remote Access

By default the dashboard serves on `localhost:3100`. To access it remotely:

1. **SSH tunnel**: `ssh -L 3100:localhost:3100 user@your-server`
2. **Reverse proxy**: Put Nginx or Caddy in front, optionally with Cloudflare Access for auth
3. **Direct exposure**: Set `PORT=3100` and open the firewall — use auth (see [Configuration](configuration.md))

For production deployments, Cloudflare Access with the `layered` auth adapter is recommended. It provides SSO with your Cloudflare team without managing API keys.
