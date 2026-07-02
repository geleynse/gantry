---
name: auth
description: Use when configuring or debugging Gantry's auth adapters (none/token/local-network/cloudflare-access/layered/loopback), seeing unexpected 403s or unexpected admin access, wiring a new adapter, or working on AuthProvider/useAuth in the dashboard.
---

# Auth — Gantry Server

Pluggable role-based auth. Two roles only: `admin` (full access) and `viewer` (read-only). Full adapter config reference: `docs/auth.md`. This skill covers adapter internals, route classification, and the frontend gating that the reference doc doesn't.

## Adapter factory: `server/src/web/auth/index.ts::createAuthAdapter(authConfig)`

Built from `gantry.json`'s `auth` key (`{ adapter: string, config?: object }`). Resolution:

- **No `auth` key, or `adapter: "loopback"`** → `LoopbackAdapter` (the documented default — admin only from `127.0.0.1`/`::1`).
- `adapter` string matches a built-in name (switch statement) → that adapter.
- Anything else → must start with `./` (custom adapter, dynamic `import()` of a local JS/TS module exporting a default `AuthAdapter`). Throws if it doesn't start with `./` — this is deliberate, to block arbitrary package imports from `gantry.json`.

**Built-in adapter names in code — more than the docs list.** `docs/auth.md` and `server/AGENTS.md` document five: `none`, `token`, `cloudflare-access`, `local-network`, `layered` (plus the `loopback` default). The switch statement in `index.ts` also has two more, undocumented in `docs/auth.md`:

- **`deny`** (`adapters/deny.ts`) — `authenticate()` always returns `null` (always viewer, never admin, no anonymous admin possible even on MCP/localhost bypass paths that don't apply here). Used internally as a fail-closed fallback concept (see `isExternallyAccessible()` commentary in `index.ts`), but is directly selectable via `"adapter": "deny"` too.
- **`domain`** (`adapters/domain.ts`) — grants admin by matching the `Host` header against `adminDomains`, but **only** if a `cf-access-jwt-assertion` header is also present (it doesn't validate the JWT itself, just requires evidence the request passed through Cloudflare's edge). The adapter's own doc comment says it "MUST NOT be used as a standalone auth mechanism" — it's designed to be composed inside another adapter after a real CF JWT check, not selected directly. **Doc mismatch**: `docs/auth.md`'s `layered` section describes `adminDomains` as "an optional hint that annotates which Cloudflare tunnel the admin came through" — but `layered.ts`'s own `LayeredConfig` comment says `adminDomains` is "accepted but unused — domain auth requires a standalone domain adapter." The `layered` adapter's `authenticate()` never reads `adminDomains` at all; only `localNetworkRanges` and Cloudflare fields matter. If you need domain-based gating, wire the `domain` adapter explicitly (or write a custom one) — `layered` alone will not do it despite what `adminDomains` in its config suggests.

## Adapter config keys (verified against source, not just docs)

| Adapter | File | Config key(s) | Behavior |
|---|---|---|---|
| `loopback` | `adapters/loopback.ts` | none | Admin only if `req.ip` ∈ `{127.0.0.1, ::1, ::ffff:127.0.0.1}`. Missing IP → viewer (fail-closed). |
| `none` | inline in `index.ts` | none | Every request → admin. Logs a `⚠️` warning always, an `🚨` error too if `isExternallyAccessible()` (checks `CF_TUNNEL`/`GANTRY_EXTERNAL` env vars). |
| `deny` | `adapters/deny.ts` | none | Every request → viewer, unconditionally. |
| `token` | `adapters/token.ts` | `{ token: string }` — **not** `secret`, `password`, or anything else | Reads `Authorization: Bearer <token>` **only** — no query param, no custom header. SHA-256-hashes both sides and compares with `timingSafeEqual` (constant-time, avoids length-leak). Throws at construction if `config.token` is empty/missing. |
| `local-network` | `adapters/local-network.ts` | `{ allowedIpRanges?: string[] }` | CIDR (`"192.168.1.0/24"`) or glob-style (`"192.168.*"`) ranges, IPv4 only. Default when omitted: `["127.0.0.1/32", "192.168.0.0/16", "10.0.0.0/8", "172.16.0.0/12"]` — **broader than `docs/auth.md` states** (docs say default is just the three RFC 1918 ranges; code also includes `127.0.0.1/32`). |
| `cloudflare-access` | `adapters/cloudflare-access.ts` | `{ teamDomain: string, audience?: string }` — **`audience` is optional in code**, though `docs/auth.md` implies it's required | Validates `Cf-Access-Jwt-Assertion` header or `CF_Authorization` cookie: RSA sig via keys fetched from `https://{teamDomain}/cdn-cgi/access/certs` (cached 10 min, per-adapter-instance `Map` cache for imported `CryptoKey`s), `iss === https://{teamDomain}`, `aud` includes `audience` (only checked if `audience` is set), `nbf`, `iat` (60s future-skew tolerance), `exp`. Throws at construction if `teamDomain` missing. |
| `layered` | `adapters/layered.ts` | `{ localNetworkRanges?: string[], cloudflareTeamDomain?: string, cloudflareAudience?: string, adminDomains?: string[] }` | Order: if a CF JWT/cookie is *present*, try CF first (admin on success, falls through — does not deny — on failure); then try `local-network` with `localNetworkRanges`; else viewer. `adminDomains` is accepted in the type but **never read** — see mismatch above. CF sub-adapter only constructed if `cloudflareTeamDomain` is set. |
| `domain` | `adapters/domain.ts` | `{ adminDomains: string[] }` | Admin if `Host` header ∈ `adminDomains` **and** a `cf-access-jwt-assertion` header is present (not validated, just checked for presence). Not documented in `docs/auth.md`; see warning above. |
| custom | file path | adapter-defined | Path must start with `./`; module's default export needs `.authenticate(req)`. |

## Route classification (`server/src/web/auth/middleware.ts`)

`authMiddleware(adapter)` runs this order:

1. **Public routes** (`isPublicRoute`, exact path match): `/health`, `/health/instability`, `/api/ping` — always pass, `adapter.authenticate()` is never called, `req.auth` is left `undefined`.
2. **MCP localhost bypass**: if the path is under `/mcp` or `/sessions` (`isMcpRoute`) *and* the request IP is loopback (`isLocalhost`) — force `req.auth = { role: "admin", identity: "localhost" }`, skip the adapter entirely. This is how agent processes (which always connect from `127.0.0.1`) get admin without any auth config.
3. **Authenticate** via `adapter.authenticate(req)`. Adapter throwing is **fail-closed**: normally returns HTTP 503 (`Authentication service unavailable`) rather than falling back to viewer — except on the one auth-optional route (next point), where an adapter error is swallowed into `viewer`.
4. **Authorization check** (`isAdminRoute`): non-`GET` methods, all `/mcp*`/`/sessions*` (even `GET`), a fixed `ADMIN_ONLY_PREFIXES` list (`/devtools`, `/api/prompts`, `/api/comms`, `/api/overseer`, `/api/notes`, `/api/captains-logs`, `/api/fleet/broadcast`, `/api/credentials`, `/api/outbound`), and a few per-agent regex patterns (`/api/agents/:name/inject|directives|shutdown`) all require `admin`; everything else is viewer-readable. Viewer hitting an admin route → 403.

## The `/api/auth/me` gotcha — auth-optional, not public

`/api/auth/me` sits in a **separate** `AUTH_OPTIONAL_ROUTES` set, distinct from `PUBLIC_ROUTES`. This matters because of step 1 above: **public routes skip `adapter.authenticate()` entirely**, so `req.auth` is never populated. If `/api/auth/me` were public, the dashboard's "who am I" check would read an `undefined` `req.auth` and the frontend would have nothing to render. Instead, `/api/auth/me` is routed through the adapter (so `req.auth` gets set correctly to `admin` or `viewer`) but is exempted from the step-4 admin gate — a viewer hitting it does not get 403'd, it just gets `{ role: "viewer" }` back. On adapter error on this route specifically, the middleware swallows it to `viewer` instead of 503ing (see `middleware.ts` `isOptional` branch) — this route must never hard-fail, since the dashboard's own login-state check depends on it responding.

Adding a new route that needs to *know* the caller's role without gating on it (rare) → add it to `AUTH_OPTIONAL_ROUTES`, not `PUBLIC_ROUTES`.

## Frontend gating

`server/src/hooks/use-auth.ts` — `useAuthFetch()` calls `GET /api/auth/me` on mount, parses `{ role, identity }`, exposes `{ role, identity, loading, isAdmin }` via React context. On fetch error or malformed payload, defaults to `{ role: "viewer", isAdmin: false }` (safe default, never fails open to admin). `server/src/components/auth-provider.tsx` wraps the app (`app/layout.tsx`) with this context. Consumers call `useAuth()` (e.g. `components/sidebar.tsx`, `components/top-bar.tsx`) and gate admin-only UI with `isAdmin && (...)` or filter nav items by an `adminOnly` flag. **This is presentation-layer only** — hiding a button does not enforce anything; the real gate is server-side `isAdminRoute()` in `middleware.ts`. Never rely on frontend `isAdmin` checks as a security boundary.

## Adding or modifying an adapter

1. New file in `server/src/web/auth/adapters/your-adapter.ts`, export `createYourAdapter(config): AuthAdapter` returning `{ name, authenticate(req) }`.
2. `authenticate()` returns `Promise<AuthResult | null>` — `null` means "this adapter has no opinion, treat as viewer" (not an error). Throw only for genuinely unexpected failures (network errors fetching JWKs, etc.) — those trigger the fail-closed 503 path in the middleware.
3. Register the built-in name in the `switch` in `server/src/web/auth/index.ts`.
4. Add a co-located `your-adapter.test.ts` — see below for the pattern.
5. Document the config shape in `docs/auth.md` if it's meant to be user-facing (both `deny` and `domain` currently skip this step — don't repeat that for new adapters).

