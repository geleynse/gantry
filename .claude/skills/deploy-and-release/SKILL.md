---
name: deploy-and-release
description: Use when deploying Gantry (Docker, systemd, or single binary), cutting a release/tag, checking what CI actually gates, or setting production auth/env recommendations — not for local dev loop mechanics (see build-and-dev skill for that).
---

# Deploy and Release — Gantry

Full walkthroughs (Cloudflare Tunnel, nginx/Caddy configs, systemd unit): `docs/deployment.md`. This skill covers what's actually wired in CI/CD, the exact scaffolding behavior, and gaps between docs and code. For build mechanics (esbuild config, `bun run dev`'s "stale client bundle" trap, binary packaging internals) see the `build-and-dev` skill — not duplicated here.

## Three deployment shapes

| Shape | Needs on target host | Build step |
|---|---|---|
| Docker (`docker-compose.yml`) | Docker + Compose only | `docker compose up --build` (multi-stage `Dockerfile` builds inside the container) |
| systemd + Bun | Bun runtime | `bun install && bun run build` (or `build:binary`) on the host or a build machine |
| Single binary | Nothing — no Bun, no Node, no npm | `bun run build:binary` on a build machine, then `scp` the binary |

All three serve one Express process on port 3100 (`PORT`/`GANTRY_PORT`), one `FLEET_DIR` per process, one SQLite file (`$FLEET_DIR/data/fleet.db`). Only one Gantry instance may run against a given `FLEET_DIR` — SQLite lock contention otherwise (see `docs/getting-started.md` "Database locked" troubleshooting entry).

## `docker-compose.yml` (verified against the actual file)

```yaml
services:
  gantry:
    build: { context: ., dockerfile: Dockerfile }
    image: gantry:local
    ports: ["${GANTRY_PORT:-3100}:3100"]
    volumes: ["${FLEET_DIR:-./_data}:/data"]
    environment:
      - FLEET_DIR=/data
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - TRUST_PROXY=${TRUST_PROXY:-0}
      - GANTRY_SECRET=${GANTRY_SECRET:-}
    restart: unless-stopped
    healthcheck: { test: ["CMD", "curl", "-sf", "http://localhost:3100/health"], interval: 30s, timeout: 5s, retries: 3, start_period: 10s }
```

Single named volume mount at `/data` — that's the entire persistence surface: `gantry.json`, `fleet-credentials.enc.json`, `data/fleet.db`, `logs/`, agent prompt `.txt` files. Host-side path comes from `$FLEET_DIR` env var (defaults to `./_data` next to the compose file) — this is a *host* path substituted into the bind mount, separate from the *container's* `FLEET_DIR=/data` env var baked into the `environment:` block. Don't confuse the two when debugging "my config isn't picked up" — the container always reads `/data` regardless of what the host-side `$FLEET_DIR` was set to.

## `Dockerfile` stages (verified)

