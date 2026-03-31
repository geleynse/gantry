# Authentication

Gantry uses a pluggable auth system. Configure it via the `auth` key in `gantry.json`.

---

## Roles

There are two roles:

| Role | Access |
|------|--------|
| `admin` | Full access — start/stop agents, write data, access MCP endpoints |
| `viewer` | Read-only — dashboard, status, analytics. No agent control. |

GET requests are viewer-accessible. POST/PUT/DELETE and all MCP endpoints require admin.

MCP connections from localhost (`127.0.0.1` / `::1`) always get admin — agent processes connect locally and don't need to authenticate.

---

## Default behavior

If you omit the `auth` key from `gantry.json`, Gantry uses the `loopback` adapter: only requests from `127.0.0.1` or `::1` get admin access. All other requests get viewer.

This is intentionally conservative. For local-only use on a trusted network, explicitly set `"adapter": "none"` to grant admin to everyone.

---

## Adapters

### `none` — no auth (development only)

Every request gets admin. Only use this for local development.

```jsonc
{
  "auth": {
    "adapter": "none"
  }
}
```

Gantry logs a warning when this is active and a second warning if the server appears to be externally accessible.

---

### `token` — shared secret

Clients send a Bearer token in the `Authorization` header. Requests with the correct token get admin; others get viewer (read-only access is still allowed).

```jsonc
{
  "auth": {
    "adapter": "token",
    "config": {
      "token": "your-fleet-secret"
    }
  }
}
```

**Accepted format:**
- `Authorization: Bearer <token>` header

Token comparison uses timing-safe equality (SHA-256 hashed) to prevent length-leaking side channels.

Use this when you want a simple password for dashboard access without Cloudflare.

---

### `local-network` — IP allowlist

Requests from configured IP ranges get admin. All others get viewer.

```jsonc
{
  "auth": {
    "adapter": "local-network",
    "config": {
      "allowedIpRanges": ["192.168.1.0/24", "10.0.0.0/8"]
    }
  }
}
```

If `allowedIpRanges` is omitted, defaults to RFC 1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).

Use this when Gantry is only accessible inside your LAN and you want admin without a password.

---

### `cloudflare-access` — Cloudflare Access JWT

Validates the JWT issued by Cloudflare Access. Valid JWT = admin. Missing or invalid JWT = viewer.

```jsonc
{
  "auth": {
    "adapter": "cloudflare-access",
    "config": {
      "teamDomain": "yourteam.cloudflareaccess.com",
      "audience": "your-application-aud-tag"
    }
  }
}
```

The `teamDomain` is your Cloudflare Zero Trust team domain. The `audience` is the AUD tag from your Cloudflare Access application (found in the Zero Trust dashboard under the application settings).

The JWT is read from the `Cf-Access-Jwt-Assertion` header or the `CF_Authorization` cookie. Keys are fetched from `https://{teamDomain}/cdn-cgi/access/certs` and cached for 10 minutes.

**Validation checks:** RSA signature, issuer (`iss`), audience (`aud`), expiry (`exp`), not-before (`nbf`), issued-at clock skew (60s tolerance).

---

### `layered` — local network + Cloudflare Access

Tries multiple auth methods in order. Use this when you want local admin access AND remote access via Cloudflare.

```jsonc
{
  "auth": {
    "adapter": "layered",
    "config": {
      "localNetworkRanges": ["192.168.0.0/16", "10.0.0.0/8"],
      "cloudflareTeamDomain": "yourteam.cloudflareaccess.com",
      "cloudflareAudience": "your-audience-tag",
      "adminDomains": ["admin.example.com"]
    }
  }
}
```

**Resolution order:**
1. If a Cloudflare JWT is present: validate it. Success = admin.
2. If the source IP matches `localNetworkRanges`: admin.
3. Otherwise: viewer.

`adminDomains` is an optional hint that annotates which Cloudflare tunnel the admin came through — it does **not** grant admin on its own. The `Host` header is client-supplied and spoofable; domain matching only activates after a valid CF JWT confirms identity.

---

### Custom adapter

Supply a path to a JS/TS module. The module must export a default `AuthAdapter` object with an `authenticate(req)` method.

```jsonc
{
  "auth": {
    "adapter": "./my-adapter.js"
  }
}
```

The path must start with `./` (relative to the working directory). This is an intentional restriction to prevent arbitrary package imports.

```typescript
// my-adapter.js
export default {
  name: "my-adapter",
  async authenticate(req) {
    const token = req.headers["x-my-token"];
    if (token === process.env.MY_SECRET) {
      return { role: "admin", identity: "known-user" };
    }
    return null; // null → viewer
  }
};
```

---

## Security recommendations

**For local-only deployments:**
- Use `local-network` with your LAN CIDR.
- MCP agent connections from localhost are always admin — no config needed.

**For internet-exposed deployments:**
- Use Cloudflare Tunnel + `cloudflare-access`. This is the most secure option: no open ports, identity verification by Cloudflare.
- Alternatively, use `token` with a strong random secret and serve over HTTPS via a reverse proxy.
- Never use `none` on an externally accessible server.

**Credential encryption:**
- Agent passwords in `fleet-credentials.json` are automatically encrypted at rest (AES-256-GCM) on first startup. The plaintext file is migrated to `fleet-credentials.enc.json` with a `.bak` backup.
- Set `GANTRY_SECRET` to a stable value in production. If unset, Gantry auto-generates a key saved to `$FLEET_DIR/data/.gantry-secret` (mode 0600). If the key changes, Gantry falls back to the plaintext file.
- Keep the plaintext `.bak` file until you've confirmed the encrypted file works across restarts.

**Reverse proxy setup:**
- Always set `TRUST_PROXY=1` when behind nginx/caddy so IP-based auth reads `X-Forwarded-For` correctly.
- Without this, every request appears to come from `127.0.0.1` and may get unintended admin access.

---

## Checking your auth role

```bash
curl http://localhost:3100/api/auth/me
# → { "role": "admin", "identity": "192.168.1.5" }
# or
# → { "role": "viewer" }
```

Public endpoints (always accessible regardless of auth):
- `GET /health`
- `GET /health/instability`
- `GET /api/ping`
