---
name: frontend-dashboard
description: Use when editing files under server/src/app/ or server/src/components/, adding a new dashboard page, wiring a hook to an API route or SSE stream, gating a control behind admin auth, or debugging "my UI change doesn't show up in the browser".
---

# Frontend Dashboard — Gantry

The dashboard is a React 19 + Next.js 15 app, statically exported (`output: 'export'` in
`server/next.config.ts`) to `server/dist/public/` and served as static files by the Express
server (`src/app.ts`). Confirm you're editing the right tree: `src/app/` (routes),
`src/components/` (shared UI), `src/hooks/` (data/state), `src/lib/` (utilities), `src/shared/`
(server↔frontend type contracts).

## Architecture implications of static export

- **No Next.js server at runtime.** No SSR, no Route Handlers/API routes under `src/app/`, no
  server actions, no `cookies()`/`headers()` server APIs. Every page is effectively a client
  bundle; nearly every `page.tsx` starts with `"use client"` and fetches data itself via
  `fetch`/hooks after mount (see `src/app/facilities/page.tsx` for a representative example).
- **Dynamic routes need `generateStaticParams` + `dynamicParams = false`.** The only dynamic
  segment in the app is `src/app/agent/[name]/page.tsx`. It hardcodes a `STATIC_AGENT_NAMES`
  array (comment: "Keep this in sync with fleet-config.json") and exports
  `generateStaticParams()` returning that list plus `export const dynamicParams = false`.
  **Gotcha:** if a fleet adds/removes an agent, that array must be updated and the client
  rebuilt, or the new agent's detail page 404s (static export can't dynamically match
  unlisted params). The actual page content lives in `client.tsx` (`AgentDetailClient`) —
  `page.tsx` is just the static-params wrapper.
- Two tsconfigs split the tree: `tsconfig.next.json` covers `src/app/`, `src/components/`,
  `src/hooks/`, `src/lib/` only (excludes `src/proxy/`, `src/web/`, `src/shared/`). Don't
  import server-only modules (DB, `src/proxy/*`) into anything under those four dirs — it
  won't type-check and won't bundle in `next build`.

## Dev loop — see the `build-and-dev` skill for full detail

One fact worth repeating because it burns people every time: **`bun run dev` only watches the
server bundle and never rebuilds the dashboard.** If you edit a `.tsx` under `src/app/` or
`src/components/` and the browser still shows old behavior, you didn't rebuild the client:

```bash
bun run build:client   # or bun run build for server+client
```

`bun run dev:client` (`next dev --port 3001`) live-reloads for pure component/styling work but
does **not** proxy `/api/*` or `/mcp*` to the server — it's for visual iteration only, not for
verifying real data flow. For that, rebuild and hit the real server at `:3100`. Never point a
local run at a live fleet just to sanity-check UI — use mock mode (`GANTRY_MOCK=1`, see
`docs/mock-mode.md` / the `mock-mode` skill).

## Data fetching conventions

**One-shot/typed fetch:** `apiFetch<T>(path, options?)` in `src/lib/api.ts`. Prepends `/api`,
throws a typed `ApiError` (`status` + `body`) on non-OK, otherwise returns parsed JSON:

```typescript
import { apiFetch, isApiError } from "@/lib/api";
const data = await apiFetch<FacilitiesResponse>("/facilities?tab=owned");
```

**Polling hooks:** plain `useEffect` + `setInterval` + `apiFetch`, e.g. `use-game-state.ts`
polls `/api/game-state/all` every 15s (`POLL_INTERVAL_MS`), returns `{ data, loading, error }`.
Follow this shape for new poll-based hooks.

**SSE (push) hooks:** `src/hooks/use-sse.ts` exports the generic `useSSE<T>(url, eventName,
options?)` — opens an `EventSource`, exponential backoff reconnect (1s → 30s), returns
`{ data, connected, error }`. Verified real example, `src/hooks/use-fleet-status.ts`:

```typescript
// Server side, src/web/routes/status.ts:
initSSE(req, res);
writeSSE(res, 'status', status);   // event name "status" must match the client

// Client side:
export function useFleetStatus(): UseSSEResult<FleetStatus> {
  const ctx = useContext(FleetStatusContext);
  const fallback = useSSE<FleetStatus>('/api/status/stream', 'status', { disabled: ctx !== null });
  return ctx ?? fallback;
}
```

`FleetStatusProvider` (also in `use-fleet-status.ts`) is mounted once in
`ClientProviders` (`src/components/client-layout.tsx`, wrapped around `{children}` in
`src/app/layout.tsx`) so every page shares **one** `/api/status/stream` connection instead of
each `useFleetStatus()` caller opening its own — this exists specifically so Dashboard/Fleet/
Agent-Detail don't disagree on health scores during reconnect races. If you add a new SSE
consumer for the same stream, prefer subscribing to the existing context/event rather than
opening a second `EventSource` to the same URL — `useToolCallStream()` in the same file shows
the pattern for a second event name (`toolCall`) on the shared connection.

## Keeping `src/shared/types.ts` in sync

