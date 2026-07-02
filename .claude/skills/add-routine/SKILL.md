---
name: add-routine
description: Use when adding, modifying, or debugging a deterministic game routine (a scripted multi-step sequence like sell_cycle or mining_loop executed without LLM inference per tick) — covers the RoutineDefinition shape, phase/handoff conventions, registration in ROUTINE_REGISTRY, how routines are triggered and persisted, and the test pattern to copy.
---

# Adding a Routine — Gantry Server

## 1. What a routine is

A routine is a scripted state machine that runs a full multi-step game sequence
(travel → dock → sell, or check-fleet → jump → verify-arrival) **without LLM
inference per step** — the whole sequence executes server-side and returns one
result. They cut cost by avoiding an LLM round-trip per game action.

**18 routines exist today** (`server/src/routines/routine-runner.ts`,
`BUILTIN_ROUTINES`): `sell_cycle`, `mining_loop`, `refuel_repair`,
`patrol_and_attack`, `mission_run`, `mission_check`, `navigate_and_mine`,
`craft_and_sell`, `explore_system`, `salvage_loop`, `full_trade_run`,
`supply_run`, `navigate_home`, `explore_and_mine`, `manage_storage`,
`upgrade_ship`, `fleet_refuel`, `fleet_jump`.

**Stale doc warning:** the `execute_routine` unknown-routine error message in
`server/src/proxy/gantry-v2.ts` (~line 830) hard-codes a 13-name list that is
missing `manage_storage`, `navigate_home`, `explore_and_mine`, `fleet_refuel`,
`fleet_jump`. Don't treat that error string as the source of truth — always
call `getAvailableRoutines()` (or read `BUILTIN_ROUTINES`) for the real list.
If you touch that error message while adding a routine, fix the list too.

**Canonical examples to copy:**
- Simple, single-destination: `server/src/routines/sell-cycle.ts` +
  `sell-cycle.test.ts` (14 tests) — travel/dock, market analysis, retry-on-
  `not_docked`, early-abort-on-no-demand.
- Fleet-coordination style (no travel/dock): `server/src/routines/fleet-jump.ts`
  — checks `spacemolt_fleet(action="status")`, hands off if members are
  scattered, jumps, re-verifies via a second fleet-status call.

## 2. Module shape

New file: `server/src/routines/<name>.ts`. Test: `server/src/routines/<name>.test.ts`
(co-located, `bun:test`). Every routine implements `RoutineDefinition<TParams>`
from `server/src/routines/types.ts`:

```typescript
export interface RoutineDefinition<TParams = Record<string, unknown>> {
  name: string;                    // e.g. "sell_cycle" — must match ROUTINE_REGISTRY key
  description: string;             // shown to agents
  parseParams(raw: unknown): TParams;   // validate + parse, throw Error on bad input
  run(ctx: RoutineContext, params: TParams): Promise<RoutineResult>;
}
```

`RoutineContext` (injected at execution time, from `types.ts`):
- `agentName: string`
- `client: RoutineToolClient` — `execute(tool, args?, opts?)` and
  `waitForTick(ms?)`. `tool` names are a mix: compound-action names (e.g.
  `"travel_to"`, `"batch_mine"`, `"multi_sell"`) are intercepted first and
  handled directly by compound-action handlers (`tool-registry.ts`) — they
  never reach `dispatch-v1-to-v2.ts`. Other v1 flat names (e.g.
  `"get_status"`, `"analyze_market"`, `"refuel"`) get translated to their v2
  namespaced call by `dispatchV1ToV2()` in `dispatch-v1-to-v2.ts` (invoked
  from `HttpGameClientV2.execute()` or `handlePassthrough()`). Names not
  found in `V1_TO_V2_DISPATCH` (e.g. `"spacemolt_fleet"`, used by
  `fleet-jump.ts`/`fleet-refuel.ts`) are presumed already v2-namespaced and
  passed straight through unmodified to the game server.
- `statusCache: Map<string, { data; fetchedAt }>` — per-agent cached game
  state, keyed by `agentName`; read `player` fields off `cached.data.player`.
- `log(level, msg, data?)` — routed to `createLogger("routine-dispatch")`.

`RoutineResult` (from `types.ts`):
```typescript
{
  status: "completed" | "handoff" | "error";
  summary: string;             // human-readable, shown to the LLM
  data: Record<string, unknown>;
  handoffReason?: string;      // required when status === "handoff"
  phases: RoutinePhase[];
  durationMs: number;          // filled in by the runner, not the routine
}
```

