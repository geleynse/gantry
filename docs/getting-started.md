# Getting Started

This guide walks through installing Gantry, configuring your fleet, and running your first agent turn.

**Prerequisites:**
- [Bun](https://bun.sh) v1.0+ (or Docker if you prefer containerized install)
- A [Space Molt](https://spacemolt.com) account with at least one character
- Claude Code or Codex CLI (to run agents)

---

## 1. Install

### From source (Bun)

```bash
git clone https://github.com/geleynse/gantry.git
cd gantry
bun install
cd server && bun install
```

Build the server and dashboard:

```bash
bun run build
```

### Docker

```bash
git clone https://github.com/geleynse/gantry.git
cd gantry
mkdir -p _data
```

No build needed — `docker compose up --build` handles it.

---

## 2. Set up your fleet directory

Run the setup script to scaffold a fleet directory with the right structure:

```bash
bun server/scripts/gantry-setup.ts ./my-fleet
```

This creates:

```
my-fleet/
├── gantry.json            ← main config (edit this)
├── common-rules.txt       ← shared rules for all agents
└── data/                  ← SQLite database (auto-created on first run)
```

---

## 3. Configure `gantry.json`

Edit `my-fleet/gantry.json`. Start with the minimal config:

```jsonc
{
  "mcpGameUrl": "https://game.spacemolt.com/mcp",
  "fleetName": "My Fleet",

  "agents": [
    {
      "name": "my-agent",
      "backend": "claude",
      "model": "sonnet",
      "faction": "solarian",
      "role": "Trader/Mining",
      "mcpVersion": "v2",
      "mcpPreset": "full",
      "homeSystem": "nexus_core"
    }
  ]
}
```

Key fields:

| Field | Description |
|-------|-------------|
| `mcpGameUrl` | Game server MCP endpoint. Use the default unless running a custom server. |
| `agents[].name` | Must match the agent's in-game username. |
| `agents[].backend` | `claude` (Anthropic) or `codex` (OpenAI). |
| `agents[].model` | `sonnet`, `opus`, or a full model ID. |
| `agents[].faction` | In-game faction: `solarian`, `crimson`, `nebula`, `outerrim`. |
| `agents[].homeSystem` | System ID where this agent is based. |
| `agents[].mcpVersion` | Always use `v2` for new agents. |

See [`docs/configuration.md`](configuration.md) for the full config reference.

---

## 4. Add agent credentials

Agent credentials are stored separately from the config. Add them via the dashboard (after starting Gantry) or by creating `my-fleet/fleet-credentials.json`:

```json
{
  "my-agent": {
    "username": "my-agent",
    "password": "your-game-password"
  }
}
```

Credentials are encrypted at rest on first startup — the plaintext file is migrated to `fleet-credentials.enc.json` with a `.bak` backup. Keep this file gitignored.

---

## 5. Write an agent prompt

Copy the template and fill in the placeholders:

```bash
cp gantry/examples/agent-template/system-prompt.md my-fleet/my-agent.txt
```

Required substitutions in the template:
- `CHARACTER_NAME` — in-game username
- `EMPIRE` — faction name
- `ROLE` — one-line role description
- `MISSION_DESCRIPTION` — 2-3 sentences describing the agent's goal
- `HOME_SYSTEM` — home system ID

The template includes session structure, fleet coordination rules, and role-specific guidance. Remove the HTML comment blocks before deploying.

---

## 6. Start Gantry

### From source

```bash
FLEET_DIR=./my-fleet bun run server/dist/index.js
```

Or in development mode (hot reload):

```bash
FLEET_DIR=./my-fleet bun run dev
```

### Docker

```bash
FLEET_DIR=./my-fleet docker compose up -d
```

Open `http://localhost:3100` in your browser. You should see the dashboard with your agent listed.

---

## 7. Configure your MCP client

For Claude Code, create or update your MCP config:

```json
{
  "mcpServers": {
    "spacemolt": {
      "type": "http",
      "url": "http://localhost:3100/mcp/v2"
    }
  }
}
```

Save this as `my-fleet/mcp.json` (or wherever your agent template points to).

---

## 8. Run your first agent turn

```bash
claude -p "$(cat my-fleet/my-agent.txt)" \
  --mcp-config my-fleet/mcp.json \
  --model claude-sonnet-4-6
```

The agent will:
1. Call `login()` immediately (as instructed by the prompt)
2. Check its status, cargo, and notes
3. Take actions (mine, travel, trade) based on its mission
4. Call `logout()` at the end of the session

Watch the live tool call stream in the dashboard while it runs.

---

## Next steps

- **Multiple agents**: Add more entries to the `agents` array in `gantry.json`. Each needs its own prompt file and credentials.
- **Tool restrictions**: Use `agentDeniedTools` in `gantry.json` to block tools per agent. See [`docs/configuration.md`](configuration.md).
- **Auth**: Add auth if you're exposing the dashboard beyond localhost. See [`docs/auth.md`](auth.md).
- **Remote access**: See [`docs/deployment.md`](deployment.md) for Cloudflare Tunnel, nginx, and systemd setup.
- **Compound tools**: Learn what `batch_mine`, `travel_to`, `multi_sell`, and others do. See [`docs/compound-tools.md`](compound-tools.md).
- **Overseer**: Add a fleet supervisor agent. See [`docs/overseer.md`](overseer.md).

---

## Troubleshooting

**Agent isn't showing in the dashboard**
- Check that `FLEET_DIR` points to the directory containing `gantry.json`.
- The agent name in config must match the in-game username exactly (case-sensitive).

**`login()` fails with authentication error**
- Verify credentials in `fleet-credentials.json` match the in-game username and password.
- Check the Gantry logs (`http://localhost:3100/logs`) for the error detail.

**Tool calls hang**
- The game server may be down or unreachable. Check `/health` for game server status.
- Check `mcpGameUrl` in `gantry.json` points to the correct endpoint.

**"Tool not found" errors from agent**
- Make sure `mcpVersion: "v2"` is set in the agent config — v2 uses action dispatch, not named tools.
- The agent prompt must use `spacemolt(action="...")` syntax, not `mine()` or `travel()`.

**Database locked**
- Another Gantry instance may be running against the same `FLEET_DIR`. Only one instance per fleet directory is supported.
