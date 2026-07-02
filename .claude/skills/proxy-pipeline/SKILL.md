---
name: proxy-pipeline
description: Use when modifying how MCP tool calls flow through Gantry's proxy — adding a guardrail, adding a response injection, changing tick-wait/enrichment behavior, or reasoning about v1 vs v2 dispatch, shared state, or the config hot-reload snapshot gotcha.
---

# Proxy Request Pipeline — Gantry

Every agent tool call (v1 flat tool or v2 `spacemolt(action=...)`) flows
through the same shared pipeline, implemented once in `pipeline.ts` /
`passthrough-handler.ts` / `injection-registry.ts` and called from both
`server.ts` (v1 factory) and `gantry-v2.ts` (v2 factory). Modify the shared
functions, not the per-version factories, unless the behavior genuinely
differs between v1 and v2.

## Request flow

```
MCP tools/call (v1 or v2 endpoint)
  1. getAgentForSession()        pipeline.ts — session→agent lookup, restart recovery
  2. tool-name sanitization       gantry-v2.ts — strips XML artifact suffixes from action strings
  3. checkGuardrailsV1/V2()       pipeline.ts — see Guardrails below
  4. combat auto-trigger check    combat-auto-trigger.ts — substitutes flee/scan_and_attack on pirate_combat events
  5a. compound-tool dispatch      tool-registry.ts buildCompoundActions() dispatch table
  5b. OR passthrough              passthrough-handler.ts handlePassthrough()
        -> per-tool structural guards (fuel-floor, cargo-full-dock, refuel-target, pre-dock, ...)
        -> executeForClient()     dispatch-v1-to-v2.ts — routes v1 names to v2 {tool,action} when isV2()
        -> tick wait / event-buffer poll for STATE_CHANGING_TOOLS
        -> error hints            error-hints.ts addErrorHint()
  6. withInjections()             injection-registry.ts — merges all enabled injections
  7. decontaminateLog()           pipeline.ts + proxy-constants.ts CONTAMINATION_WORDS
  8. logToolCallStart/Complete()  tool-call-logger.ts — SQLite + ring buffer + SSE push
Agent receives result
```

`docs/architecture.md`'s pipeline diagram lists 9 numbered stages in roughly
this order — it does call out combat auto-trigger explicitly (its stage 4,
"Pre-flight checks"), but it never mentions the structural per-tool guards
(fuel-floor, cargo-full-dock, refuel-target, pre-dock) at all, in any stage —
use the file list above as the authoritative map when you need to find where
a specific behavior lives.

## Guardrails — two different mechanisms, pick the right one

**1. Cross-tool guardrails** (`checkGuardrailsV1`/`checkGuardrailsV2` in
`pipeline.ts`): denials, call limits, duplicate-call detection, cargo
saturation (≥95% blocks `mine`/`batch_mine`/`survey_system`), instability
gate, transit throttle, self-destruct-in-transit block, shutdown signal.
These run for **every** tool call before dispatch and return a plain string
(the error message) or `null`. Add here when the rule applies broadly across
many tools by name/action, keyed off `ctx.config`, `ctx.statusCache`, or a
per-agent tracker.