## 3. Step / phase / error conventions

Use the shared helpers in `server/src/routines/routine-utils.ts` — don't
hand-roll these:

- `phase(name)` / `completePhase(p, result?)` — build the `RoutinePhase[]`
  audit trail every routine accumulates and returns.
- `done(summary, data, phases)` — returns a `status: "completed"` result.
- `handoff(reason, data, phases)` — returns `status: "handoff"` with
  `handoffReason` set to `reason`. **Handoff, not throw, is the normal
  failure path** — a routine should almost never throw; it hands off so the
  LLM agent can take over. (An uncaught throw is still handled by
  `runRoutine()`'s try/catch and converted to `status: "error"`, but that's
  the fallback, not the design.)
- `withRetry(fn, maxAttempts = 3, backoffMs = 2000)` — linear backoff retry
  wrapper for a single tool call.
- `travelAndDock(ctx, destination, opts)` — shared travel+dock sequence used
  by `sell_cycle`, `craft_and_sell`, `salvage_loop`, `navigate_home`. Handles
  `already_docked` as success, returns `{ phases, failed? }`.
- `checkCombat(result)` — inspect a tool result for `battle_started` /
  `combat_detected` so a routine can hand off instead of continuing into a
  fight it can't handle (see `fleet-jump.ts`'s post-jump check).
- Response-shape parsing helpers: `parseCargoItems`, `extractDemandItems`,
  `extractMissionList`, `getTradeMissionCost`, `getStatPct`,
  `getCargoUtilization` — the game API returns inconsistent field names
  across endpoints/versions; these normalize known variants defensively.
  Reuse them instead of writing a new one-off parser.

**Dispatch-level safety nets you get for free** (`routine-dispatch.ts`,
`dispatchRoutine()` — do not duplicate this in your routine): every
`ctx.client.execute()` call is intercepted — aborted before it reaches the
game if `battleCache` shows combat started or the agent's event buffer has a
dangerous event (`pirate_warning`, `combat_update`, `player_died`,
`police_warning`, `scan_detected`), and re-checked after the call returns
too. A `"completed"` result that raced with one of those events gets
converted to `"handoff"` post-hoc. Sub-tool calls are logged to the
dashboard as `routine:<name>:<tool>`.

## 4. Registration — three places, all in `routine-runner.ts`

1. Import your routine and add it to the `BUILTIN_ROUTINES` array (single
   source of truth — both `registerAll()` and the test reset iterate it):
   ```typescript
   import { myRoutine } from "./my-routine.js";
   const BUILTIN_ROUTINES: RoutineDefinition<any>[] = [
     sellCycleRoutine, /* … */, fleetJumpRoutine,
     myRoutine,
   ];
   ```
2. Add an entry to `ROUTINE_TOOLS` (same file) listing every v1 tool name
   your routine calls via `ctx.client.execute()`. This is used for a
   **pre-flight deny check** in `gantry-v2.ts`: `execute_routine` is rejected
   before it starts if any listed tool is in the agent's (or global) denied
   tools. **`routine-runner.test.ts`'s `"has entries for all registered
   routines"` test enforces this — a routine registered without a
   `ROUTINE_TOOLS` entry fails CI.**
3. (Optional but recommended) add a `PARAM_EXAMPLES` entry — a one-line
   `execute_routine(id="...", text='{"...":"..."}')` example shown to the
   agent when `parseParams` throws.

Routine name (`routine.name`) is the `ROUTINE_REGISTRY` map key — set it via
`ROUTINE_REGISTRY.set(routine.name, routine)` in `registerAll()`; make sure
the string you export matches exactly what you put in `BUILTIN_ROUTINES` and
`ROUTINE_TOOLS`.

## 5. How routines are triggered

Three entry points, all converging on `runRoutine()`:

- **Agent-initiated (primary path):** the agent calls
  `spacemolt(action="execute_routine", id="<name>", text='{"...json params..."}')`.
  Handled in `gantry-v2.ts` (~line 822): validates the routine exists,
  checks `routineMode` is enabled for the agent (`agents[].routineMode: boolean`
  in `gantry.json`, schema in `server/src/config/schemas.ts` — **not currently
  documented in `server/docs/CONFIG.md`**), rejects if in active combat or a
  dangerous event is pending, runs the `ROUTINE_TOOLS` pre-flight deny check,
  then calls `dispatchRoutine()`. Supports `async: true` to start in the
  background and return immediately (poll via `action="get_routine_status"`).