1. **Builder** (`oven/bun:1-debian`): `bun install` (server deps only, cached layer), `bun run build:server` (esbuild), `bunx --bun next build` (client static export), `bun run build.ts --binary` (standalone binary compile).
2. **Runtime** (`debian:bookworm-slim`, not the Bun image): installs only `ca-certificates`, `curl`, `tini`. Copies `dist/gantry` (the compiled binary) and `dist/public/` (static assets, copied redundantly — the binary already embeds them, this copy is defensive/for-debugging) and `scripts/gantry-setup.ts`. Sets `ENV FLEET_DIR=/data`, `PORT=3100`, `GANTRY_PUBLIC_DIR=/app/dist/public` (this last one isn't documented in `docs/configuration.md` — see the `configuration` skill). `ENTRYPOINT ["tini", "--"]`, `CMD ["./gantry"]` — runs the compiled binary directly, no Bun runtime in the final image.
3. `HEALTHCHECK` hits `/health` every 30s (matches the compose file's separate healthcheck — both exist, compose's takes precedence when running via Compose).

## Single-binary path (`bun run build:binary`)

Output: `dist/gantry`, standalone Linux x86-64 executable, ~200MB, static frontend assets embedded via `Bun.embeddedFiles` at compile time — `dist/public/` does not need to travel with it. Requires `bun run build:client` to have run first (client build must exist before the binary packaging step globs `dist/public/**/*`); `build:binary` runs `build:client` for you.

```bash
cd gantry/server
bun install && bun run build:binary
bun scripts/gantry-setup.ts ./my-fleet     # scaffold locally (idempotent)
scp dist/gantry user@server:/opt/gantry/
scp -r my-fleet user@server:/opt/gantry/fleet
ssh user@server
FLEET_DIR=/opt/gantry/fleet GANTRY_SECRET="$(openssl rand -hex 32)" /opt/gantry/gantry
```

### What `gantry-setup.ts` actually scaffolds (verified against source — narrower than the docs)

`server/scripts/gantry-setup.ts <install-dir>` creates, idempotently:

- `<install-dir>/data/pids/` (`mkdirSync(..., { recursive: true })`)
- `<install-dir>/logs/`
- `<install-dir>/gantry.json` — **only if it doesn't already exist** — a minimal default:
  ```json
  { "mcpGameUrl": "wss://game.spacemolt.com/mcp", "agents": [{ "name": "my-agent", "model": "claude-haiku-4-5", "mcpVersion": "v2", "mcpPreset": "standard" }] }
  ```

**Doc mismatch**: `docs/getting-started.md` and `docs/deployment.md` both claim this script also creates a `common-rules.txt`. It does not — the script has no code path that writes that file. If you're following either doc and `common-rules.txt` doesn't appear after running the setup script, that's expected; create it by hand or copy `examples/common-rules.txt.example`. Also note the scaffolded `mcpGameUrl` uses a `wss://` scheme while every other example/doc in the repo (`examples/gantry.json.example`, `docs/getting-started.md`, `docs/configuration.md`) uses `https://` — inconsistent, but not something this skill can resolve; if the game endpoint doesn't accept one scheme, fix it in your own `gantry.json` rather than assuming the scaffolded default is correct.

## systemd (Bun, non-Docker)

Standard unit: `WorkingDirectory=/opt/gantry/server`, `ExecStart=/opt/gantry/server/dist/gantry` (the compiled binary — no Bun dependency at runtime) or `ExecStart=/home/user/.bun/bin/bun run /opt/gantry/server/dist/index.js` if you'd rather run un-compiled. Set `FLEET_DIR`, `PORT`, `LOG_LEVEL`, and **`GANTRY_SECRET` explicitly** — the auto-generated secret is written to `$FLEET_DIR/data/.gantry-secret` and survives a restart on the same host/volume, but pinning it explicitly avoids any ambiguity across redeploys or host migrations. Full unit file: `docs/deployment.md`.

## What CI gates (`.github/workflows/ci.yml`)

Triggers on push/PR to `main`. Steps: `bun install`, `bun run build`, `bun test` — **with `continue-on-error: true`** on the test step, annotated "Known cross-file test pollution — all tests pass individually." In practice this means: **a red test suite does not fail the CI check** on this repo today. The build step (`bun run build`) is the actual hard gate — it fails the workflow on esbuild errors or `next build` type errors. Don't assume a green CI checkmark means tests passed; it means the build succeeded and tests were merely run. See the `testing` skill for how to interpret/chase individual test failures.

## What `docker-publish.yml` publishes

Triggers **only** on pushing a tag matching `v*` (e.g. `v2.9.0`) — not on every push to `main`. Extracts the version from the tag (`${TAG_REF#refs/tags/v}`), builds the image from the repo-root `Dockerfile`, and pushes to GHCR as both:

- `ghcr.io/geleynse/gantry:<version>`
- `ghcr.io/geleynse/gantry:latest`

No test gate in this workflow at all — publishing is independent of `ci.yml`'s build/test run. Tagging `main` at a red-build commit and pushing it will still publish.

## Version bump convention

`server/package.json` `"version"` (currently `2.8.0`) is the source of truth for the **embedded build version** — `build.ts` reads it and bakes it in via esbuild `--define:process.env.BUILD_VERSION=...`, surfaced at runtime through `lib/build-info.ts` → `BUILD_VERSION` (used in the MCP server's advertised `version` field, `proxy/mcp-factory.ts`). It is **not** read by `docker-publish.yml` — that workflow takes its version purely from the git tag string. Root `package.json` (`"version": "1.0.0"`) is unrelated/unused for release purposes — a stale cosmetic value.

To cut a release that has a self-consistent embedded version: bump `server/package.json`'s `version` field to match the tag you're about to push, commit, then tag and push (`git tag vX.Y.Z && git push origin vX.Y.Z`). There is no automated script enforcing this match — it's a manual convention, easy to let drift.

## Production config recommendations (already documented, cross-referenced here)

- **Auth**: `layered` adapter (local-network + Cloudflare Access) is the documented recommendation for anything beyond pure-localhost use — see the `auth` skill for adapter internals. Never ship `adapter: "none"` on an externally reachable host.
- **`GANTRY_SECRET`**: set explicitly in production; the auto-generated fallback is per-host-and-volume, and losing it breaks decryption of `fleet-credentials.enc.json` (`decryptCredentials` logs a warning per agent and returns an undecryptable password — there's no automatic plaintext fallback; `credentials-crypto.ts` explicitly documents "no plaintext fallback in production"). The only recovery path is the one-time `fleet-credentials.json.bak` left by the original plaintext→encrypted migration, if it's still on disk and wasn't deleted.
- **`TRUST_PROXY=1`**: required behind any reverse proxy (nginx/Caddy/Cloudflare Tunnel) or IP-based auth adapters silently see every request as `127.0.0.1`.
- **Cloudflare Tunnel** is the documented preferred remote-access path (zero open ports) over a raw nginx/Caddy TLS terminator — see `docs/deployment.md` for both.

This skill intentionally omits any specific person's or environment's real hostnames, IPs, or tunnel IDs — treat every example above as a placeholder to replace.
