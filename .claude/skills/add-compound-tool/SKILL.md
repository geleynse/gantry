---
name: add-compound-tool
description: Use when adding a new compound tool (a multi-step game sequence like batch_mine/travel_to/flee), when asked to make N raw game calls into one proxy-side tool call, or when extending server/src/proxy/compound-tools/.
---

# Adding a Compound Tool — Gantry Proxy

Compound tools orchestrate several game-server calls (with tick waits, retries,
verification) behind one MCP tool call. They never talk to the game server
directly — they call `client.execute(...)` the same way `handlePassthrough`
does, just in a loop.

**Reality check on existing docs:** `CONTRIBUTING.md` and `docs/compound-tools.md`
both say the canonical implementation lives in `compound-tools-impl.ts`. That
file is now a 34-line re-export shim for backward compatibility — the real
code is one file per tool under `server/src/proxy/compound-tools/`. Use this
skill, not those two docs, for the mechanics.

## File layout

```
server/src/proxy/compound-tools/
├── types.ts            # CompoundToolDeps, CompoundResult, GameClientLike
├── utils.ts             # stripPendingFields, waitForNavCacheUpdate, findTargets, isAmmoItem, ...
├── descriptions.ts       # COMPOUND_TOOL_DESCRIPTIONS + COMPOUND_TOOL_NAMES (test-only; dashboard has its own copy, see step 5)
├── index.ts              # barrel — re-exports every tool + types + utils
├── batch-mine.ts          # simplest example — copy this for a straight loop-with-early-exit tool
├── flee.ts                # good example of branching / edge-case handling (phantom-battle detection)
└── <name>.ts              # your new tool
```

Create `server/src/proxy/compound-tools/<name>.ts`. One file per tool, named
after the tool (`snake_case` tool name → `kebab-case` filename, e.g.
`scan_and_attack` → `scan-and-attack.ts`).

## The `*Deps` pattern

Every compound tool takes `CompoundToolDeps` (defined in `compound-tools/types.ts`)
as its first argument — never import shared state directly:

```ts
export interface CompoundToolDeps {
  client: GameClientLike;                    // execute/waitForTick/isV2/...
  agentName: string;
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  battleCache: Map<string, BattleStateForCache | null>;
  sellLog: SellLog;
  galaxyGraph: GalaxyGraph;
  persistBattleState: (agentName: string, state: BattleStateForCache | null) => void;
  upsertNote: (agentName: string, type: string, content: string) => void;
  eventBuffers?: Map<string, { events?: Array<{ type: string }> }>;
}
```

Your function signature: `export async function myTool(deps: CompoundToolDeps, ...args): Promise<CompoundResult>`
where `CompoundResult = Record<string, unknown>` (opaque, JSON-encoded for the agent).

`GameClientLike.execute(tool, args?, opts?)` returns `{ result?, error? }` —
never throws for game errors, only for real transport failures. `client.isV2()`
tells you whether to dispatch v1 flat names (`"mine"`) or v2 namespaced calls
(`client.execute("spacemolt", { action: "mine" })`, or `"spacemolt_battle"` /
`"spacemolt_salvage"` / etc. for non-default namespaces — see the mapping in
`dispatch-v1-to-v2.ts`'s `V1_TO_V2_DISPATCH` table for which v1 name maps to
which v2 `{tool, action}` pair). Every existing tool branches on `isV2` at the
top and keeps two call sites for the same logical action — see `flee.ts` for
the pattern.

## Schema / parameters — `TOOL_SCHEMAS` isn't where compound tools register params

