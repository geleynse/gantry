# Account Pool

The account pool provides centralized credential management for fleets with many game accounts. Instead of configuring credentials per agent in `fleet-credentials.json`, you maintain a shared pool of accounts and let Gantry assign them automatically.

---

## Quick Start

1. Create an account pool file (or copy from `examples/account-pool.json.example`):

```json
{
  "accounts": [
    {
      "username": "pilot-alpha",
      "password": "your-password",
      "status": "available",
      "faction": "solarian"
    },
    {
      "username": "pilot-bravo",
      "password": "your-password",
      "status": "available",
      "faction": "crimson"
    }
  ],
  "config": {
    "autoAssign": true,
    "matchFaction": true
  }
}
```

2. Point to it in `gantry.json`:

```jsonc
{
  "accountPool": "./account-pool.json"
  // ... rest of your config
}
```

3. Start Gantry. Accounts are assigned to agents at login time.

---

## How Assignment Works

When an agent logs in and `autoAssign` is enabled:

1. Gantry checks if the agent already has an assigned account. If so, reuses it.
2. If `matchFaction` is on and the agent has a faction in its config, Gantry prefers an available account with the same faction.
3. Falls back to the first available account.
4. The account is marked `assigned` and persisted to disk.

Assignment is sticky — an agent keeps its account across restarts unless `releaseOnShutdown` is enabled.

---

## Account Statuses

| Status | Description |
|--------|-------------|
| `available` | Ready to be assigned to an agent. |
| `assigned` | Currently in use by an agent. |
| `disabled` | Excluded from the pool. Won't be assigned. |

---

## Pool Configuration

The `config` object in the pool file controls behavior:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoAssign` | boolean | `true` | Automatically assign available accounts to agents at login. |
| `matchFaction` | boolean | `true` | Prefer accounts whose faction matches the agent's faction. |
| `releaseOnShutdown` | boolean | `false` | Release all assignments when Gantry shuts down cleanly. |
| `maxAssignmentsPerAccount` | number | `1` | Max agents per account (safety guard). |

---

## Account Fields

| Field | Required | Description |
|-------|----------|-------------|
| `username` | Yes | Game account username. |
| `password` | Yes | Game account password. Encrypted at rest after first load. |
| `status` | No | `available`, `assigned`, or `disabled`. Defaults to `available`. |
| `id` | No | Unique identifier. Defaults to `username`. |
| `faction` | No | Used for faction-matching when `matchFaction` is on. |
| `assignedTo` | No | Agent name (set automatically). |
| `assignedAt` | No | ISO timestamp (set automatically). |
| `notes` | No | Free-text notes for operators. |

---

## Encryption

Passwords are encrypted at rest using AES-256-GCM, the same mechanism as `fleet-credentials.json`. On first load, plaintext passwords are encrypted and the pool file is rewritten. The encryption key comes from the `GANTRY_SECRET` environment variable (or is auto-generated).

Encrypted passwords are prefixed with `enc:` in the file. Gantry decrypts them transparently on load.

---

## API

The account pool is exposed via the REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/accounts` | List all accounts (passwords redacted). |
| `POST` | `/api/accounts/:agent/assign` | Manually assign an account to an agent. |
| `DELETE` | `/api/accounts/:agent` | Release an agent's account. |

---

## vs. `fleet-credentials.json`

| Feature | `fleet-credentials.json` | Account Pool |
|---------|--------------------------|--------------|
| Per-agent credentials | Yes (manual) | Automatic |
| Faction matching | No | Yes |
| Release on shutdown | No | Optional |
| API management | No | Yes |
| Best for | Small fleets (1-5 agents) | Large or dynamic fleets |

You can use either approach, but not both. When `accountPool` is set in `gantry.json`, it takes precedence over `fleet-credentials.json` for credential lookup.