`src/shared/types.ts` is the type contract server routes import from (`src/web/routes/status.ts`
imports `AgentStatus`/`FleetStatus`, `agents.ts` imports `AgentStatus`/`AgentStatusWithShutdown`,
`health-details.ts` imports `AgentHealthDetails` — all from the same file). **Verified
gotcha:** the frontend does *not* import `AgentStatus`/`FleetStatus` from `shared/types.ts` for
its SSE hook — `src/hooks/use-fleet-status.ts` declares its own parallel copy of the same
interfaces. If you add/rename a field on `AgentStatus` in `shared/types.ts` (server side), you
must manually mirror the change in `use-fleet-status.ts`'s `AgentStatus` interface or the
frontend type silently drifts from what the server actually sends (TypeScript won't catch it —
there's no shared import to break). Check both files whenever a route response shape changes.
(Some newer types, e.g. `OverseerDecision` in `src/shared/types/overseer.ts`, *are* imported
directly by hooks/pages — that's the pattern to prefer for anything new.)

## Adding a new dashboard page

1. Create `src/app/<route-name>/page.tsx`. Start with `"use client"` unless the page is truly
   static. Fetch data with `apiFetch` + a hook, following `src/app/facilities/page.tsx` as a
   template (tabs, loading/error state, `useAgentNames()` for agent-scoped views).
2. Register it in the sidebar — `src/components/sidebar.tsx`, `NAV_SECTIONS` array. Pick an
   existing section (`Operations`, `Intelligence`, `Game`, `Fleet Control`, `Admin`) or add a
   new one; each item is `{ href, label, icon, adminOnly?, badgeKey? }` using a `lucide-react`
   icon. Set `adminOnly: true` if the page should only appear for admins (filtered via
   `useAuth().isAdmin` inside `SidebarContent`). If the page needs a live nav badge, add a
   `badgeKey` and extend `getBadgeCount()`.
3. If the page is a detail/sub-route off an existing top-level page (like
   `/notes/search` or `/fleet/broadcast`), the active-link highlighting in `sidebar.tsx`
   picks the *longest* matching `href` automatically — no extra work needed beyond adding the
   item.
4. `bun run build:client` and check it renders — Next's static export will fail the build if
   the page has type errors or violates static-export constraints (e.g. missing
   `generateStaticParams` on a dynamic segment).

## Shared component conventions

- **Class merging:** always `cn(...)` from `src/lib/utils.ts` (`clsx` + `tailwind-merge`), not
  raw template strings, when a className is conditional or overridable via props:
  `cn("flex items-center gap-3 px-2 py-1.5 text-sm", isActive && "bg-primary/10 text-primary")`.
- **Tailwind 4, CSS-first config.** No `tailwind.config.js` — theme tokens are declared in
  `src/app/globals.css` via `@theme { --color-primary: #88c0d0; ... }` (Nord palette + semantic
  aliases like `--color-background`, `--color-card`, `--color-destructive`). Reference them as
  Tailwind classes (`bg-primary`, `text-muted-foreground`, `border-border`), not raw hex.
  PostCSS config (`postcss.config.mjs`) is just `@tailwindcss/postcss` — no extra plugins.
- **Component shape:** small, focused, prop-typed function components — see `health-bar.tsx`
  (pure, stateless, `value/max/label/size/invert` props) and `agent-card.tsx` (composes
  `HealthBar`, `ShipImage`, `HealthMetricsCard`, `StandingsPanel`, gates edit controls on
  `useAuth().isAdmin`). Prefer composing smaller named components (`agent-card-status.tsx`,
  `agent-card-actions.tsx`) over one large file once a component grows multiple concerns.
- Icons are `lucide-react` throughout; don't introduce a second icon library.

## Auth gating of admin controls

`src/components/auth-provider.tsx` wraps the whole app in `AuthContext.Provider` (mounted in
`app/layout.tsx`, outside `ClientProviders`). `src/hooks/use-auth.ts`:

```typescript
export type AuthRole = "admin" | "viewer";
export function useAuth(): AuthState { return useContext(AuthContext); }
```

`useAuthFetch()` calls `apiFetch("/auth/me")` once on mount and defaults to `{ role: "viewer",
isAdmin: false }` on any error — **fail closed**, never assume admin. Gate admin-only UI with
`const { isAdmin } = useAuth();` and either skip rendering the control or disable it. Real
examples: `sidebar.tsx` filters `NAV_SECTIONS` items by `!adminOnly || isAdmin`; `agent-card.tsx`
uses `isAdmin` to decide whether edit controls render. The dashboard docs (`docs/dashboard.md`)
describe the resulting UX split: viewer mode is read-only (status/logs/analytics), admin mode
adds start/stop/restart, instruction injection, and note editing.

## Testing and visual verification

Component/hook testing setup, RTL patterns, and the `cleanup()`/`MockEventSource` gotchas are
covered in the `testing` skill — read that before writing a new `*.test.tsx`. Short version:
`bunfig.toml` preloads `src/test/setup.ts` (happy-dom via `GlobalRegistrator`, jest-dom
matchers, a `MockEventSource` registered as `globalThis.EventSource`); tests live next to the
component (`src/components/__tests__/*.test.tsx`) using `@testing-library/react`'s
`render`/`screen`/`renderHook`. If a component polls (`setInterval`), call `cleanup()` in
`afterEach` or the leaked effect keeps polling into later test files (see
`fleet-capacity.test.tsx`'s comment on this).

To see a UI change working end-to-end without a live SpaceMolt fleet, use mock mode
(`GANTRY_MOCK=1 bun dist/index.js`, config via `gantry.json`'s `mockMode` key) — full details
in `docs/mock-mode.md` and the `mock-mode` skill. Never start the server against a real fleet
account just to check a frontend change.