`TOOL_SCHEMAS` in `tool-registry.ts` is mainly for raw passthrough game
tools (`travel`, `jump`, `craft`, ...) — it's consumed by
`registerPassthroughTools()`'s loop over the live game's `gameTools` list,
and by `checkSchemaDrift()` (`mcp-factory.ts`'s `OUR_SCHEMA_PARAMS`) to catch
param-name drift against the real game server. Two compound tools
(`get_craft_profitability`, `craft_path_to`) do have `TOOL_SCHEMAS` entries,
but those entries are inert leftovers — never hit by the passthrough loop
(the tool isn't in the live game's tool list) or by drift-checking (they're
not in `OUR_SCHEMA_PARAMS`). Don't add a `TOOL_SCHEMAS` entry for a new
compound tool; params live in two separate places that must stay in sync:

- **v1 (flat tool)**: inline Zod schema in the `mcpServer.registerTool(...)`
  call inside `registerCompoundTools()` in `tool-registry.ts` (e.g.
  `batch_mine`'s `count: z.number().int().min(1).max(50)`).
- **v2 (action-dispatch)**: no new schema needed. v2 agents call
  `spacemolt(action="<name>", ...)`, and the `spacemolt` tool's Zod schema has
  a bare-string `action` field with no enum (see the comment in
  `withPrayerScriptSchema()` in `gantry-v2.ts`), so any action name validates.
  Your tool receives whatever generic params the caller sent (`id`, `text`,
  `count`, `destination`, `items`, `stance`, `target`, `system_ids`, ...) —
  extract them yourself, same as the existing dispatch table does.

## Registration — 4 places, all required

1. **Implement** `compound-tools/<name>.ts` exporting your function.
2. **Barrel-export** it from `compound-tools/index.ts`:
   ```ts
   export { myTool } from "./my-tool.js";
   ```
3. **Wire the dispatch table** — add a case to `buildCompoundActions()` in
   `tool-registry.ts` (the function is shared by both v1 and v2; this one
   addition is what makes the tool reachable via
   `spacemolt(action="<name>")` on v2 — no separate v2 registration exists):
   ```ts
   my_tool: async (client, agentName, args) => {
     const someArg = String(args.id ?? args.destination ?? "");
     return myTool(makeDeps(client, agentName), someArg);
   },
   ```
4. **Register the v1 flat tool** — add an `mcpServer.registerTool("my_tool", {...}, handler)`
   block in `registerCompoundTools()` (same file), following the `batch_mine`
   or `flee` block: look up `agentName` via `getAgentForSession`, run
   `checkGuardrails`, look up the game `client`, optionally check
   `checkAutoTriggerInterrupt` (only for tools that should yield to an
   in-flight combat auto-trigger — `batch_mine`/`travel_to`/`jump_route`
   do this, `multi_sell`/`flee`/`battle_readiness` don't), then call the
   `runCompound(...)` helper (handles `logToolCallStart`/`logToolCallComplete`
   + `withInjections` wrapping) or replicate it inline if you need custom
   post-processing (see `travel_to`'s block for nav-loop-detector injection).
   Finish with `registeredTools.push("my_tool")`.
5. **Add a description** to `COMPOUND_TOOL_DESCRIPTIONS` in
   `compound-tools/descriptions.ts` for consistency/tests (`descriptions.test.ts`
   checks it), but be aware this constant has **no runtime consumer outside its
   own test** — it is barrel-exported from `index.ts` but nothing else imports
   it. It does **not** back the dashboard's tool-call feed. `components/tool-call-feed.tsx`
   keeps its own independent, hand-maintained `COMPOUND_TOOL_DESCRIPTIONS` copy
   (comment there: "mirrors server-side descriptions") that is already out of
   sync — missing `get_craft_profitability`/`craft_path_to`/`passenger_run`, and
   listing a `pray` entry the server-side file doesn't have. If you want your
   new tool to show a human description in the activity feed, edit
   `tool-call-feed.tsx`'s `COMPOUND_TOOL_DESCRIPTIONS` directly — editing
   `compound-tools/descriptions.ts` alone will not do it.

`docs/compound-tools.md`'s "Extending Compound Tools" section lists 4 steps:
implement in `compound-tools-impl.ts` (stale — see the reality-check callout
above), register in `tool-registry.ts`, add the tool to the schema in
`server/src/proxy/schema.ts`, and add tests in `compound-tools-impl.test.ts`.
That test file still exists (2300+ lines, still runs), but it only covers the
original 8 tools that predate the per-file split — the shim never exported
`getCraftProfitability`/`craftPathTo`/`passengerRun`, so it's not where a new
tool's tests belong; use the per-tool `<name>.test.ts` convention from the
Testing section below instead. The doc also never mentions the barrel export
or the `descriptions.ts` entry. Do all 5 steps above regardless of what that
doc says.

## Tick-wait / error-recovery conventions

- **Pending results**: if a raw call returns `{ pending: true, ... }`, call
  `await client.waitForTick()` then `stripPendingFields(result)` (import from
  `./utils.js`) before using the result.
- **Shutdown signal**: long-running loops (mining N times, jumping N systems)
  must check `getSessionShutdownManager().isShuttingDown(agentName)` each
  iteration and break early with a `stopped_reason` — see `batchMine`'s loop.
- **First-call failure vs partial completion**: if the very first game call
  errors and you have zero partial results, return `{ error: resp.error }` at
  the top level (no `status` field). If you have partial results already,
  set `status: "completed"` (or a tool-specific terminal status) plus
  `stopped_reason` and `last_error` instead of surfacing a bare error — the
  agent already got some value out of the call.
- **Depletion / cooldown vs real errors**: classify known "stop cleanly, not
  an error" codes (e.g. `belt_depleted`, `no_ore`, `nothing_to_mine`) before
  falling through to the generic error path — see `batchMine`'s
  `isDepletion` check. Explicit-zero-yield results (not an error, but
  `amount: 0` three times running) are also a depletion signal; an empty
  `{}` result is ambiguous and should NOT be treated as depletion.
- **Battle/combat tools**: check `battleCache`/`get_battle_status` state
  before acting, and handle the "server says not_in_battle but a dock/undock
  probe returns `in_combat`" phantom-state case if your tool touches combat —
  see `flee.ts`'s phantom-battle detection for the pattern (probe with
  `noRetry: true`, write an `upsertNote` breadcrumb, tell the agent to
  `logout`/`login` to resync).

## Result formatting conventions

`CompoundResult` is a plain object, JSON-encoded by the caller. Common fields
across existing tools (use what applies, skip the rest):

- `status`: `"completed"` | `"partial"` | `"error"` | tool-specific terminal
  states (`"victory"`/`"defeat"`/`"timeout"` for combat, `"escaped"` for
  flee, `"not_in_battle"`/`"phantom_in_battle"` for flee's edge cases).
- `stopped_reason`: present only when the sequence stopped before completing
  its full request (`"cargo_full"`, `"depleted"`, `"error"`,
  `"shutdown_signal"`, `"low_fuel"`, `"cooldown"`).
- `last_error`: the raw game error object when a mid-sequence call failed.
- State snapshots agents need next: `cargo_after`, `location_after`,
  `credits_after`.
- Never throw — catch internally and return an `error` field. The v2
  dispatcher in `gantry-v2.ts` does wrap compound-action calls in a
  try/catch as a last resort, but that path returns a generic message and
  loses tool-specific context.

## Testing

Every PR needs the happy path **plus at least two error cases**
(CONTRIBUTING.md's stated bar — verified, still current). Copy the test
harness from `compound-tools/batch-mine.test.ts`:

```ts
import { createDatabase, closeDb } from "../../services/database.js";
import { resetSessionShutdownManager } from "../session-shutdown.js";
import { myTool } from "./my-tool.js";
import type { CompoundToolDeps, GameClientLike } from "./types.js";
import { SellLog } from "../sell-log.js";
import { GalaxyGraph } from "../pathfinder.js";

function makeClient(overrides: Partial<{ execute: GameClientLike["execute"]; waitForTick: GameClientLike["waitForTick"] }> = {}): GameClientLike {
  return {
    execute: overrides.execute ?? (async () => ({ result: { ok: true } })),
    waitForTick: overrides.waitForTick ?? (async () => {}),
    lastArrivalTick: null,
  };
}

function makeDeps(agentName: string, client: GameClientLike, statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>): CompoundToolDeps {
  return {
    client, agentName, statusCache,
    battleCache: new Map(), sellLog: new SellLog(), galaxyGraph: new GalaxyGraph(),
    persistBattleState: () => {}, upsertNote: () => {},
  };
}
```

`beforeEach`: `createDatabase(":memory:")` + `resetSessionShutdownManager()`
if your tool checks the shutdown signal. `afterEach`: `closeDb()`.

For branching/edge-case logic (bugs that are hard to trigger live), see
`flee.test.ts` — it drives the phantom-battle branch entirely through a
mocked `execute()` that returns specific error codes per tool name.

Add exact-match tests to `<name>.test.ts` next to your implementation.
`compound-tools/descriptions.test.ts` asserts a fixed list of tool names is
present in `COMPOUND_TOOL_NAMES` — it currently does NOT require every tool
(it's a subset check), so you don't have to touch it, but keep it in mind if
you're asked to make that list exhaustive later.

## Verification checklist before opening a PR

```bash
cd server
bun run build:server                              # esbuild — catches type errors fast
bun test src/proxy/compound-tools/<name>.test.ts   # your new tests
bun test src/proxy/compound-tools/                 # whole directory — nothing else broke
bun test                                            # full suite before PR (~4200 tests)
```

`bun run build:server` and the targeted test command above were run against
this repo while writing this skill and both pass cleanly — use them as the
fast inner loop; run the full `bun test` before opening the PR per
CONTRIBUTING.md.
