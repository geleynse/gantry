# PLAN — Prayer UI

Operator surfaces for PrayerLang. Backend already ships the runtime
(`server/src/proxy/prayer/`, `spacemolt_pray` MCP tool) and full telemetry —
the dashboard has zero prayer-specific views. This plan adds what an on-call
operator needs to debug a misbehaving prayer call at 3am.

## Data sources — no schema changes

Prayer calls already persist end-to-end through the existing tool-call logger
(`src/proxy/tool-call-logger.ts`). The `spacemolt_pray` handler in
`src/proxy/gantry-v2.ts` wraps each call with `logToolCallStart` /
`logToolCallComplete`; PrayerLang subcalls are logged with `parent_id` pointing
at the prayer row.

For a prayer row in `proxy_tool_calls`:

- `tool_name = 'pray'`
- `is_compound = 1`
- `args_summary` — JSON: `{ script, max_steps, timeout_ticks }`
- `result_summary` — JSON: `{ status, steps_executed, handoff_reason, error }`
- `trace_id` — ties to subcall rows via `parent_id`
- subcalls: any `spacemolt_*` tool the executor dispatched during the script

Turn counts live in the `turns` table. Adoption = `pray rows ÷ turns` per
agent over a window. **No new tables, no persistence layer.** Smaller option
wins.

## API endpoints (new)

All mounted under `/api/prayer/*` from `src/web/routes/prayer.ts`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/prayer/recent?agent=&limit=` | Recent prayer rows for an agent (joins subcalls via `parent_id`). Returns parsed script, result, subcall list, duration. |
| `GET` | `/api/prayer/adoption?hours=` | Per-agent adoption: prayer count, turn count, ratio, avg steps, success rate, last prayer ts. |

Existing `/api/prayer-canary` (POST) stays as-is — UI just calls it.

## Components (new)

| File | Purpose |
|---|---|
| `src/components/prayer-row.tsx` | Themed tool-call-feed row for `pray`. Script in monospace, status badge, step/duration/subcall count, expand to show normalized script + subcall tree + diff. |
| `src/components/prayer-panel.tsx` | Agent-detail tab content. Top card = adoption stats for this agent. List = recent prayer calls using the row component. |
| `src/components/prayer-canary-button.tsx` | Admin-only button on agent controls. Confirms, POSTs, surfaces the "watch logs" hint. |

## Component edits

- `src/components/tool-call-feed.tsx` — route `pray` records to `PrayerRow`, add to `COMPOUND_TOOL_NAMES`.
- `src/components/activity-feed.tsx` — classify `pray` as `"actions"` so it surfaces in fleet activity. No new filter tab.
- `src/app/agent/[name]/client.tsx` — add `"prayer"` tab. Hide tab when `prayEnabled !== true`.
- `src/components/agent-controls.tsx` — insert `<PrayerCanaryButton/>` in `ProcessControls` (admin-only, disabled when running).
- `src/app/diagnostics/page.tsx` — add a `PrayerAdoptionCard` showing per-agent adoption from `/api/prayer/adoption`.

## Expose prayEnabled

`src/web/routes/status.ts` currently doesn't forward `prayEnabled` — add it so
the UI can conditionally show prayer tab / canary button without reading
config directly.

## Open questions (resolved inline)

- **Siloed vs. inline?** Both. Prayer rows interleave in the existing
  activity and tool-call feeds (inline), and there's a dedicated tab per
  agent with adoption metrics (scannable).
- **Adoption window?** Default 24h; diagnostics card has 24h/7d toggle.
- **SSE?** Reuse the existing `/api/tool-calls/stream` — prayer rows already
  ride it. No new SSE endpoint.
- **Canary on stopped agents only?** Yes — `startAgentCanary` rejects if
  already running. Button disables to match.

## Testing

- `src/web/routes/prayer.test.ts` — adoption and recent endpoints against a
  seeded in-memory DB.
- `src/components/__tests__/prayer-row.test.tsx` — render path for success,
  error, and pending prayer rows.
- Existing `tool-call-feed.test.ts` stays green.

## Deliberately out of scope

- No prayer script editor / replay UI — the canary button is enough.
- No "prayer suggestions" or PrayerLang linting surface — future
  agent-side feature.
- No new top-level `/prayer` page — everything fits on agent detail +
  diagnostics.
