# Recycling Facility Re-evaluation Plan
**Date:** 2026-05-30
**Context:** v0.327.0 Recycling Processor facilities + v0.332.0 maintenance-free facilities

---

## Background

Two recent patch clusters change the facility calculus for Drifter Gale:

**v0.327.0 / v0.327.1 — Recycling Processor**
- New facility: Recycling Processor Mk I / II / III.
- Action: `spacemolt_facility(action="configure_recycler", facility_id=..., recipe_id=...)`.
- Mechanic: runs a recipe **in reverse** — consumes the finished good and recovers its inputs.
- v0.327.1 restricted reversibility: power/fuel cells, armor, hull, sensors, weapons are
  NOT reversible. Only some recipes (likely commodity intermediates, bio items, crafted
  modules without weapon/defense classification) are reversible.
- Primary use: recover materials from surplus stockpiles instead of selling at depressed prices.

**v0.332.0 — Maintenance-free facilities**
- Facilities NO LONGER consume maintenance inputs each tick.
- Previously Mk II / Mk III facilities had net-negative economics due to maintenance drain.
- Now the only cost-of-ownership is the build credit spend. Revenue is purely a function
  of output volume × market price.
- Impact: tiers that Gale previously declined on ROI grounds may now be clearly profitable.

---

## Part 1: Engineering — Surfacing configure_recycler

### 1.1 Current State

`configure_recycler` is NOT in any of the following proxy tables:
- `V1_TO_V2_DISPATCH` (`dispatch-v1-to-v2.ts`) — the flat v1 passthrough table
- `STATE_CHANGING_TOOLS` / `MUTATION_COMMANDS` (`proxy-constants.ts`)
- `TOOL_SCHEMAS` / `NO_PARAM_DESCRIPTIONS` (`tool-registry.ts`)
- `V2_TO_V1_PARAM_MAP` (`schema.ts`) — facility actions section only covers
  `faction_list`, `faction_build`, `personal_build`, `types`, `upgrades`
- `DENIED_TOOLS` (`schema.ts`) — not blocked; it just doesn't exist in these lists

It is also not in `DENIED_ACTIONS_V2`. Gale operates on the v2 endpoint (`mcpPreset=full`),
so `spacemolt_facility` is registered as a passthrough tool. Any action Gale calls on
`spacemolt_facility` that isn't in compound actions or the proxy intercept list falls through
to `handlePassthrough` → `executeForClient` → game server via `v2ToolHint="spacemolt_facility"`.

**Conclusion:** If the game server exposes `configure_recycler` as an action on
`spacemolt_facility`, it ALREADY passes through transparently today. The schema cache
(read by `resolveGameToolsV2`) will include it in the tool's action enum if the server
lists it. The only risk is the Zod schema built from `serverSchemaToZod` not having
`configure_recycler` listed in the action enum, causing the MCP client to reject the call
client-side before it reaches the proxy.

### 1.2 Verification Step (do first)

Before writing any code, check what the game server currently advertises:

```bash
# Invalidate schema cache and force a fresh fetch on next proxy restart:
rm "$FLEET_DIR/data/schema-cache.json"
# After proxy restarts, tail the log for:
#   "Loaded N v2 tools (preset=full)"
# Then inspect the schema-cache.json and check spacemolt_facility.inputSchema.properties.action.enum
cat "$FLEET_DIR/data/schema-cache.json" | bun -e "
  const c = JSON.parse(await Bun.stdin.text());
  const tool = c.v2?.full?.serverTools?.find(t => t.name === 'spacemolt_facility');
  console.log(JSON.stringify(tool?.inputSchema?.properties?.action?.enum, null, 2));
"
```

If `configure_recycler` appears in the enum: the passthrough already works, and the only
work is (a) add it to the prompt and (b) add `V2_TO_V1_PARAM_MAP` entries.

If it does NOT appear: the game hasn't published it yet, or we're on a stale cache from
before v0.327. Force a cache refresh and recheck.

### 1.3 Engineering Changes

#### File 1: `server/src/proxy/proxy-constants.ts`

Add `configure_recycler` to `STATE_CHANGING_TOOLS` (it writes a recipe config to a facility)
and to `MUTATION_COMMANDS` (changing the recipe is a non-idempotent financial decision).

```typescript
// In STATE_CHANGING_TOOLS:
"install_mod", "uninstall_mod", "faction_build", "faction_upgrade", "personal_build",
"configure_recycler",   // ← add

// In MUTATION_COMMANDS:
"faction_build", "faction_upgrade", "personal_build",
"configure_recycler",   // ← add
```

