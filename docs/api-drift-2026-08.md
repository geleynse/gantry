# API drift report — game v0.552.0 (2026-08-04)

Gantry was last swept against the game API on 2026-07-01 (the "v0.417.3 sweep"). Since then the
game has shipped **404 releases**, reaching **v0.552.0** on 2026-08-01. This document records what
drifted, what is confirmed broken, and what is unclaimed.

## How this was measured

- Changelog: `GET https://game.spacemolt.com/api/changelog` (public, paginated), 404 releases in the
  window v0.369.1 .. v0.552.0.
- Live command surface: `GET https://game.spacemolt.com/api/openapi.json` —
  `info.x-gameserver-version: v0.552.0`, **215 operations**, 639 schemas.
- Compared against `V1_PROXIED_TOOLS` / `INTENTIONALLY_SKIPPED` in
  `server/src/proxy/schema-drift.test.ts`, read from `origin/main`.

| | count |
|---|---|
| Live game operations | 215 |
| `V1_PROXIED_TOOLS` | 106 |
| `INTENTIONALLY_SKIPPED` | 96 |
| Known to gantry | 202 |
| Proxied but **gone from the live spec** | **2** |
| Live but unclassified | 36 (29 genuinely unreferenced) |

All findings below were verified against `origin/main`, not a feature branch.

---

## P0 — Confirmed broken

### 1. `craft` is a silent permanent no-op in two routines

The live `/craft` endpoint takes `recipe_id` (string) and `quantity` (**integer**); `count` is an
**integer** alias for `quantity`. There is no `recipe` parameter.

Both call sites send the wrong parameter name and the wrong type:

- `server/src/routines/craft-and-sell.ts:108` — `{ recipe, count: "ALL" }`
- `server/src/routines/full-trade-run.ts:169` — `{ count: "ALL" }`

This fails for two independent reasons. `"ALL"` is a non-numeric string against an integer field —
the lenient coercion added in v0.341.8 handles `"5"` but not `"ALL"`. And since v0.335.0 the server
hard-rejects unrecognized parameters with `invalid_payload`, which `recipe` now is.

The failure is invisible because both routines treat any craft error as "no materials" and continue
(`craft-and-sell.ts:111-114` logs at debug level and moves on).

It is masked in tests: `craft-and-sell.test.ts:59` mocks `craft` unconditionally without asserting
the payload. `server/src/proxy/mock-game-client.test.ts:455` already uses the correct
`{ recipe_id, quantity: 3 }` — the mock layer knows the right shape, the production routines do not.

**Fix:** rename `recipe` → `recipe_id`; resolve `"ALL"` to an integer quantity (an ALL-resolver
already exists for multi_sell at `multi-sell.ts:145,163-164`); make the craft mock assert payload
shape so this cannot regress silently.

### 2. Two removed commands are still advertised to agents

| command | removed in | still referenced at |
|---|---|---|
| `sell_ship` | v0.508.0 | `tool-registry.ts:444`, `schema.ts:495,593`, `proxy-constants.ts:25,52`, `server.ts:85` |
| `claim_commission` | v0.376.0 | `proxy-constants.ts:25`, `schema.ts:496,596`, `server.ts:86`, `schema-drift.test.ts:38` |

`sell_ship` is the more serious of the two: `tool-registry.ts:444` gives agents a description
("Sell your current ship") for a command the game will hard-reject. Its replacement,
`sell_ship_to_order`, has no implementation in gantry.

`claim_commission` is not fleet-breaking — ships auto-deliver — but it is misleading surface.

Related: `salvage_wreck` was removed in v0.449.0. `api-drift-monitor.ts:84-86` excludes it from
alerts, but `schema.ts:504`, `proxy-constants.ts:24,46` and `dispatch-v1-to-v2.ts:97` still map it.

### 3. `waitForTick()` does not wait, so tick-paced loops are not tick-paced

`HttpGameClientV2.waitForTick()` (`http-game-client-v2.ts:863-866`) calls `refreshStatus()` and
returns. `refreshStatus()` issues two parallel HTTP calls and does not sleep. `waitForTickToReach()`
(`:882-885`) likewise refreshes and returns `true` unconditionally. There is no per-command throttle
either — the only sleep in the client is `awaitSessionCreateSlot()`, which spaces *session creation*,
not commands.

`HttpGameClientV2` is the production client (the only other implementation is `MockGameClient`), so
every loop that treats `await client.waitForTick()` as "let a game tick pass" is really just doing a
status refresh. Game ticks are on the order of ten seconds; a poll is a round-trip. A loop budgeted
for N ticks can therefore burn its entire budget inside a single tick and report a timeout for
something that was always going to take several ticks.