## Common mistakes

- **Confusing `token` with `secret`.** The token adapter's config key is `token`, not `secret` or `password`. `{ "adapter": "token", "config": { "secret": "..." } }` silently constructs an adapter with `config.token === undefined`, which throws at startup ("Token must be a non-empty string") rather than failing quietly — but the error message doesn't point at the typo, so check the key name first.
- **Forgetting `TRUST_PROXY=1` behind a reverse proxy.** `local-network`, `layered`, and `loopback` all key off `req.ip`. Without `TRUST_PROXY=1`, every request behind nginx/Caddy/a tunnel appears to originate from the proxy's own loopback address — which can grant unintended admin access under `loopback` or a `local-network` range that includes `127.0.0.1/32`. See the `deploy-and-release` skill.
- **Expecting `adminDomains` to do something under `layered`.** It doesn't — see the mismatch noted above. Use a dedicated `domain` adapter (or a custom one) if you need Host-header-based gating.
- **Assuming `cloudflare-access` requires `audience`.** It's optional in code; omitting it means any validly-signed JWT from the configured `teamDomain` grants admin, regardless of which CF Access application issued it. Set `audience` unless you deliberately want that.
- **Relying on frontend `isAdmin` for security.** It's a UI convenience only — see Frontend gating above. The real boundary is `isAdminRoute()` server-side.

## Testing auth middleware

Two test files, no live server:

- `server/src/web/auth/auth.test.ts` — adapter-level unit tests (construct with a config object, call `.authenticate(fakeReq)`, assert the `AuthResult`) plus `createAuthAdapter()` factory tests (assert `.name` for each `adapter` string). `fakeReq` is a plain object literal cast `as Request` — no supertest/Express app needed for adapter tests.
- `server/src/web/auth/middleware.test.ts` — tests `authMiddleware()` itself plus the exported helpers `isPublicRoute`, `isMcpRoute`, `isLocalhost`, `isAdminRoute`. Uses hand-rolled `makeReq()`/`makeRes()`/`makeNext()` helpers (not supertest) since the middleware only needs `req.method`/`req.path`/`req.ip`/`req.headers`/`req.get()`, not a real HTTP round-trip.
- `server/src/web/auth/auth-debug.test.ts` — covers the auth-optional fallback behavior specifically (adapter throwing on `/api/auth/me` degrading to viewer instead of 503) using its own `fakeReq()`/`fakeRes()` helpers plus a real `express()` app for a couple of end-to-end cases. Look here first if you're touching the fail-closed-vs-fail-open branching in `middleware.ts`.

Both patterns avoid spinning up Express — construct the adapter or middleware function directly and call it with a minimal fake `Request`. Follow this pattern for new adapter tests rather than reaching for supertest (supertest is for route handlers under `web/routes/`, see the `testing` skill).