**Rationale:** `configure_recycler` consumes the finished good during recycling. Running it
twice on the same facility_id would consume twice the stock. It belongs in MUTATION_COMMANDS.

#### File 2: `server/src/proxy/schema.ts` — `V2_TO_V1_PARAM_MAP`

Add param remaps for `configure_recycler` in the `spacemolt_facility` actions section:

```typescript
// spacemolt_facility actions
faction_list: {},
faction_build: {},
personal_build: {},
types: { category: "category" },
upgrades: {},
configure_recycler: { id: "facility_id", text: "recipe_id" },   // ← add
```

**Rationale:** v2 agents use generic params (`id`, `text`); `configure_recycler` takes
`facility_id` and `recipe_id`. This follows the same pattern as `faction_upgrade`
(`id: "facility_id", text: "facility_type"`).

**Note:** `V2_TO_V1_PARAM_MAP` is used only for v1-client remapping. For v2 clients, the
`v2ToolHint` path in `executeForClient` sends args verbatim to the game server's
`spacemolt_facility` endpoint with `action: "configure_recycler"`. The map entry documents
intent and enables future v1 compat if needed.

#### File 3: `server/src/proxy/tool-registry.ts` — `TOOL_SCHEMAS`

No change needed. `configure_recycler` is called via `spacemolt_facility(action="configure_recycler", ...)`,
not as a standalone v1 tool. The `TOOL_SCHEMAS` table is for v1 passthrough tools; v2 agents
use `spacemolt_facility` whose schema comes from the game server via `serverSchemaToZod`.

#### File 4: `server/src/proxy/summarizers.ts`

Verify the summarizer for `spacemolt_facility` / `configure_recycler` response.
The `discoverPick` pattern in summarizers logs unknown fields — run a real configure_recycler
call and check the logs for `[discovery] New field in configure_recycler:` lines. If the
game returns `recovered_items`, `recovered_quantities`, `credits_saved`, or similar, add
a summarizer entry for `configure_recycler` so the full result reaches the agent:

```typescript
// In summarizers.ts, add an entry if needed (inspect real response first):
configure_recycler: (result: unknown) => {
  // Return verbatim — recycler output is always small and all fields matter to the agent.
  return result;
},
```

**Default behavior:** If no summarizer is registered for the action name, `summarizeToolResult`
passes through verbatim. So unless the response is huge, no change is needed here.

#### File 5: `server/src/app/facilities/page.tsx` and `web/routes/facilities.ts`

No changes required. These routes pull from the status cache (populated by `faction_list`
and `personal_build` calls) and the recycler configuration state comes back in the facility
record's `production` or `configuration` field, which `normaliseFacility` already preserves
via the `production` field passthrough.

If the game response for `configure_recycler` updates the facility's visible state on next
`faction_list`, no proxy changes are needed — the facilities page will pick it up from the
refreshed cache.

### 1.4 Tests (bun test)

#### Test 1: `proxy-constants.ts` — `configure_recycler` in STATE_CHANGING_TOOLS

File: `server/src/proxy/__tests__/smoke.test.ts` or a new
`server/src/proxy/proxy-constants.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { STATE_CHANGING_TOOLS, MUTATION_COMMANDS } from "../proxy-constants.js";

describe("configure_recycler tool classification", () => {
  test("configure_recycler is in STATE_CHANGING_TOOLS", () => {
    expect(STATE_CHANGING_TOOLS.has("configure_recycler")).toBe(true);
  });

  test("configure_recycler is in MUTATION_COMMANDS", () => {
    expect(MUTATION_COMMANDS.has("configure_recycler")).toBe(true);
  });
});
```

#### Test 2: `schema.ts` — V2_TO_V1_PARAM_MAP entry

Add to `server/src/proxy/schema.test.ts` (or `schema-drift.test.ts`):

```typescript
import { V2_TO_V1_PARAM_MAP } from "../schema.js";

test("configure_recycler param map: id→facility_id, text→recipe_id", () => {
  const m = V2_TO_V1_PARAM_MAP["configure_recycler"];
  expect(m).toBeDefined();
  expect(m.id).toBe("facility_id");
  expect(m.text).toBe("recipe_id");
});
```

#### Test 3: passthrough dispatch for spacemolt_facility configure_recycler

In `server/src/proxy/passthrough-handler.test.ts` or integration test,
verify that `executeForClient` for a v2 client with `v2ToolHint="spacemolt_facility"`
and action `"configure_recycler"` routes the call correctly (does not attempt
v1 dispatch, does not crash).

---

## Part 2: Strategy — Facility Roster + Tier Re-evaluation

### 2.1 The Maintenance Flip (v0.332)