**2. Structural per-tool guards** (wired as early returns inside
`handlePassthrough()` in `passthrough-handler.ts`): `checkRefuelTargetGuard`,
`checkFuelFloorGuard` + `checkCargoFullDockGuard` (from `fuel-floor-guard.ts`),
the pre-dock known-non-dockable check, the idempotent dock/undock no-op
check, the `buy_insurance` already-insured skip. Add here when the guard
needs full context about one specific tool's pre-flight game state (ship
fuel, cargo, dock status) and should short-circuit before the real game call.
Follow `fuel-floor-guard.ts`'s shape: a pure function
`(v1ToolName, cachedStatus) => GuardError | null` that:
- only fires for the specific tool(s) it cares about,
- never blocks a docked ship (it can just fix the problem locally),
- never blocks on a stale cache (`GUARD_STALE_CEILING_MS` = 5 min — a frozen
  reading is worse than no guard, because it can itself cause the stranding
  it's meant to prevent),
- fails open (returns `null`, i.e. ALLOW) whenever the needed numbers are
  unknown.

Wire it into `handlePassthrough()` next to the existing guard calls (section
"0a" in that file), then log-and-return `textResult(guardResult)` through
`withInjections`.

## Injections — response-side additions

`injection-registry.ts` defines an `Injection` interface:

```ts
interface Injection {
  name: string; key: string; priority: number;
  enabled: (ctx: PipelineContext, agent: string) => boolean;
  gather: (ctx: PipelineContext, agent: string) => unknown; // null/undefined = skip
}
```

`InjectionRegistry.run()` executes all enabled injections in ascending
`priority` order and returns a `Map<key, value>` that `withInjections()`
merges into the JSON response body.

`docs/architecture.md` documents **7** built-in injections. The actual
registry (verified in `createDefaultInjections()`) has **12**: critical-events
(10), location-context (11), fleet-orders (20), battle-status (30),
instability-hint (40), threat-assessment (45), storage-warning (50),
cloak-advisory (60), poi-lore (62), directives (70), stale-strategy (75),
shutdown-warning (80). Two more are registered separately (not in the default
array) inside `createGantryServerV2()`: the override-system injection
(priority 5, via `createOverrideInjection(overrideRegistry)`) and the
state-hints injection (priority 65, via `createStateHintInjection`). Treat
the docs table as stale — read `injection-registry.ts` directly.

**To add a new injection**: either add an object literal to the array
returned by `createDefaultInjections()` (fires for both v1 and v2, since both
factories call it), or — if it needs a stateful registry that must persist
across sessions (like the override system) — construct it separately and
`injectionRegistry.register(yourInjection)` inside `createGantryServerV2()`
(and the v1 equivalent in `server.ts` if v1 needs it too). Pick a `priority`
that reflects urgency (single digits = safety-critical, 70s+ = passive
reminders) and a unique `key` — the registry stores results in a `Map`, so a
colliding key silently overwrites an earlier injection's value in iteration
order.

## v1 vs v2

- **v1** (`/mcp`, `server.ts` / `tool-registry.ts`): one flat MCP tool per
  game command (`mine`, `travel`, `sell`, ...), registered by
  `registerPassthroughTools()` iterating `TOOL_SCHEMAS` (typed) or
  `NO_PARAM_DESCRIPTIONS` (untyped) or falling back to the game's own
  description string.
- **v2** (`/mcp/v2`, `gantry-v2.ts`): agents call the game's own v2 tools
  directly (`spacemolt`, `spacemolt_market`, `spacemolt_battle`,
  `spacemolt_storage`, `spacemolt_salvage`, `spacemolt_ship`,
  `spacemolt_social`, `spacemolt_catalog`, `spacemolt_facility`). These are
  registered straight from `shared.v2Tools`/`shared.v2ToolSchemas` (the game
  server's own schema, with `withPrayerScriptSchema()` splicing in a few
  proxy-only params). `spacemolt_auth` is skipped entirely in that
  registration loop — login/logout are exposed as separate standalone proxy
  tools (`login`/`logout`) instead, and `register` is additionally blocked at
  the schema level via `DENIED_ACTIONS_V2`. There is **no v2→v1 mapping for
  the registered tools themselves** — v2 IS the native protocol on that side.
- **The mapping that exists** (`dispatch-v1-to-v2.ts`, `V1_TO_V2_DISPATCH`)
  runs the other direction: it's used by `executeForClient()` in
  `passthrough-handler.ts`, and also inside `HttpGameClientV2.execute()`
  itself (`http-game-client-v2.ts`) — so any `client.execute()` call with a
  v1-style name gets translated transparently, including calls made by
  routines/prayer scripts that still use v1 names. This is what makes code
  written against v1-style flat names (`client.execute("mine")`) still work
  correctly when the underlying transport is `HttpGameClientV2` — it
  translates to `client.execute("spacemolt", { action: "mine" })` (or the
  right namespace tool for battle/salvage/ship/storage actions) plus
  per-action param renames from `V2_TO_V1_PARAM_MAP`/`applyV2ArgAliases`.
  Compound tools instead branch on `client.isV2()` themselves and call the
  v2 tool name directly, bypassing this table (see `flee.ts`).
- Compound tools on v2 are NOT separately registered — they're reached via
  `spacemolt(action="batch_mine")` etc., matched against the same
  `compoundActions` dispatch table built by `buildCompoundActions()` in
  `tool-registry.ts` (see the `add-compound-tool` skill).

## Shared state

`createMcpServer()` in `mcp-factory.ts` assembles one `SharedState` object,
threaded into every module via DI (no proxy-layer singletons). Key maps you
will touch most:

- `shared.cache.status` (`Map<agentName, {data, fetchedAt}>`) — the
  single source of truth read/written throughout the pipeline; almost every
  guard and injection reads from here rather than making a fresh game call.
- `shared.cache.battle` (`Map<agentName, BattleState | null>`) — combat
  state, read by the `battle-status` injection and by `flee`/`scan_and_attack`.
- `shared.proxy.callTrackers`, `shared.proxy.gameHealthRef`,
  `shared.proxy.breakerRegistry`, `shared.proxy.serverMetrics`,
  `shared.proxy.transitThrottle`, `shared.proxy.transitStuckDetector`,
  `shared.proxy.navLoopDetector`, `shared.proxy.overrideRegistry` — per-agent
  and server-wide health/tracking state.
- `shared.fleet.galaxyGraphRef`, `.sellLog`, `.arbitrageAnalyzer`,
  `.marketReservations`, `.analyzeMarketCache` — fleet-wide coordination
  state, deliberately shared across v1/v2/test-mode factories so behavior
  persists regardless of which endpoint an agent hits.

## Config hot-reload snapshot gotcha (confirmed, still current)

`createGantryServerV2(config, shared, allowedTools)` closes over the `config`
parameter at server-construction time — every reference to `config.` inside
that closure (e.g. `OUR_AGENT_NAMES_V2`, most guard logic) sees a **frozen
snapshot**, even though `gantry.json` is hot-reloaded every 5 seconds
elsewhere in the app. If you need a value to reflect a live config edit
without a server restart, call `getConfig()` (from `../config.js`) at the
point of use instead of reading the closed-over `config`. The existing code
does this selectively — e.g. `handlePrayerAction()` calls
`const liveConfig = getConfig();` to check `agentConfig?.prayEnabled`, and the
`execute_routine` handler and the prayer `isToolDenied` callback do the same
for `routineMode` / `agentDeniedTools`. When adding new config-gated
behavior, default to `getConfig()` unless you have a specific reason to want
the frozen snapshot.

## Decontamination

`decontaminateLog()` (`pipeline.ts`) strips or redacts captain's-log entries
whose text matches any word/phrase in `CONTAMINATION_WORDS`
(`proxy-constants.ts`) — a curated list targeting hallucinated backend/
infrastructure narratives agents sometimes invent to explain unexpected game
behavior (categories: system/infra jargon, state/cache contamination,
navigation hallucination, speculative language, conspiracy framing,
temporal/infinite-failure framing). Entries in an `entries: [...]` array are
filtered out entirely; a single `entry` object/string is replaced with a
`[REDACTED — ...]` placeholder. This exists because agents that read a prior
hallucinated log entry tend to treat it as ground truth and compound the
error — decontamination breaks that feedback loop. If you're debugging an
agent that "knows" about a backend problem that never happened, check
whether an earlier log entry should have been caught here and wasn't (word
not in the list yet, or is in a field format `decontaminateLog` doesn't
recognize).

## STATE_CHANGING_TOOLS

`proxy-constants.ts`'s `STATE_CHANGING_TOOLS` set (v1 tool names — `mine`,
`travel`, `jump`, `dock`, `sell`, `buy`, `craft`, `attack`, ...) controls
whether `handlePassthrough()` performs a post-execution tick wait /
event-buffer poll before returning. Membership implies: the game's response
may not reflect final state yet, so the pipeline blocks briefly (via
`client.waitForTick()` or `waitForActionResult()` on the event buffer) and,
for nav tools, verifies the cache actually updated before trusting it. A
sibling set, `MUTATION_COMMANDS`, marks the subset where a timeout must
**never** be blindly retried because the original call may have already
succeeded (financial/combat/inventory actions) — check both sets when adding
a new state-changing game action so retry logic doesn't double-charge or
double-fire an attack.
