---
name: prayerlang
description: Use when extending, debugging, or reviewing PrayerLang — the bounded DSL agents submit via the spacemolt_pray MCP tool — including adding a new statement/command or predicate, tracing a failed/interrupted prayer call, or reconciling docs/prayer.md against the actual parser/analyzer/executor.
---

# PrayerLang

PrayerLang is a tiny DSL that lets a fleet agent submit one bounded,
deterministic script to the server instead of driving a mining/trading loop
turn-by-turn — one `spacemolt_pray` MCP call replaces N LLM turns. The runtime
parses, statically analyzes (arity, denied tools, fuzzy item/POI resolution),
then executes server-side against the agent's cached game state, dispatching
real game tool calls as it goes. Inspired by
[prayer.rs](https://github.com/MatthewBlanchard/prayer.rs); Gantry's version
is a from-scratch TypeScript reimplementation for the SpaceMolt tool surface.

## Where it lives

All in `server/src/proxy/prayer/`, each file with a co-located `*.test.ts`:

| File | Role |
|---|---|
| `parser.ts` | Lexer + recursive-descent parser. `parsePrayerScript(source) → AstProgram`; `formatPrayerProgram()` is the canonical pretty-printer used for `normalized_script`. |
| `analyzer.ts` | Static pass: resolves command/predicate specs, checks arity, fuzzy-matches item/POI identifiers (Levenshtein), checks `agentDeniedTools`. `analyzePrayerProgram(ast, snapshot) → AnalyzedProgram`. |
| `executor.ts` | Runs the analyzed program statement-by-statement; owns step/loop/wall-clock limits and mid-script interrupt checks. `executePrayerProgram(program, deps) → PrayResult`. |
| `commands.ts` | `COMMANDS` registry (one `CommandSpec` per statement keyword) + `UNSUPPORTED_COMMANDS` deny-list. |
| `predicates.ts` | `evalPredicate()` + `computeMetric()` — the `if`/`until` condition evaluator. |
| `state.ts` | Pure readers over the cached status blob (`getCargo`, `cargoPct`, `homeDestination`, ...) — every predicate/command reads through these, never `data.foo` directly. |
| `checkpoint.ts` | Serialize/persist/resume `ExecState` across server restarts. |
| `result.ts` | Builds the final `PrayResult`: diff snapshot + tiered error shape. |
| `index.ts` | `runPrayerScript(script, deps)` — public entry point: parse → analyze → execute, catching errors from any stage into `resultFromError`. |
| `types.ts` | All shared types: AST, `CommandSpec`, `PredicateName`, `ExecState`, `PrayResult`, the three error classes. |

Wired into `server/src/proxy/gantry-v2.ts`: `handlePrayerAction()` (~line 479)
builds `ExecutorDeps` and calls `runPrayerScript`; `spacemolt_pray` registers
~line 638. It also gates on `agentConfig.prayEnabled === true`, rejects during
active combat/buffered dangerous events, applies a `Promise.race` timeout
(`timeout_ticks × 30s`), and loads/saves the checkpoint.

## Language surface — READ docs/prayer.md, but verify against tests first

`docs/prayer.md` is the best conceptual starting point but **is stale in
several concrete ways** (see Doc mismatches below). Treat `parser.test.ts`,
`analyzer.test.ts`, `executor.test.ts` as source of truth for exact syntax and
the current command/predicate set — don't restate the grammar here, read
`parser.ts` for the formal shape. Current surface, as of this writing:

**Statements:** `;`-separated (trailing `;` optional on the final statement),
`if <pred> { ... }`, `until <pred> { ... }`, `//` comments.

**Predicates require parens, even with zero args** — `FUEL() < 20`,
`CARGO_PCT() >= 90`, `CARGO(iron_ore) > 0`, `MISSION_ACTIVE() == 0`,
`STASH(sol_station, iron_ore) >= 50`. Metrics (`PREDICATE_ARG_TYPES` in
`analyzer.ts`): `FUEL`, `CREDITS`, `CARGO_PCT`, `MISSION_ACTIVE` (0 args);
`CARGO(item)`, `MINED(item)`, `STASHED(item)` (1 arg); `STASH(poi, item)`
(2 args).

**Commands** (`COMMANDS` in `commands.ts`): `halt`, `wait [ticks]`,
`mine [item]`, `go <dest>` (in-system only), `jump <system>` (cross-system,
`jump_route`), `dock`, `undock`, `refuel`, `repair`, `sell [item]`,
`stash [item] [qty]`, `survey`, `retrieve <item> [qty]`, `buy <item> <qty>`,
`accept_mission <id>`. `UNSUPPORTED_COMMANDS` is an explicit deny-list
(`self_destruct`, `jettison`, `sell_ship`, `craft`, etc.) — the analyzer
throws `PrayerAnalyzeError` on use. `craft` is deliberately blocked pending
`RECIPE_AVAILABLE`/`CRAFT_PROFITABLE` predicates (comment in `commands.ts`) —
don't remove it from the deny-list without adding those guards.

**Macros:** `$here` (resolves at analysis time, needs a known current system),
`$home`, `$nearest_station` (resolve at execution time from the live status
cache — `resolveArg` in `predicates.ts`).

**Bounding:** `max_steps` caps executed statements; `timeout_ticks` caps
game-tick span; `until` loops also cap at `maxLoopIters` (hardcoded `200` in
`gantry-v2.ts`, throws `loop_limit_exceeded`). Defaults live in
`handlePrayerAction`, not the prayer module: `max_steps` defaults to `50` if
the script contains `"until"` else `100` (clamped `[1, 500]`); `timeout_ticks`
defaults to `40` (clamped `[1, 120]`).

## Game-state access

Scripts never make a live status call. Predicates and command arg-mappers read
`deps.statusCache: Map<agentName, {data, fetchedAt}>` — the same cache the
rest of the proxy fills from normal tool traffic — via `state.ts`'s pure
readers. If a predicate needs data not yet cached (`STASHED` needs
`personal_storage`, `MISSION_ACTIVE` needs `active_missions`), it degrades to
`0` rather than fetching — the script must call the populating tool
(`view_storage`, `get_active_missions`) first. See the fallback field-name
priority on `totalStashed`/`activeMissionCount` in `predicates.ts`.

## Error / fail-closed semantics

Three error tiers, each its own exception class in `types.ts`:
`PrayerParseError` (`"parse"`, lex/syntax, has `line`/`col`);
`PrayerAnalyzeError` (`"analyze"` — unknown command/predicate, wrong arity,
denied backing tool, unresolvable identifier; carries `suggestions`,
Levenshtein nearest-name matches); `PrayerRuntimeError` (`"runtime"`, has a
`code` — `step_limit_reached`, `loop_limit_exceeded`, `wall_clock_exceeded`,
`interrupted`, `tool_fatal`, `status_unavailable`, `home_not_set`,
`no_station_in_system`, `denied_at_execute`, etc; `skip_`-prefixed codes are
swallowed as a no-op step, not a failure). `result.ts::resultFromError` maps
any thrown error into `PrayResult.error: { tier, code?, message, line?, col?,
suggestions? }` — `step_limit_reached`/`interrupted` get their own top-level
`status` instead of `"error"` (the latter also sets `handoff_reason`).

Fail-closed at three layers: `gantry-v2.ts` refuses to start during active
combat or a buffered dangerous event (`INTERRUPT_EVENTS` in `executor.ts`:
`pirate_warning`, `combat_update`, `player_died`, `police_warning`,
`scan_detected`, ...); the analyzer refuses unknown/denied/unsupported
commands pre-execution; the executor re-checks interrupts/limits at every
statement boundary (`checkLimits`/`checkInterrupts`), so a clean-starting
script can still be cut off mid-run.

Sub-tool results are classified by `classifyResult()` into `ok`/`skip`/
`transient`/`fatal`. `transient` (rate-limited/busy/pending) retries up to 3
times per call, 20 total per script, one tick between attempts, before
escalating to `tool_fatal`.

## Checkpoint / resume

`checkpoint.ts` lets a running prayer survive a Gantry restart. `gantry-v2.ts`
wires `onCheckpoint: (state) => saveCheckpoint(agentName, state)` (written
after every step) and loads `loadCheckpoint(agentName)` as `initialState` at
the start of `handlePrayerAction`. Storage:
`$FLEET_DIR/data/prayer-state/<agentName>.json` (atomic write). Cleared only
on `status === "completed"` — other terminal statuses leave it for the next
call to resume. `executePrayerProgram` resets `startedAt = Date.now()` on
resume so a stale checkpoint doesn't instantly blow the wall-clock budget
(see "resume from stale checkpoint" in `checkpoint.test.ts`).

## Observability & the canary route

Every prayer call is logged via `logToolCallStart`/`logToolCallComplete` with
`tool_name = 'pray'`; sub-tool dispatches are logged with `parent_id` pointing
at the parent row (`logSubTool` in `handlePrayerAction`). Reads live in
`server/src/web/routes/prayer.ts`: `GET /api/prayer/recent?agent=&limit=`
(rows + subcalls joined), `GET /api/prayer/by-id/:id`, `GET
/api/prayer/adoption?hours=` (per-agent prayer/turn ratio, avg steps, success
rate). Read the **dual status vocabulary** comment in `prayer.ts` first:
`row.status` (`'pending'|'complete'|'error'`, DB column) vs. `result.status`
(`'completed'|'halted'|...`, `PrayResult` JSON) — different spellings on
purpose, don't normalize them.

`server/src/web/routes/prayer-canary.ts` — `POST /api/prayer-canary { agent }`
— starts the named agent with a hardcoded one-shot system prompt
(`PRAYER_CANARY_SYSTEM_PROMPT` in `agent-manager.ts`) forcing it to call
`spacemolt_pray(script="wait 1;", max_steps=1, timeout_ticks=2)` then log out.
Backed by `startAgentCanary()` — rejects if already running, but (unlike a
normal start) bypasses the fleet-disabled guard.

## Extending the language

**New command:** add a `CommandSpec` to `COMMANDS` in `commands.ts` — `name`,
`backingTool` (real MCP tool for deny-list checks, `null` for native-only like
`halt`/`wait`), `arity: [min, max]`, `argTypes`
(`"item"|"destination"|"integer"|"any"`), `dispatcher`: `"native"`
(hand-written, see `stash`/`retrieve`), `"compound"` (compound-tools action,
see `mine`/`go`/`jump`/`sell`), or `"passthrough"` (plain MCP tool, see
`dock`/`buy`/`accept_mission`). No analyzer changes needed — arity/argTypes
validate generically; only touch `analyzer.ts` for a new `ArgType`.
Permanently-blocked commands go in `UNSUPPORTED_COMMANDS`, not `COMMANDS`.
Tests: **`executor.test.ts` is the strongest reference** — see the
`buy`/`retrieve`/`accept_mission`/`survey` tests (mock
`compoundActions`/`handlePassthrough`, assert dispatched tool + args +
`result.status`); add arity coverage to `analyzer.test.ts` for non-trivial args.

**New predicate:** add the name to the `PredicateName` union in `types.ts`,
its arg types to `PREDICATE_ARG_TYPES` in `analyzer.ts`, and a `case` in
`computeMetric()` (`predicates.ts`). Reuse `state.ts` helpers where one
exists; for a new field-fallback shape, write a local helper following
`totalStashed`/`stashAtPoi`/`activeMissionCount` and document the fallback
priority in a comment. Tests: `predicates.test.ts`'s `STASHED`/`STASH`/
`MISSION_ACTIVE` blocks show expected coverage (happy path,
absent-item-returns-0, uncached-data-returns-0, legacy field-name aliases).

Either way, update `docs/prayer.md`'s command/predicate table — it currently
only covers 11 of 15 commands and is missing 3 of 8 predicates.

## Debugging a failing prayer

1. Pull the row: `GET /api/prayer/recent?agent=<name>&limit=5` (or
   `proxy_tool_calls WHERE tool_name = 'pray'`). `result_summary` has the full
   `PrayResult` — check `status`, `error.tier`/`code`, `error.line`/`col`,
   `error.suggestions`. `status: "interrupted"` → check `handoff_reason` (the
   exact `INTERRUPT_EVENTS` name, e.g. `combat_started`, `pirate_warning`).
2. Subcalls (real tool dispatches) hang off the row via `parent_id` — the
   API's `subcalls` array, or `... WHERE parent_id = <prayer_row_id>`.
3. Server logs: `handlePrayerAction` logs `pray START`/`pray <status> <ms>ms`/
   `pray CRASH` (grep `[agentName] pray`); `prayer-executor`'s logger warns
   with the last 5 subtool calls specifically on wall-clock exceeded.
4. `error.tier === "analyze"` usually means a bad identifier or denied tool —
   check `error.suggestions` first; check `agentDeniedTools` (agent + `"*"`
   global) for `denied_at_execute`. Nothing logged at all → confirm
   `prayEnabled: true` for the agent.
5. Use the prayer canary (`POST /api/prayer-canary`) to isolate "prayer
   routing broken for this agent" from "this specific script is broken."

## Validation checklist for language changes

- `bun test server/src/proxy/prayer/` (parser/analyzer/executor/predicates/
  checkpoint) + `bun test server/src/web/routes/prayer.test.ts`, both green.
- Changed the command/predicate set or default `max_steps`/`timeout_ticks`?
  Update `docs/prayer.md` — it does not self-update.
- New `backingTool` commands: confirm they respect `agentDeniedTools` (`"*"`
  global + per-agent) and, if mining/exploration-flavored, the cargo
  saturation block wired through `isToolDenied` in `gantry-v2.ts`.
- Destructive/irreversible actions belong in `UNSUPPORTED_COMMANDS`, not
  `COMMANDS` — don't rely on prompt discipline alone.

## Doc mismatches (fix opportunistically, don't assume intentional)

- `docs/prayer.md`'s predicate examples (`CARGO_PCT >= 90`) omit the required
  parens — real grammar is `METRIC(args) op int`, always parenthesized.
- Its predicate table is missing `STASHED`/`STASH`/`MISSION_ACTIVE`; command
  table is missing `survey`/`retrieve`/`buy`/`accept_mission`.
- It lists defaults `max_steps: 25`, `timeout_ticks: 8`; actual (set in
  `gantry-v2.ts::handlePrayerAction`) are `50`/`100` and `40`.
- No mention of checkpoint/resume — a real, tested behavior.
- `docs/PLAN-prayer-ui.md` tracks shipped code closely and doesn't name a
  per-id detail endpoint at all — the stale reference is actually the doc
  comment directly above the route in `server/src/web/routes/prayer.ts`
  (`GET /api/prayer/:id`); the route it decorates is registered as
  `.../by-id/:id`.