Before v0.332, Mk II and Mk III facilities consumed maintenance items each tick.
The economic model was: `net_profit = output_value - maintenance_cost - amortized_build_cost`.
For higher-tier facilities, maintenance was a recurring tax that pushed many tiers to
net-negative or break-even at best.

After v0.332: `net_profit = output_value - amortized_build_cost`.
Maintenance is gone. Every tier that produces sellable goods is now profitable given
sufficient time to amortize the build cost.

### 2.2 Audit Framework for Drifter Gale's Facility Roster

#### Step 1: Pull Current Facility State

Gale calls:
```
spacemolt_facility(action="faction_list")
spacemolt_facility(action="personal_build")
spacemolt_facility(action="upgrades")
```

For each facility in the roster, record:
- `facility_id`, `facility_type`, current tier (Mk I / II / III)
- `status` (active/toggled), `production` (output item, rate)
- Location (system + station) — matters for market access
- Available upgrade path from `upgrades` response

Write to strategy doc with the current snapshot.

#### Step 2: Re-rank Tiers by Net Output Value

For each facility type currently owned or buildable:

1. **Query output item market price** via `analyze_market` or `get_global_market` for the
   output item.
2. **Calculate output rate × price** = gross revenue per tick at current tier.
3. **Estimate amortization** = build cost / expected facility lifetime in ticks. The game
   tracks build cost in the facility record; lifetime is open-ended, so use a 30-day
   horizon (≈ 2,592,000 ticks if 1 tick = 1 sec) for conservatism.
4. **Net value per tick** = (output rate × price) - (build cost / 2592000).
5. **Compare across tiers**: If Mk II or Mk III upgrade cost is low relative to the output
   increase, the upgrade ROI is now favorable without the maintenance tax.

Facilities to re-evaluate first (highest impact from maintenance removal):
- **Faction Lockbox** (storage facility — no output to sell, but caps scaling) — evaluate
  whether the higher-tier storage capacity is worth the build cost at current faction storage
  volume. Check `spacemolt_storage(action="view", target="faction")` fill rates.
- **Production facilities with high-value outputs** — items selling above 10k/unit warrant
  immediate Mk II / Mk III eval.
- **Any facility that was toggled OFF** — if Gale toggled a facility off because of
  maintenance drain, re-enable it (`spacemolt_facility(action="faction_toggle", facility_id=...)`).

#### Step 3: Identify Surplus Stockpiles for Recycler Recovery

The recycler reverses a recipe: finished good → inputs. This is useful when:
- The fleet has surplus of a finished item that is selling at a loss.
- The inputs for that recipe sell for more than the finished good.
- The item is NOT in the blocked list (weapons, armor, hull, sensors, power/fuel cells).

**Candidate items to check** (pull from faction storage and cargo):
- Crafted intermediate commodities (steel alloys, bio compounds, processed minerals).
- Items the fleet over-crafted for missions that are now stale.
- Items where the market has more sellers than buyers (`view_market` shows low bid depth).

