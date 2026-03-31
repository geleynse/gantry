# Configuration Reference

Gantry's configuration has two layers:

1. **`gantry.json`** — agent definitions, game URL, auth, and fleet-wide settings. Loaded from `$FLEET_DIR/gantry.json` (or `fleet-config.json` for backward compatibility). Supports hot-reload: changes take effect within 5 seconds without a restart.
2. **Environment variables** — server port, paths, logging, and secrets.

---

## Config File Location

Gantry looks for the config file in this order:

1. `$FLEET_DIR/gantry.$GANTRY_ENV.json` (only if `GANTRY_ENV` is set)
2. `$FLEET_DIR/gantry.json`
3. `$FLEET_DIR/fleet-config.json` (backward compatibility)

If `FLEET_DIR` is not set, Gantry checks for `../fleet-agents` relative to the server directory (standard monorepo layout for local development).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLEET_DIR` | `../fleet-agents` (dev) | Path to the fleet directory containing `gantry.json` and agent files |
| `PORT` | `3100` | HTTP port |
| `GANTRY_PORT` | `3100` | Alias for `PORT` |
| `GANTRY_ENV` | — | Config profile selector (loads `gantry.$GANTRY_ENV.json`) |
| `GANTRY_URL` | `http://localhost:3100` | Self-referencing base URL (used internally by the map proxy) |
| `GANTRY_SECRET` | — | AES-256 key for encrypting stored credentials |
| `LOG_LEVEL` | `info` | Logging level: `debug`, `info`, `warn`, `error` |
| `TRUST_PROXY` | `0` | Set to `1` when behind a reverse proxy so IP-based auth reads `X-Forwarded-For` |
| `NODE_ENV` | — | Standard Node.js environment (`production`, `development`) |

### Config Profiles

`GANTRY_ENV` selects an alternate config file:

```bash
# Use staging config
GANTRY_ENV=staging bun run dev
# Loads: $FLEET_DIR/gantry.staging.json
```

---

## `gantry.json` — Full Schema

```jsonc
{
  "mcpGameUrl": "https://game.spacemolt.com/mcp",
  "agents": [...],
  "fleetName": "My Fleet",
  "turnInterval": 90,
  "staggerDelay": 20,
  "callLimits": { ... },
  "agentDeniedTools": { ... },
  "auth": { ... },
  "mockMode": false,
  "accountPool": null,
  "credentialsPath": "fleet-credentials.json",
  "maxIterationsPerSession": 100,
  "maxTurnDurationMs": 600000,
  "idleTimeoutMs": 300000,
  "coordinator": { ... },
  "overseer": { ... },
  "survivability": { ... },
  "mcpPresets": { ... }
}
```

---

## Top-Level Fields

### `mcpGameUrl` (required)

MCP endpoint URL for the Space Molt game server.

```json
"mcpGameUrl": "https://game.spacemolt.com/mcp"
```

### `agents` (required)

