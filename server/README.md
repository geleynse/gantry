# Gantry Server

MCP proxy and live dashboard for Space Molt AI fleets. Handles guardrails, compound tools, multi-agent coordination, and real-time monitoring in a single Express server.

## What It Does

[Space Molt](https://spacemolt.com) is a text-based space MMO played entirely through MCP (Model Context Protocol) tools. Gantry sits between your AI agents and the game server, providing:

- **Compound tools** — `batch_mine`, `travel_to`, `jump_route`, `multi_sell`, `scan_and_attack`, and more. One tool call that handles a full multi-step sequence, tick waits, and error recovery.
- **Guardrails** — Rate limiting, per-tool call limits, decontamination (strips hallucination keywords from agent output), forbidden word enforcement, per-agent tool blocking.
- **Multi-agent coordination** — Fleet-wide sell deconfliction, fleet order injection into tool responses, agent signal routing.
- **Live dashboard** — React/Next.js web UI with agent status cards, real-time tool call streams (SSE), galaxy map, analytics charts, and agent notes.
- **Pluggable auth** — Local network bypass, Cloudflare Access JWT validation, or no auth for local-only use.
- **Session persistence** — SQLite-backed session manager, encrypted credential storage, per-agent event buffers.

## Quick Start

**Prerequisites:** [Bun](https://bun.sh) and a [Space Molt](https://spacemolt.com) account.

### 1. Install

```bash
git clone https://github.com/geleynse/gantry.git
cd gantry/server
bun install
```

### 2. Configure

Create a `gantry.json` file:

```json
{
  "mcpGameUrl": "https://game.spacemolt.com/mcp",
  "agents": [
    {
      "name": "my-agent",
      "model": "sonnet",
      "mcpVersion": "v2",
      "mcpPreset": "standard"
    }
  ],
  "auth": { "adapter": "loopback" }
}
```

### 3. Start the server

```bash
bun run build
bun run start
```

Open `http://localhost:3100` in your browser to see the dashboard.

### 4. Connect Claude Code

Configure Claude Code to use Gantry as its MCP server:

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

Then run an agent turn:

```bash
claude -p "You are my-agent. Login and take your turn." \
  --mcp-config gantry.json
```

## Architecture

```
Claude Code / Codex CLI
        │
        │  MCP (HTTP)
        ▼
Gantry Server :3100
  ├── /mcp, /mcp/v2     MCP proxy (compound tools, guardrails, injections)
  ├── /api/*            REST API (agent status, comms, analytics, notes)
  └── /                 Web dashboard (React + Next.js, SSE streams)
        │
        │  MCP (HTTP)
        ▼
game.spacemolt.com/mcp
```

All agent data is stored in SQLite (`fleet.db`). The server is a single Express process running on Bun, combining what was previously two separate services.

## Configuration

### Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | HTTP listen port | 3100 |
| `FLEET_DIR` | Fleet config directory | Auto-detect (see [docs/configuration.md](../docs/configuration.md)) |
| `GANTRY_SECRET` | AES-256 encryption key for credentials | Auto-generated |
| `LOG_LEVEL` | Logging verbosity (`debug`, `info`, `warn`, `error`) | `debug` |
| `NODE_ENV` | Runtime environment | (none) |
| `TRUST_PROXY` | Trust X-Forwarded-For headers | (none) |
| `GIT_COMMIT` | Override build commit hash | (none) |
| `MARKET_SCAN_INTERVAL_MS` | Market scan interval | 600000 |
| `MARKET_PRUNE_INTERVAL_MS` | Market data prune interval | 21600000 |
| `SCHEMA_TTL_MS` | MCP schema cache TTL | 86400000 |

### gantry.json Schema

See [docs/configuration.md](../docs/configuration.md) for the full schema.

## Building

```bash
# Build server only (esbuild)
bun run build:server

# Build client only (Next.js)
bun run build:client

# Build both
bun run build
```

## Testing

```bash
bun test                   # run all tests
bun test --coverage       # with coverage report
bun test file.test.ts     # run specific file
```

Test suite: ~4200 tests covering proxy modules, authentication, encryption, routines, and web routes.

## Key Modules

### Proxy (`src/proxy/`)

- **mcp-factory.ts** — Top-level MCP server orchestrator
- **gantry-v2.ts** — v2 action-dispatch protocol handler
- **server.ts** — v1 protocol handler (legacy, both use same shared handlers)
- **compound-tools-impl.ts** — Multi-step tool implementations
- **pipeline.ts** — Guardrails, injections, decontamination, combat auto-trigger
- **session-manager.ts** — Agent login/logout lifecycle
- **game-client.ts** — MCP client factory
- **schema.ts** — Tool schema caching and drift detection

### Web (`src/web/`)

- **routes/** — Express route handlers (status, agents, logs, comms, notes, etc.)
- **services/** — Business logic (database, notes, analytics, crypto)
- **auth/** — Pluggable authentication adapters (local-network, Cloudflare Access, token)
- **app.ts** — Express app factory

### Components (`src/app/`, `src/components/`)

- React 19 + Next.js 15 dashboard
- Static export to `dist/public/`
- Galaxy map, agent cards, tool call streams, analytics charts

## Security Notes

- Credentials are encrypted with AES-256-GCM before persisting to disk
- Bearer token auth uses constant-time comparison to prevent timing attacks
- MCP session tokens are stored in SQLite with TTL-based expiration
- Local network IP ranges are trusted by default (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
- Cloudflare Access JWT validation available for external deployments
- Tool calls are logged with full parameters (consider log retention policies)

## Deployment

### Development

```bash
bun run dev    # watches src/ and rebuilds on changes
```

### Production (Bun)

```bash
bun run build
bun run start
```

### Docker

Build and run with Docker Compose from the `gantry/` directory:

```bash
cd gantry

# Set up a data directory
mkdir -p _data
bun server/scripts/gantry-setup.ts _data

# Build image and start
docker compose up --build -d

# Check health
curl http://localhost:3100/health

# View logs
docker compose logs -f

# Stop
docker compose down
```

Override defaults with environment variables:

```bash
GANTRY_PORT=3101 FLEET_DIR=/path/to/fleet docker compose up -d
```

The image is a ~200MB standalone binary in `debian:bookworm-slim` with `tini` as init.

### Single-binary deployment

For self-hosters who want a single executable without a full Node/Bun toolchain:

```bash
# 1. Build the binary (requires bun + Next.js build)
bun run build:binary
# Output: dist/gantry  (Linux x86-64 standalone binary)

# 2. On the target server: run setup (creates data/, logs/, gantry.json)
bun gantry-setup.ts /opt/gantry

# 3. Edit the generated config
nano /opt/gantry/gantry.json

# 4. Start the server
FLEET_DIR=/opt/gantry GANTRY_SECRET="$(openssl rand -hex 32)" /opt/gantry/gantry
```

The binary is fully self-contained — static frontend assets are embedded at compile time. No separate `dist/public/` directory needed.

For production deployments, consider:
- Running behind a reverse proxy (nginx, Cloudflare)
- Using Cloudflare Access for authentication
- Setting `GANTRY_SECRET` to a strong, persistent value
- Configuring log rotation for tool call logs

## Troubleshooting

### Server won't start

- Check `LOG_LEVEL=debug` for detailed startup logs
- Verify `game.spacemolt.com/mcp` is reachable (test with `curl`)
- Ensure `FLEET_DIR` points to a valid directory with `gantry.json`

### Agent login fails

- Verify username/password in `fleet-credentials.json`
- Check game server status at `https://spacemolt.com`
- Look for "cooldown" errors (normal — agents should retry)

### Game connection issues

- Verify `mcpGameUrl` in `gantry.json` uses `https://` (not `wss://`)
- Test session creation: `curl https://game.spacemolt.com/api/v1/session`
- Check HTTP connectivity to `game.spacemolt.com` from your server
- Increase `LOG_LEVEL=debug` to see connection details

## Contributing

This is the public server distribution. Contributions are welcome!

- Report bugs and feature requests on GitHub
- Follow the existing code style (TypeScript, ESLint)
- Add tests for new features
- Update documentation

## License

MIT — see [LICENSE](LICENSE)
