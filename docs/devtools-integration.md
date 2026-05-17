# claude-devtools Integration

Gantry's **Sessions** tab (visible on `/agent/<name>` for admin users) shows the
per-turn Claude Code transcripts for each fleet agent, sourced from a local
[claude-devtools](https://github.com/matt1398/claude-devtools) standalone
server. This page explains how to install and wire it up.

If devtools isn't installed, the Sessions tab renders a friendly setup card
pointing at this document — the rest of Gantry works fine without it.

## What you get

- Per-agent session list with the model's first reply as the preview
- Inline transcript viewer (user/assistant rows, tool calls, tool results, usage metrics)
- $ cost per session (from a model-pricing table) and a running total
- Deep-linkable URLs (`#sessions/<uuid>`, `#sessions/<uuid>/msg/<uuid>`)
- Cross-links to the Logs tab filtered to the session's time window
- Anomaly badges for long sessions, high context usage, slow turns

## Requirements

- Node.js 18+ (devtools is a Vite+Fastify build; runs under Bun too)
- `pnpm` for the build (one-time)
- A Claude Code project directory containing JSONL session files —
  typically `~/.claude/projects/<project-id>/` on the fleet host
- ~50 MB disk for the build output

## Install on the fleet host

```bash
# As the user that owns ~/.claude/projects (e.g. spacemolt on LXC 200)
cd ~
git clone https://github.com/matt1398/claude-devtools.git
cd claude-devtools
pnpm install --frozen-lockfile
pnpm standalone:build
```

The build writes a self-contained server bundle to `dist-standalone/index.cjs`.

## Run as a systemd --user unit

This is the recommended way: process auto-restarts, no root needed, the
service is bound to the user that owns the session files.

Enable user lingering so the unit starts at boot (run as root, once):

```bash
loginctl enable-linger <fleet-user>
```

Drop a unit file at `~/.config/systemd/user/claude-devtools.service`:

```ini
[Unit]
Description=claude-devtools standalone server (read-only viewer for ~/.claude)
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/claude-devtools
ExecStart=/usr/bin/node dist-standalone/index.cjs
Environment=CLAUDE_ROOT=%h/.claude
Environment=HOST=127.0.0.1
Environment=PORT=3456
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5
ReadOnlyPaths=%h/.claude

[Install]
WantedBy=default.target
```

Activate:

```bash
systemctl --user daemon-reload
systemctl --user enable --now claude-devtools
systemctl --user status claude-devtools
```

Verify it answers:

```bash
curl -sf http://127.0.0.1:3456/api/projects | head -c 200
```

You should see a JSON array of project objects.

## Tell Gantry about it

Two environment variables on the Gantry server process:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DEVTOOLS_URL` | `http://127.0.0.1:3456` | Base URL of the claude-devtools server |
| `DEVTOOLS_FLEET_PROJECT_ID` | `-home-spacemolt-fleet-agents` | The project ID under `~/.claude/projects/` where fleet agent sessions live. Find yours by listing that directory; the ID is a dash-prefixed slug of the cwd. |

For the SpaceMolt default deployment (devtools on loopback, fleet agents run
from `/home/spacemolt/fleet-agents`), no env vars are required.

For other deployments, add to your service definition (e.g. the `run.sh` or
systemd unit that launches Gantry):

```bash
export DEVTOOLS_URL=http://127.0.0.1:3456
export DEVTOOLS_FLEET_PROJECT_ID=-home-myuser-my-fleet-cwd
```

Then restart Gantry.

## How agent-to-session matching works

All fleet agents share one Claude Code project (the cwd that the agent loop
launches `claude -p` from). Gantry filters sessions to a specific agent by
scanning each session's first user message for the LOGIN marker:

```
LOGIN: username="<Display Name>"
```

The display name is derived from the agent slug by title-casing
(`drifter-gale` → `"Drifter Gale"`). If your agent prompt doesn't include
this exact format, the filter won't match and the tab will show "no sessions
found for this agent." The marker format is in
[`agent-sessions.ts`](../server/src/web/routes/agent-sessions.ts#L29) —
adjust if your prompt convention differs.

## How the Sessions tab is gated

- Visible only to users with `role: admin` (see the auth adapter docs)
- The route also rejects non-admin requests at the server (`requireAdmin`)
- Session detail responses are filtered so an admin can't enumerate sessions
  that belong to a different agent by guessing the UUID

## Optional: iframe proxy at `/devtools/`

Gantry also reverse-proxies the full claude-devtools UI at
`https://<gantry-host>/devtools/`. Same admin gate. Use this when you want
the upstream UI's project picker, search, or settings; use the per-agent
Sessions tab for the integrated, fleet-aware view.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Sessions tab shows the setup card | `systemctl --user status claude-devtools`, `curl http://127.0.0.1:3456/api/projects` |
| Tab loads but shows "No sessions found for this agent" | Confirm the LOGIN marker format in your agent prompt matches `username="<Title Case>"` |
| Tab shows sessions but missing `firstAssistantText` previews | The detail fetch timed out (3 s cap). devtools may be slow under load; previews are best-effort and degrade to the user prompt. |
| 403 on `/api/agents/<name>/sessions` from a browser | Your auth adapter isn't returning `role: admin` for your identity. Check `/api/auth/me` and the adapter docs. |
| Iframe at `/devtools/` 404s | Check that the proxy mount in `server/src/app.ts` is still live and that devtools is bound on the loopback Gantry expects. |

## Operational notes

- The Sessions list endpoint walks devtools' paginated sessions API up to 500
  rows to find matches for a sparse agent. If your fleet has many agents
  sharing a single project, this becomes the bottleneck for first-page latency.
- The `firstAssistantText` cache is in-memory (max 500 entries, 10 min TTL).
  Restarting Gantry clears it; the cache rebuilds on the next page load.
- claude-devtools watches the JSONL files on disk — new sessions appear in
  Gantry within a refresh of the panel.