Array of agent definitions. At least one agent is required. See [Agent Config](#agent-config) below.

### `fleetName`

Display name for the fleet. Shown in the dashboard header.

### `turnInterval`

Seconds between agent turns. Default: `90`.

### `staggerDelay`

Seconds between starting each agent when the fleet starts. Prevents all agents from hitting the game server simultaneously. Default: `20`.

### `callLimits`

Per-turn call limits per tool. Agents that exceed the limit get an error response.

```json
"callLimits": {
  "scan": 5,
  "scan_and_attack": 8,
  "get_system": 8,
  "get_guide": 2
}
```

### `agentDeniedTools`

Block specific tools for specific agents (or all agents). Each entry maps a tool name to an error message returned when the agent tries to call it.

```json
"agentDeniedTools": {
  "*": {
    "mine": "Use batch_mine(count=20) instead.",
    "sell": "Use multi_sell(items=[...]) instead."
  },
  "my-scout": {
    "batch_mine": "You are a scout, not a miner."
  }
}
```

Use `"*"` to block a tool for all agents. Blocks are additive — an agent inherits `"*"` blocks plus its own.

### `mockMode`

Enable offline mode for testing without a game server.

```jsonc
// Boolean shorthand:
"mockMode": true

// Full config:
"mockMode": {
  "enabled": true,
  "responsesFile": "mock-responses.json",
  "tickIntervalMs": 500,
  "initialState": {
    "credits": 10000,
    "fuel": 80,
    "location": "Arkon Prime",
    "dockedAt": "Station Alpha",
    "cargo": [{ "item_id": "copper_ore", "quantity": 50 }]
  }
}
```

### `accountPool`

Path to an account pool JSON file (absolute or relative to `FLEET_DIR`). When set, Gantry auto-assigns accounts to agents instead of using per-agent credentials. See `examples/account-pool.json.example`.

### `credentialsPath`

Path to the credentials file. Default: `$FLEET_DIR/fleet-credentials.json`.

### `maxIterationsPerSession`

Maximum iterations per agent session. Limits runaway loops.

### `maxTurnDurationMs`

Maximum duration (ms) for a single agent turn. Default: `600000` (10 minutes).

### `idleTimeoutMs`

Timeout (ms) for idle game sessions.

### `mcpPresets`

Custom preset definitions mapping preset names to tool lists.

```json
"mcpPresets": {
  "standard": ["mine", "travel", "buy", "sell", "get_status"],
  "full": ["mine", "travel", "buy", "sell", "get_status", "battle", "scan"],
  "basic": ["get_status", "travel"]
}
```

---

## Agent Config

Each entry in the `agents` array:

```jsonc
{
  "name": "my-agent",
  "backend": "claude",
  "model": "sonnet",
  "faction": "solarian",
  "role": "Trader/Mining",
  "proxy": "micro",
  "mcpVersion": "v2",
  "mcpPreset": "full",
  "toolResultFormat": "yaml",
  "homeSystem": "sol_station",
  "roleType": "miner",
  "contextMode": "full",
  "systemPrompt": "You are a terse space trader.",
  "routineMode": false,
  "skillModules": ["mining", "navigation"],
  "factionNote": "Primary faction trader",
  "operatingZone": "Northern Sector",
  "extraTools": ""
}
```

### `name` (required)

Agent identifier. Must match the prompt filename in the fleet directory (without `.txt`) and the key in `fleet-credentials.json`.

### `backend`

LLM CLI to use. Options: `"claude"` (Claude Code), `"codex"` (OpenAI Codex), `"gemini"`. Default: `"claude"`.

### `model`

Model shortname passed to the backend CLI. For Claude: `"sonnet"`, `"haiku"`, `"opus"`. For Codex: the model ID (e.g., `"gpt-5.3-codex"`).

### `faction`

In-game faction. Used for dashboard display and account pool matching.

### `role`

Human-readable role description. Displayed on the dashboard agent card.

### `proxy`

SOCKS proxy name. Gantry looks for `$FLEET_DIR/proxy/proxy-{name}.conf` (proxychains4 format) and extracts the SOCKS5 port.

### `mcpVersion`

MCP endpoint version. Options: `"v1"` (legacy), `"v2"` (standard), `"overseer"`. Always use `"v2"` for new agents.

### `mcpPreset`

Tool set to expose. Options: `"basic"`, `"standard"` (default), `"full"`.

### `toolResultFormat`

Format for tool responses. Options: `"json"` (default), `"yaml"`. YAML reduces token usage. **Do not use `"yaml"` with Codex** — the `rmcp` library cannot parse YAML responses.

### `homeSystem`

Agent's home system ID. Injected into login response.

### `roleType`

Tactical role type. Options: `"trader"`, `"miner"`, `"explorer"`, `"combat"`, `"crafter"`, `"hauler"`, `"salvager"`, `"diplomat"`, `"prospector"`.

### `contextMode`

`"full"` (default) keeps the long-running session. `"compressed"` starts a fresh session per turn with a structured state summary, reducing token usage at the cost of conversational continuity.

### `systemPrompt`

Injected at the API system-prompt level. Higher priority than rules in the `.txt` prompt file. Use for tone/verbosity control.

### `routineMode`

Enable persistent multi-turn routine activities.

### `skillModules`

List of skill module names for the agent.

### `factionNote`, `operatingZone`

Display metadata for the dashboard.

### `extraTools`

Additional tool names to add beyond the preset. Comma-separated.

---

## Auth Configuration

Auth is configured via the `auth` key. For full details, see [auth.md](auth.md).

**Default behavior:** If `auth` is omitted, Gantry uses the `loopback` adapter — only requests from `127.0.0.1` or `::1` get admin. All other requests get viewer (read-only).

Quick reference:

```jsonc
// No auth (development only — all requests get admin)
"auth": { "adapter": "none" }

// Token auth
"auth": {
  "adapter": "token",
  "config": { "token": "your-secret-here" }
}

// Local network
"auth": {
  "adapter": "local-network",
  "config": { "allowedIpRanges": ["192.168.1.0/24"] }
}

// Cloudflare Access
"auth": {
  "adapter": "cloudflare-access",
  "config": {
    "teamDomain": "yourteam.cloudflareaccess.com",
    "audience": "your-aud-tag"
  }
}

// Layered (recommended for production)
"auth": {
  "adapter": "layered",
  "config": {
    "localNetworkRanges": ["192.168.0.0/16"],
    "cloudflareTeamDomain": "yourteam.cloudflareaccess.com",
    "cloudflareAudience": "your-aud-tag"
  }
}
```

---

## Coordinator

Multi-agent coordination settings.

```jsonc
"coordinator": {
  "enabled": true,
  "intervalMinutes": 10,
  "defaultDistribution": {
    "miners": 2,
    "crafters": 1,
    "traders": 1,
    "flex": 1
  },
  "quotaDefaults": {
    "batchSize": 50,
    "maxActiveQuotas": 10
  }
}
```

---

## Overseer

Fleet supervisor agent settings.

```jsonc
"overseer": {
  "enabled": false,
  "model": "haiku",
  "intervalMinutes": 10,
  "cooldownSeconds": 60,
  "maxActionsPerTick": 5,
  "eventTriggers": ["agent_stranded", "agent_died", "agent_stopped", "credits_critical", "combat_alert"],
  "creditThreshold": 1000,
  "historyWindow": 3
}
```

---

## Survivability

Auto-cloak and threat detection settings.

```jsonc
"survivability": {
  "autoCloakEnabled": true,
  "agentOverrides": {
    "combat-agent": true,
    "trader-agent": false
  },
  "thresholds": {
    "combat": "extreme",
    "explorer": "high",
    "hauler": "medium",
    "default": "medium"
  }
}
```

---

## Credential Storage

Agent game credentials are stored in `fleet-credentials.json` (gitignored). The proxy reads them at login time — agents never see credentials.

```json
{
  "my-agent": {
    "username": "my-agent",
    "password": "hunter2"
  }
}
```

---

## SOCKS Proxy

Place proxychains4 config files at `$FLEET_DIR/proxy/proxy-{name}.conf`:

```
strict_chain
quiet_mode
proxy_dns

[ProxyList]
socks5 127.0.0.1 1082
```

Reference the proxy in agent config: `"proxy": "micro"`.

---

## Multiple Fleets

Run multiple instances pointing at different fleet directories:

```bash
FLEET_DIR=/home/fleet-a PORT=3100 bun server/dist/index.js
FLEET_DIR=/home/fleet-b PORT=3200 bun server/dist/index.js
```

Each instance has its own SQLite database, agent configs, and dashboard.

---

## Fleet Directory Layout

```
$FLEET_DIR/
├── gantry.json              ← main config
├── gantry.staging.json      ← optional env-specific config
├── fleet-credentials.json   ← agent credentials (gitignored)
├── account-pool.json        ← optional account pool
├── common-rules.txt         ← shared rules for all agents
├── my-agent.txt             ← agent prompt
├── my-agent-values.txt      ← agent personality values
├── proxy/
│   ├── proxy-micro.conf     ← proxychains4 config
│   └── proxy-general.conf
├── data/
│   └── fleet.db             ← SQLite database (auto-created)
└── logs/
    └── server.log
```

---

## Config Validation

Gantry validates the config at startup and exits with an error if required fields are missing or values are invalid. Common errors:

```
FLEET_DIR="/path/to/fleet" does not exist
```
The path doesn't exist. Check that `FLEET_DIR` points to the correct directory.

```
Config parse error: Required field "agents" missing
```
The config file is missing the `agents` array.

```
Agent "my-pilot" has no credentials in fleet-credentials.json
```
Add an entry for the agent in `fleet-credentials.json`.

---

## Minimal Example

`gantry.json`:
```json
{
  "mcpGameUrl": "https://game.spacemolt.com/mcp",
  "agents": [
    { "name": "my-agent", "backend": "claude", "model": "sonnet", "mcpVersion": "v2", "mcpPreset": "full" }
  ]
}
```

`.env`:
```bash
FLEET_DIR=/home/user/my-fleet
PORT=3100
```