**Blast radius: 22 files** under `server/src/proxy/compound-tools/` and `server/src/routines/`,
including `scan-and-attack.ts` (4 uses), `flee.ts` (4), `multi-sell.ts` (3), `batch-mine.ts`,
`mining-loop.ts`, `patrol-and-attack.ts`, `fleet-jump.ts`, `upgrade-ship.ts`, and the shared
`compound-tools/utils.ts` (16).

This is invisible in tests because the suites stub `waitForTick` as a no-op and advance mock state on
every status call — so the mock supplies the time progression the real client never does.

Note the interaction with the game's own behaviour: since v0.341.1 the server holds `travel`/`jump`
requests open until arrival, so *actions* are effectively synchronous. The gap is specifically in
**polling loops** that expect time to elapse between reads.

Decide deliberately whether the fix is a real tick wait, a tick-boundary poll against the server's
tick counter, or removing the abstraction and making each loop state its own pacing. Do not fix it
per-tool — the value is in one correct implementation.

### 4. The drift test has two coverage holes

Both dead commands sit in `V1_PROXIED_TOOLS` rather than `INTENTIONALLY_SKIPPED`, so the test
designed to catch exactly this never fired — it only runs against a live game connection and skips
gracefully otherwise. A removal is therefore invisible in normal CI.

Separately, the passenger commands `list_station_passengers`, `load_passenger`, `list_passengers`
and `unload_passenger` are **used** by `compound-tools/passenger-run.ts` but appear in neither
classification list. If the game removed one, the drift test would not notice.

**Fix:** make the drift test fail loudly (not skip) when it cannot reach the game, and add the
passenger commands to `V1_PROXIED_TOOLS`.

### 5. CI does not gate on tests at all

`.github/workflows/ci.yml:31` sets `continue-on-error: true` on the test step, with the comment
"Known cross-file test pollution — all tests pass individually". The observation is accurate — the
failures below do each pass in isolation — but the consequence is that **no test failure has ever
failed a build**. Only `bun install` and `bun run build` gate CI.

This makes the drift-test enforcement above effectively local-only: the test can now fail loudly and
CI will still go green.

Blanket `continue-on-error` hides every genuine regression. Note this repo has ~5,400 tests
currently gating nothing.

**Correction (2026-08-05).** The original diagnosis in this section was wrong in three specific
ways, and the corrected version is what the fix was built on. Recording both so the mistake is not
re-derived from this document.

- **"Known cross-file test pollution — all tests pass individually" is false**, both here and in the
  `ci.yml:31` comment it quotes. `agent-manager > staggers agent starts` fails roughly 1 run in 15
  in a *fresh, fully isolated* process. It was never pollution: the test set a 10 ms base stagger
  and asserted `expect(elapsed).toBeGreaterThanOrEqual(45)` against a nominal total of 50 ms, so a
  ~10% timer undershoot failed it. That is a wall-clock lower bound, and no amount of isolation
  fixes it.
- **`__tests__/agent-lifecycle.test.ts > requestShutdown emits a __system_event record` does not
  fail in a full run.** It never failed across 8 full runs. It should not have been listed.
- **There is no concurrent run.** `server/bunfig.toml` sets `maxConcurrency = 1`, so the live-sync
  failures cannot have been "self-inflicted rate limiting under a 292-file concurrent run". The
  actual cause is `globalThis.fetch` leaking out of `game-registration.test.ts` and
  `leaderboard-cache.test.ts`, which assign it without restoring the original.

**What was measured, and why the fix is process isolation rather than deleting one flag.** The
suite is nondeterministic enough that **3 of 5 clean full runs go red, with a different failing set
each time**. Simply removing `continue-on-error` would therefore have produced roughly 60%
false-red CI, which is worse than no gate: a gate people learn to ignore teaches that red means
nothing. So the runner executes each test file in its own bun process
(`server/scripts/run-tests-isolated.sh`), which removes the cross-file family outright, and the two
genuinely timing-bound tests were rewritten to assert the delay the scheduler *requests* rather
than elapsed wall-clock.

**Why the runner verifies its own discovery.** A floor on the file count is not sufficient. The
first version of the runner discovered test files with `find src -name '*.test.ts' -o -name
'*.test.tsx'`, which silently missed `src/components/__tests__/add_agent_test.tsx` — a real file
with 5 real tests that `bun test` runs and the gate did not. Bun treats
`<name><. or _><test or spec>.<js|jsx|ts|tsx|mjs|cjs|mts|cts>` as a test file, case-insensitively;
the original glob matched two of those sixteen forms. A gate that reports "ran 291 files, 0 failed"
while omitting real tests is the same failure class as `continue-on-error`, just harder to notice.
The runner now derives the answer from bun itself on every run: it builds a fixture tree of
matching and non-matching names, runs `bun test` over it, and fails if its own discovery disagrees.

