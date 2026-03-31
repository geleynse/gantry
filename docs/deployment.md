# Deployment

Gantry runs as a single process on port 3100. Choose the deployment method that fits your setup.

---

## Option A: Docker (recommended)

No Bun or Node.js needed on the host. Requires Docker and Docker Compose.

### Quick start

```bash
git clone https://github.com/geleynse/gantry.git
cd gantry

# Scaffold a fleet directory
mkdir -p _data
bun server/scripts/gantry-setup.ts _data
# Edit _data/gantry.json with your agent config

# Build and run
docker compose up --build -d
```

Dashboard is at `http://localhost:3100`.

### docker-compose.yml

The included `docker-compose.yml` covers the common case:

```yaml
services:
  gantry:
    build:
      context: .
      dockerfile: Dockerfile
    image: gantry:local
    ports:
      - "${GANTRY_PORT:-3100}:3100"
    volumes:
      - ${FLEET_DIR:-./_data}:/data
    environment:
      - FLEET_DIR=/data
      - LOG_LEVEL=${LOG_LEVEL:-info}
      - TRUST_PROXY=${TRUST_PROXY:-0}
      - GANTRY_SECRET=${GANTRY_SECRET:-}
    restart: unless-stopped
```

### Environment variables

Set these in a `.env` file next to `docker-compose.yml` or in your shell:

| Variable | Default | Description |
|----------|---------|-------------|
| `FLEET_DIR` | `./_data` | Host path to your fleet directory. Mounted at `/data` in the container. |
| `GANTRY_PORT` | `3100` | Host port to expose. |
| `LOG_LEVEL` | `info` | Log verbosity: `debug`, `info`, `warn`, `error`. |
| `GANTRY_SECRET` | *(auto-generated)* | AES-256-GCM key for credential encryption. Set explicitly to survive container restarts. |
| `TRUST_PROXY` | `0` | Set to `1` if behind a reverse proxy (enables `X-Forwarded-For` trust). |

### Volumes

The container expects a single volume at `/data` — your fleet directory. This is where `gantry.json`, agent prompt files, `fleet-credentials.enc.json`, and the SQLite database live.

```
_data/                    ← mounted at /data
├── gantry.json           ← main config
├── fleet-credentials.enc.json
├── data/
│   └── fleet.db          ← SQLite database
├── logs/
│   └── server.log
├── my-agent.txt      ← agent prompts
└── common-rules.txt
```

### Rebuilding after code changes

```bash
docker compose up --build -d
```

---

## Option B: Systemd Service (Bun)

For bare-metal or VM installs without Docker.

### Install

```bash
# 1. Clone and build
git clone https://github.com/geleynse/gantry.git /opt/gantry
cd /opt/gantry/server
bun install
bun run build         # builds server + Next.js dashboard
bun run build:binary  # compiles standalone binary → dist/gantry

# 2. Set up fleet directory
bun scripts/gantry-setup.ts /opt/gantry-fleet
# Edit /opt/gantry-fleet/gantry.json
```

### Systemd unit

Create `/etc/systemd/system/gantry.service`:

```ini
[Unit]
Description=Gantry Fleet Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=gantry
WorkingDirectory=/opt/gantry/server
ExecStart=/opt/gantry/server/dist/gantry
Restart=on-failure
RestartSec=5

Environment=FLEET_DIR=/opt/gantry-fleet
Environment=PORT=3100
Environment=LOG_LEVEL=info
# Set GANTRY_SECRET to a stable value — auto-generated key is lost on restart
Environment=GANTRY_SECRET=<your-secret-here>

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now gantry
journalctl -u gantry -f
```

### Using Bun directly (without the compiled binary)

If you prefer to run with Bun instead of the standalone binary:

```ini
ExecStart=/home/user/.bun/bin/bun run /opt/gantry/server/dist/index.js
```

---

## Option C: Single Binary

Self-contained executable (~200 MB). No Bun, no Node.js, no npm on the target host.

```bash
# Build (requires Bun locally)
cd gantry/server
bun install && bun run build:binary

# Run the setup script locally to scaffold a fleet directory
bun scripts/gantry-setup.ts ./my-fleet
# Edit my-fleet/gantry.json with your agent config

# Copy binary + fleet directory to target
scp dist/gantry user@server:/opt/gantry/
scp -r my-fleet user@server:/opt/gantry/fleet

# Run on target (no Bun or Node.js needed)
ssh user@server
FLEET_DIR=/opt/gantry/fleet \
GANTRY_SECRET="$(openssl rand -hex 32)" \
/opt/gantry/gantry
```

Static frontend assets are embedded in the binary at compile time — no `dist/public/` needed alongside it.

---

## Remote Access

### Cloudflare Tunnel

Zero open ports. Cloudflare Tunnel creates an outbound-only connection from your server.

```bash
# Install cloudflared on the server
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/

cloudflared tunnel login
cloudflared tunnel create gantry
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /home/user/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: gantry.example.com
    service: http://localhost:3100
  - service: http_status:404
```

Run as a service:

```bash
cloudflared service install
systemctl start cloudflared
```

Add a DNS CNAME in Cloudflare pointing `gantry.example.com` to `<tunnel-id>.cfargotunnel.com`.

**Restrict with Cloudflare Access**: Create a Zero Trust application in the Cloudflare dashboard for `gantry.example.com`, then configure Gantry's auth to validate the Access JWT. See [auth.md](auth.md) for the `cloudflare-access` adapter.

### Nginx reverse proxy

```nginx
server {
    listen 80;
    server_name gantry.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name gantry.example.com;

    ssl_certificate     /etc/letsencrypt/live/gantry.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gantry.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE: disable buffering for real-time tool call streams
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

Set `TRUST_PROXY=1` in Gantry's environment so it reads `X-Forwarded-For` for auth IP checks.

### Caddy reverse proxy

```caddy
gantry.example.com {
    reverse_proxy localhost:3100 {
        flush_interval -1  # disable buffering for SSE
    }
}
```

Caddy handles TLS automatically via Let's Encrypt. Set `TRUST_PROXY=1`.

---

## Health check

```bash
curl http://localhost:3100/health
# → { "status": "ok", "uptime": 1234 }
```

The Docker healthcheck polls this endpoint every 30 seconds.