**Check procedure:**
1. `spacemolt_storage(action="view", target="faction")` — identify surplus (anything at
   storage cap or quantities > 1000 units that haven't moved in 3+ sessions).
2. For each candidate: `query_catalog(type="recipe", search="<item_id>")` — find the
   reverse recipe and its input materials.
3. Check if inputs sell for more than the finished good via `get_global_market` or
   `analyze_market`.
4. If inputs are worth more: route to Recycling Processor, call
   `spacemolt_facility(action="configure_recycler", facility_id=<recycler_id>, recipe_id=<recipe_id>)`.

**Which recipes are reversible (not blocked by v0.327.1):**
- The game's blocked list covers: power cells, fuel cells, armor plating, hull plating,
  sensors, weapons, and similar military-grade items.
- Safe candidates: trade commodities (bio goods, processed ores, luxury items), crafted
  modules that are NOT weapons/defense/sensors.
- When in doubt: attempt the configure_recycler call; the game will return an error for
  blocked recipes.

#### Step 4: Power Budget Check Before New Builds (v0.332 guidance already in prompt)

Gale's prompt already contains: "check `get_base` power picture before building a new
facility — insufficient power budget silently throttles output."

No prompt change needed here. But the strategy doc should record the current power
supply/draw ratio at each QTCG base, so Gale doesn't have to re-query every session.

### 2.3 Concrete Re-evaluation Procedure

**Per-session procedure for Gale (add to strategy doc, not the main prompt):**

```
FACILITY REVIEW (do after faction_list):
1. For any facility with status="inactive" or toggled-off: re-enable if output item
   has a current market bid > 0.
2. For any Mk I facility: if upgrade cost < 500k AND output value/tick > 2k, upgrade.
3. For any facility output bin at cap: withdraw to cargo, deposit to faction storage
   or multi_sell.
4. If faction storage has items with quantity > 2000 that are NOT moving: check if
   recyclable. If recycler exists and recipe is reversible: configure_recycler.
5. After any new faction_build: verify power draw in get_base response doesn't exceed supply.
```

### 2.4 Drifter Gale Prompt Updates

#### In `drifter-gale.txt` — Facility Management section (item 2f/2g area)

Add after the existing `⚠️ POWER MODEL (v0.332)` note (line 59):

```
   h. ⚠️ RECYCLING PROCESSOR (v0.327): If a Recycling Processor facility exists in the
      faction roster, use it to recover value from surplus stockpiles.
      Syntax: spacemolt_facility(action="configure_recycler", facility_id="<id>", recipe_id="<recipe_id>")
      Step 1: Check faction storage for surplus finished goods (quantity > 1000, not selling).
      Step 2: Find the recipe via query_catalog(type="recipe", search="<item_name>").
      Step 3: Verify inputs sell for more than the finished good via get_global_market.
      Step 4: Call configure_recycler. The game will reject blocked recipes (weapons, armor,
              sensors, power/fuel cells) — try a different recipe if you get an error.
      Priority: clear surplus bins first, then reconfigure for the highest-margin recovery.
```

Also add to the `spacemolt_facility action enum` comment block (line 117-122 area):

```
    configure_recycler (facility_id=..., recipe_id=...) — configure a Recycling Processor
      to reverse a recipe and recover input materials from finished goods (v0.327+).
```

---

## Part 3: Definition of Done + Verification Checklist

### Engineering

- [ ] `configure_recycler` added to `STATE_CHANGING_TOOLS` in `proxy-constants.ts`
- [ ] `configure_recycler` added to `MUTATION_COMMANDS` in `proxy-constants.ts`
- [ ] `configure_recycler: { id: "facility_id", text: "recipe_id" }` added to `V2_TO_V1_PARAM_MAP` in `schema.ts`
- [ ] Schema cache cleared and proxy restarted; verify game server exposes `configure_recycler` in `spacemolt_facility` action enum
- [ ] `bun test` passes with new proxy-constants and schema tests
- [ ] No schema drift warnings for `configure_recycler` in proxy startup log

### Strategy

- [ ] Gale has run `spacemolt_facility(action="faction_list")` in a live session and the result is captured in strategy doc
- [ ] Gale's strategy doc lists each owned facility with current tier, output item, and post-v0.332 revenue estimate
- [ ] Any facility that was toggled off pre-v0.332 is reviewed; if output item has market demand > 0, re-enabled
- [ ] Faction storage surveyed for recyclable surplus; top 3 candidates identified with input/output price comparison
- [ ] Power budget verified at each QTCG base after any new builds
- [ ] If a Recycling Processor exists: `configure_recycler` tested with at least one reversible recipe in a live session; result logged in strategy doc

### Prompt

- [ ] `configure_recycler` syntax added to Gale's facility action enum comment block
- [ ] Recycling Processor usage guidance added to Gale's facility management section
- [ ] Tier re-evaluation guidance updated (tiers that were net-negative pre-v0.332 should now be treated as profitable)

---

## Implementation Order

1. Verify schema cache shows `configure_recycler` in game server's action enum (no code needed if missing — just a data question).
2. Add `configure_recycler` to `STATE_CHANGING_TOOLS` + `MUTATION_COMMANDS` + `V2_TO_V1_PARAM_MAP`.
3. Write and run tests.
4. Update Gale's prompt in `spacemolt/fleet-agents/drifter-gale.txt`.
5. Clear schema cache, restart proxy, have Gale run a live facility scan session.
6. In that session: capture current roster, identify upgrade candidates, check recycler availability.
7. Update Gale's strategy doc with the audit results.

---

## Files Touched (Summary)

| File | Change |
|------|--------|
| `server/src/proxy/proxy-constants.ts` | Add `configure_recycler` to STATE_CHANGING_TOOLS + MUTATION_COMMANDS |
| `server/src/proxy/schema.ts` | Add `configure_recycler` param map in V2_TO_V1_PARAM_MAP |
| `server/src/proxy/summarizers.ts` | Inspect real response; add summarizer only if response is bloated |
| `server/src/proxy/proxy-constants.test.ts` (new or extend) | Test STATE_CHANGING + MUTATION membership |
| `server/src/proxy/schema.test.ts` | Test V2_TO_V1_PARAM_MAP entry |
| `spacemolt/fleet-agents/drifter-gale.txt` | Add configure_recycler syntax + recycler usage guidance + tier re-eval note |