**Second correction (2026-08-05), after review.** Two more claims above were wrong, and both were
wrong in the same direction — a number was asserted from a comment rather than measured.

- **`staggers agent starts` was flaky by construction, not by narrow margin.** The first fix raised
  its base stagger from 10 ms to 50 ms and kept the wall-clock form, on the stated reasoning that
  the nominal total was 250 ms (one heavy×heavy pair at 100 ms plus three at 50 ms) against a
  `>= 200` floor, leaving 50 ms of slack. That arithmetic came from a comment naming `drifter-gale`
  as a sonnet agent. It is **haiku** (`agent-manager.test.ts:11`), and `testConfig` has no two
  consecutive heavy models at all, so every one of the four waits is the base delay and the nominal
  total is **exactly 200 ms**. The assertion sat on the boundary, where timers under-firing by 1-2 ms
  each fail it — which is precisely the 1-in-15 rate observed. There was never any slack to widen.
  The test now records the delays the scheduler *requests*, like its two siblings, and asserts the
  full ordered timeline of launches and waits. Dropping the `await` on the sleep, halving the base
  delay, and deleting the sleep were each confirmed to turn it red.
- **The quarantine's `<file>::` prefix was decorative on the exclusion side.** One negative-lookahead
  PCRE was built from every quarantined *name* and passed to all 292 files, so an entry naming a
  generic test name would have disabled that test suite-wide while re-running it in one file — the
  same silent-coverage-loss shape as the discovery bug above. Measured: with an entry naming only
  `add_agent_test.tsx`, the old repo-wide filter took an unrelated file from 14 tests to 11. The
  filter is now built per file, and `verify_quarantine_partition()` enforces
  `gated + quarantined == total` for every quarantined file (today `17 = 12 + 5`) plus liveness of
  each individual entry, so the property is checked rather than observed.

Also added, all for the same reason — the gate must not be able to report success over less than it
claims: a guard that fails if any test file exists outside the `src/` walk root, a per-file
zero-tests check (`bun test` on a file with no tests exits 0, measured on bun 1.3.9), a floor on the
total test count as well as the file count, and a non-zero exit when a file skips its integration
coverage because localhost could not be bound.

---

## P1 — Behavioural drift worth fixing

- **Facility maintenance semantics flipped (v0.550.0).** The quantities listed for a facility are now
  the **stock it must keep on hand**, not per-cycle consumption, and upkeep burns roughly ten times
  slower. NPC demand for upkeep goods — fuel cells, hydrogen, deuterium, water ice, rations, salvage
  — has dropped substantially and the changelog states this is intended. Trade routines that treat
  those goods as reliable sell targets are now working a much thinner market.
- **Damaged facilities (v0.551.1).** `facility action=faction_list` now reports
  `status: "damaged"` plus a `damaged` flag, and only `active` facilities produce. Any filter on
  `status == "active"` silently changed meaning. Repair via `facility action=repair`.
- **Per-stronghold pirate reputation (v0.548.0).** The single `pirates` standing is replaced by nine
  per-crew entries. Our `StandingsSchema` is a `z.record(...)` and the dashboard panel iterates
  `Object.entries`, so this passes through cleanly — but the changelog explicitly warns that the
  pirate tables in `get_nearby`/`get_state` gained a `crew` column and that anything parsing those
  tables **by column position rather than by header** must be updated. Worth an audit of our
  positional table parsing. (Test fixtures still reference the dead `pirates` key; cosmetic.)
- **`flee` ignores the escape mechanics added in v0.414.0.** `flee.ts` uses a fixed 5-tick timeout
  and never reads `can_escape`, `being_pinned` or `effective_speed`, so a pinned or slow ship gets a
  generic timeout with no diagnostic.
- **Craft/facility "free reads" still cost a tick.** v0.433.0 and v0.441.10 made `craft dry_run` and
  bare queue reads instant, but `craft` is unconditionally in `STATE_CHANGING_TOOLS`
  (`proxy-constants.ts:19-32`), so the pipeline still awaits a full tick.
- **`game-catalog.ts` never fetches facilities or modules**, and still uses three legacy endpoints
  rather than the unified `/api/catalog.json` added in v0.412.0.
- **`structuredContent`** (v0.460.0, v0.472.1) is still unimplemented; gantry continues to scrape
  text and JSON.
- **Stale error-hint text patterns.** v0.467.1 changed error wording from "base" to "station"; the
  text patterns `"not at a base"` and `"not a base"` in `error-hints.ts` will go dark. The
  code-based `no_base` and `dock_verification_failed` patterns still fire, so impact is limited.