- **Text-directive interception:** if an agent's free-text output contains
  `ROUTINE:<name>\n{...json...}` at the start of a line (whitelisted against
  known routine names — see `parseRoutineDirective()` /
  `hasRoutineDirective()` in `routine-dispatch.ts`), the pipeline intercepts
  it and dispatches the routine instead of passing the text through.
- **Operator-initiated:** `POST /api/agents/:name/routine` (registered in
  `server/src/web/routes/fleet-control.ts`) validates the routine name against
  `hasRoutine()` and enqueues an urgent fleet order
  (`[OPERATOR] Execute routine: <name>\nParams: <json>`) for the agent to pick
  up — this does **not** call `runRoutine()` directly, it relies on the agent
  seeing the order and issuing `execute_routine` itself.
- **Dashboard:** `server/src/app/routines/page.tsx` is a **read-only monitor**
  (status cards + filterable job-history table), not a trigger UI — polls
  `GET /api/routines/jobs` and `/api/routines/jobs/:id`. `GET /api/routines`
  returns the bare name list for `hasRoutine`/UI dropdowns.

## 6. Persistence & status reporting

`server/src/services/routine-jobs.ts` is the job-tracking layer used by both
sync and async `execute_routine` paths in `gantry-v2.ts`. `createRoutineJob`
inserts a `running` row (in-memory `Map` + `routine_jobs` SQLite table);
`completeRoutineJob`/`failRoutineJob` update status and persist the finish;
`getLatestRoutineJobForAgent`/`getRoutineJob`/`listRoutineJobs` back
`GET /api/routines/jobs[/:id]` and `spacemolt(action="get_routine_status")`.
On server start, `loadRecentRoutineJobs()` marks any still-`running` row as
`error` (`"abandoned: server restart"`) — a job can't survive a process
restart. In-memory map caps at `MAX_ROUTINE_JOBS = 200` (oldest pruned by
`startedAt`); SQLite keeps full history. You don't touch this file when
adding a routine — it's generic over `routineId`, wired automatically.

## 7. Testing

Copy `server/src/routines/sell-cycle.test.ts`'s structure:
1. `mockContext(toolHandler, cacheData?)` helper building a `RoutineContext`
   with a fake `client.execute` and pre-seeded `statusCache`.
2. `describe("parseParams")` — valid input, missing required field, wrong
   type, optional-field parsing.
3. `describe("run")` — one test per branch: happy path, each `handoff`
   trigger, retry/recovery behavior (e.g. sell-cycle's `not_docked` re-dock
   test), empty/edge-case inputs. Assert on `result.status`,
   `result.summary`, `result.handoffReason`, `result.data`, and — where call
   order matters (e.g. dock must follow travel) — assert on the recorded
   `toolsCalled` array, not just the final result.
4. Also extend `server/src/routines/routine-runner.test.ts`'s
   `getRoutineTools` "has entries for all registered routines" coverage is
   automatic (it iterates `getAvailableRoutines()`) — no per-routine edit
   needed there, it just needs your `ROUTINE_TOOLS` entry to exist (see §4).

Run targeted (from `server/`): `bun test src/routines/<name>.test.ts`.

## 8. Validation checklist

1. `routine.name` matches the key you register it under and the string in
   `ROUTINE_TOOLS`.
2. `BUILTIN_ROUTINES` includes the new routine (routine-runner.ts).
3. `ROUTINE_TOOLS` has an entry listing every v1 tool name the routine calls.
4. `parseParams` throws a clear `Error` (not returns null/undefined) on bad
   input — the runner surfaces the message + any `PARAM_EXAMPLES` hint to the
   agent.
5. Every return path uses `done()` or `handoff()` (never a bare object
   literal) so `status`/`durationMs` stay consistent.
6. New/changed file has a co-located `*.test.ts` covering happy path + every
   handoff branch.
7. `bun test src/routines/<name>.test.ts` passes (run from `server/`).
8. `bun test src/routines/routine-runner.test.ts` passes (registry +
   `ROUTINE_TOOLS` coverage tests).
9. `bun run build:server` succeeds (from `server/`).
10. If the routine is meant to be player-triggerable via text directive,
    confirm the name is lowercase snake_case with no regex-special
    characters — it becomes part of `buildSentinelPattern()`'s alternation.
