# Overseer

The Overseer is an optional 6th agent — a fleet supervisor that monitors the other agents and issues corrective actions when needed. Unlike the fleet agents (which play the game), the Overseer watches the fleet and makes management decisions: restarting stalled agents, triggering routines, reassigning roles, or sending fleet orders.

---

## How it works

The Overseer is a Claude Code agent that connects to Gantry via a dedicated MCP endpoint (`/mcp/overseer`) instead of the game server. It has access to fleet management tools — not game tools.

Each Overseer turn:
1. Gantry builds a prompt containing current fleet state: agent status, location, credits, cargo, fuel, recent events, market opportunities, active orders, and previous Overseer decisions.
2. The Overseer analyzes the snapshot and decides what (if anything) to do.
3. Actions are executed by Gantry: orders sent, routines triggered, agents started/stopped.
4. The decision (reasoning + actions + results) is logged to the database.

The Overseer is opt-in and **manual-start only** — it does not run autonomously in the background.

---

## Configuration

Add an `overseer` entry to `gantry.json`:

```jsonc
{
  "overseer": {
    "enabled": true,
    "intervalMinutes": 5,
    "maxActionsPerTick": 3,
    "model": "claude-haiku-4-5"
  }
}
```

Add an agent entry named `"overseer"` to the `agents` array:

```jsonc
{
  "agents": [
    {
      "name": "overseer",
      "backend": "claude",
      "model": "claude-haiku-4-5",
      "mcpVersion": "v2"
    }
  ]
}
```

Configure Claude Code (or another MCP client) to connect to the Overseer endpoint:

```json
{
  "mcpServers": {
    "overseer": {
      "type": "http",
      "url": "http://localhost:3100/mcp/overseer"
    }
  }
}
```

Then run the Overseer agent as you would any other Claude Code agent, pointed at its system prompt.

### Config options

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `false` | Whether the Overseer is configured. Does not auto-start. |
| `intervalMinutes` | `5` | Expected time between Overseer turns. Used to calculate next-tick ETA in the dashboard. |
| `maxActionsPerTick` | `3` | Maximum number of actions the Overseer can take per turn. Injected into the system prompt. |
| `model` | *(agent config)* | Model override. Typically Haiku is sufficient — the Overseer's decisions are structured and don't need heavy reasoning. |

---

## Available actions

The Overseer has 6 tools:

| Action | What it does |
|--------|-------------|
| `issue_order` | Send a fleet order to a specific agent. Injected into the agent's next tool response. |
| `trigger_routine` | Start a named routine for an agent (e.g. `sell_cycle`, `full_trade_run`, `refuel_repair`). |
| `start_agent` | Start a stopped agent. Subject to a 5-minute lifecycle cooldown per agent. |
| `stop_agent` | Stop a running agent gracefully. Also subject to the cooldown. |
| `reassign_role` | Send an urgent fleet order telling an agent to shift its operating focus (miner, trader, explorer, combat). |
| `no_action` | Declare that no intervention is needed. Required when fleet is healthy — the Overseer must always return a decision. |

### Lifecycle cooldown

`start_agent` and `stop_agent` have a 5-minute cooldown per agent. Rapid lifecycle changes are blocked to prevent flapping.

---

## Decision logging

Every Overseer turn produces a decision record stored in the `overseer_decisions` table. Each record contains:

- `tick_number` — monotonically increasing counter
- `triggered_by` — what triggered this decision (usually `"manual"` or `"scheduled"`)
- `snapshot_json` — the fleet state at decision time
- `actions_json` — the actions the Overseer chose
- `results_json` — what happened when Gantry executed those actions
- `model` — the LLM model used
- `status` — `success` or `error`
- `created_at` — timestamp

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/overseer/status` | Current status: state, last/next tick, cost today, decisions today |
| `GET /api/overseer/decisions` | Recent decisions (default: last 20, max 100). `?limit=N` |
| `GET /api/overseer/decisions/:id` | Single decision by ID |

Example status response:

```json
{
  "state": "idle",
  "enabled": true,
  "tickNumber": 42,
  "lastTickAt": "2026-03-21T18:00:00.000Z",
  "nextTickAt": "2026-03-21T18:05:00.000Z",
  "costToday": 0.0023,
  "decisionsToday": 8,
  "model": "claude-haiku-4-5",
  "turnIntervalSeconds": 300
}
```

---

## Dashboard

The Overseer has a dedicated page at `/overseer` in the web dashboard showing:

- Current status (state, last tick, next tick ETA)
- Recent decisions with reasoning and action summaries
- Today's decision count and cost

---

## Operational notes

**When to use the Overseer:**
- Fleets of 4+ agents where manual supervision is impractical
- Long-running sessions where agents may stall or wander off-task
- Coordinated events (market crashes, fleet-wide refuel runs) that need a directing hand

**When not to use it:**
- Small fleets (1-3 agents) — the overhead isn't worth it
- Sessions where you're actively watching the dashboard

**Prompt guidelines:**
- The Overseer should bias heavily toward `no_action`. Unnecessary interventions cost tokens and can destabilize agents that are already working.
- Prefer `issue_order` and `trigger_routine` over lifecycle actions.
- `start_agent` / `stop_agent` should be rare — use them only when an agent is clearly stuck or has crashed.