---

## P2 — Unclaimed game systems

29 live commands are referenced nowhere in gantry. They cluster into whole features the fleet simply
cannot use:

- **Freight / shipping** (v0.517–0.549) — `shipping`. Designed by the game as steady work at every
  experience level. Probably the highest-value addition available.
- **Packages** (v0.511–0.543) — sealed-container crafting, packing and transport.
- **Wildlife hunting and ranching** (v0.452–0.456, v0.525, v0.528) — `hunt`.
- **Station and faction economics** — `build_base`, `build_outpost`, `dismantle_outpost`,
  `get_base_cost`, `espionage`, `prepay_tax`, `faction_prepay_tax`, `get_faction_tax_estimate`,
  plus life support, citizen fund, dining and resident population. Note v0.489.0: stations no longer
  auto-buy fuel by default.
- **Ship buy-order book and licensing** — `place_ship_buy_order`, `view_ship_buy_orders`,
  `cancel_ship_buy_order`, `buy_ship_license`, `sell_ship_to_order`.
- **Battle intelligence** — `get_battle_summary`, `get_battle_log`. As of v0.552.0 summaries carry
  `has_station` and the public battle list accepts `station=true`, making station raids findable.
- **Market push** — `subscribe_market` / `unsubscribe_market` and incremental `view_market(since=)`.
  Gantry built its own per-station tracker instead, so this is a deliberate trade-off rather than an
  oversight, but it forfeits the bandwidth win.
- Also unused: `get_achievements`, `faction_scan_poi`, `recycle`, `inspect`, notification
  mute/unmute, `login_link` / `login_link_poll`.

Cheap wins in this list: `inspect` (v0.507.0) can collapse several lookups into one call, and
`?panels=off` (v0.545.0) would cut outbound payload since gantry re-summarizes everything anyway.

---

## What held up well

Worth recording, because it shows which designs survive drift:

- **Flag-driven feature detection.** The empire tax system churned through v0.404.0 → v0.408.0 →
  v0.417.0 and was then rolled back in v0.417.2. Gantry absorbed all of it for free because
  `empire-info-cache.ts:23,46` reads the live `tax_collection_active` flag instead of hardcoding a
  version assumption, and `tax-monitor.ts:20-44` alerts on the transition. This is the pattern to
  copy elsewhere.
- **Additive passthrough.** `discoverPick()` (`summarizers.ts:20-44`) copies every response field
  through and only logs unexpected ones, so the large majority of new fields across 404 releases
  reached agents with no code change at all.
- **Dynamic schema resolution.** `schema.ts` fetches the live tool/action schema hourly and builds
  validators from it rather than hardcoding an allowlist, which is why most new actions are
  reachable by passthrough today.

The failures above are concentrated in **static lists** and **hand-written parameter literals** —
exactly the places that dynamic resolution does not cover.

One more pattern, from the review of this work rather than the drift itself: **three separate bugs
were held in place by fixtures shaped around them.** The craft mock accepted any payload, so wrong
parameter names passed. The flee tests mocked a `status` field the server cannot send, so a dead
code path looked covered. The tick-wait loops stub `waitForTick` as a no-op and advance state on
every read, supplying the time progression the real client never provides. In each case the suite was
green and the behaviour was wrong. When a test mocks a value, check that the real system can actually
produce it.

---

## Suggested order of work

1. Fix the `craft` parameters and add a payload-asserting mock (P0.1).
2. Remove `sell_ship` and `claim_commission` from the static lists; drop the `salvage_wreck` mapping
   (P0.2).
3. Make the drift test fail rather than skip when it cannot reach the game; classify the passenger
   commands (P0.3).
4. Decide what `waitForTick()` should mean and implement it once (P0.3). Until then, no loop can
   honestly claim tick-based pacing, and `scan-and-attack`'s battle loop is affected as much as
   `flee`'s.
5. Fix `scan-and-attack.ts` reading `.status`/`.zone`/`.stance`/`.hull`/`.shields`/`.target` off
   `get_battle_status` — none of those fields exist on the response. The battle cache that feeds the
   dashboard is therefore writing constants (`hull: -1`, `zone: "unknown"`, `status: "active"`), and
   the victory/ended check compares an empty string, so it never matches and every battle loop runs
   to `MAX_BATTLE_TICKS`. Same defect class as the flee gate, in the primary combat tool.
6. Audit positional table parsing against the v0.548.0 `crew` column. *(Done 2026-08-04 — no
   production parser reads those tables by position; pirate and facility data is consumed as JSON.)*
7. Handle `status: "damaged"` in facility filtering. *(Done 2026-08-04.)*
8. Decide whether to claim freight/shipping — the largest single opportunity in the window.
