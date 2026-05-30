# Tax & Citizenship Bundle — Implementation Plan

**Date:** 2026-05-30  
**Status:** PLAN ONLY — no code modified  
**Game versions covered:** v0.291 / v0.298 / v0.305 / v0.307 / v0.310 (preview to live)

---

## Context

SpaceMolt is rolling out a tax/citizenship economy in stages:

- **v0.291/v0.298** — `spacemolt_citizenship` preset tool (get_citizenship, apply_citizenship, renounce_citizenship). All empires **CLOSED** to applications. Tax is **PREVIEW**: `get_tax_estimate` returns live data, but `tax_collection_active = false`.
- **v0.305** — `get_tax_estimate` gains `taxable_income_by_source` (mission/market/salvage/ship_sale/rescue) plus progressive bracket schedules.
- **v0.307** — Property tax preview: `get_property_tax` returns assessed ship value and per-empire bills.
- **v0.310** — `get_empire_info`: public/no-login policy snapshot (fees, tax rates, fuel surcharge, repair costs, customs fines, bounty, rep dynamics, citizenship requirements, starting credits, contraband). Already in INTENTIONALLY_SKIPPED with a "deferred" note.

Fleet impact: when `tax_collection_active` flips true, every market purchase incurs sales tax and stateless players pay a penalty surcharge everywhere. Income tax hits end-of-week. Citizenship reduces both. This changes route profitability math enough that agents need explicit awareness before activation.

---

## 1. How Gantry Currently Surfaces Tools

### V1 tool surface (v1 MCP endpoint `/mcp`)

Tools are resolved dynamically from the game server via MCP `tools/list`, filtered through `DENIED_TOOLS` in `server/src/proxy/schema.ts`, then cross-checked against the static `STATIC_GAME_TOOLS` list in `server/src/proxy/server.ts`. The `schema-drift.test.ts` file maintains two disjoint sets:

- **`V1_PROXIED_TOOLS`** — actively proxied to agents (ground truth for "what the fleet can call")
- **`INTENTIONALLY_SKIPPED`** — known to server but deliberately not proxied (with reason comments)

`get_empire_info` is currently in `INTENTIONALLY_SKIPPED` with comment: `"v0.310.0 — get_empire_info: public no-login policy snapshot. Could surface to agents later; deferred decision (see project task)."`

`get_tax_estimate`, `spacemolt_citizenship`, and `get_property_tax` are not yet mentioned in either list (new enough that they haven't been evaluated).

### V2 tool surface (v2 MCP endpoint `/mcp/v2`)

The v2 endpoint uses action-dispatch consolidated tools (e.g., `spacemolt(action="get_tax_estimate")`). Tools are fetched from `{gameUrl}/v2?preset=X`, deny-filtered per `DENIED_ACTIONS_V2`, and optionally role-filtered via `mcpPresets` in `gantry.json`. The `roleType` field on agent config (`schemas.ts`) maps to a preset (e.g., `roleType: "trader"` → `mcpPresets.trader: [...]`).

### Compound/public tools

Gantry-native tools (not game passthrough) are registered in:
- `public-tools.ts` — `registerPublicTools()`: no-auth, cached public data
- `cached-queries.ts` — `registerCachedQueries()`: instant reads from `statusCache`
- `doc-tools.ts` — memory/diary/strategy doc tools

These are separate from game passthrough and don't appear in `V1_PROXIED_TOOLS`.

### Injections (per-response context)

The `InjectionRegistry` in `injection-registry.ts` wraps every tool response with context: battle status, faction storage limits, instability hints, lore, fleet orders. Injections are the right place for persistent ambient context that doesn't consume a tool call.

---

## 2. Implementation Plan

### 2a. Surface `get_tax_estimate` to Trader Agents

**Goal:** Agents can call `get_tax_estimate` (or `spacemolt(action="get_tax_estimate")` on v2) before large buys to understand their tax exposure.

#### V1 changes

**File:** `server/src/proxy/schema-drift.test.ts`

Move `get_tax_estimate` out of the "new tools not yet evaluated" section in `INTENTIONALLY_SKIPPED` and into `V1_PROXIED_TOOLS`:

```
// Tax economy — v0.305+ income tax estimate with bracket breakdown
"get_tax_estimate",
```

Remove it from `INTENTIONALLY_SKIPPED` (or add a comment that it was promoted). The tool takes no arguments (or optional `empire_id` per v0.305 — check server schema at runtime, drift detector will catch mismatches).

**File:** `server/src/proxy/tool-registry.ts`

Add to `NO_PARAM_DESCRIPTIONS`:
```typescript
get_tax_estimate: "Get your current tax estimate: income tax due, taxable income by source (mission/market/salvage/ship_sale/rescue), bracket schedule. Returns tax_collection_active flag — when false, tax is preview-only.",
```

No `TOOL_SCHEMAS` entry needed if the tool has no required params. If `empire_id` is optional, add to `TOOL_SCHEMAS`:
```typescript
get_tax_estimate: {
  description: "Get tax estimate for current (or specified) empire. Shows taxable income by source and bracket schedule.",
  schema: z.object({
    empire_id: z.string().optional().describe("Empire ID to estimate for (default: your citizenship empire)"),
  }),
},
```

Also add `get_tax_estimate` to `OUR_SCHEMA_PARAMS` in `mcp-factory.ts` (empty array `[]` if no params, or `["empire_id"]` if optional param is tracked):
```typescript
get_tax_estimate: [],
```

#### V2 changes (DENIED_ACTIONS_V2)

`get_tax_estimate` should NOT appear in `DENIED_ACTIONS_V2` in `schema.ts`. Verify it passes through cleanly in v2 by checking that `spacemolt(action="get_tax_estimate")` is not blocked. No action needed unless the tool name appears in `DENIED_ACTIONS_V2.spacemolt`.

**V2 role preset** (`gantry.json` or config): trader agents currently have `spacemolt` in their tool allowlist (the `trader` preset in `preset-filter.test.ts` includes `"spacemolt"`), so no preset-level change needed — the action filter will pass through naturally.

---

### 2b. Surface `get_empire_info` — Cached Public Tool

**Goal:** `get_empire_info` is login-free (public endpoint). Rather than making agents call it directly (wasting a tool slot and a game API hit), Gantry should cache it server-side and expose it as a public Gantry tool — same pattern as `get_global_market` / `MarketCache`.

#### New file: `server/src/proxy/empire-info-cache.ts`

Model on `market-cache.ts` and the existing `MarketCache` pattern. Key design points:

```typescript
export interface EmpireInfo {
  id: string;
  name: string;
  tax_rate_income: number;          // fractional (0.0–1.0)
  tax_rate_sales: number;
  tax_collection_active: boolean;
  citizenship_open: boolean;        // false = applications closed
  citizenship_requirements: string; // text description
  fuel_surcharge: number;
  repair_cost_modifier: number;
  customs_fine_rate: number;
  bounty_multiplier: number;
  starting_credits: number;
  contraband: string[];
  fetchedAt: number;
}

export interface EmpireInfoCache {
  empires: EmpireInfo[];
  fetchedAt: number;
}

export class EmpireInfoCache {
  // TTL: 1 hour (empire policies change rarely; invalidated on game version change via pollGameHealth)
  static readonly TTL_MS = 60 * 60 * 1000;
  
  // Fetch endpoint: GET {gameApiUrl}/empires (or call via MCP get_empire_info with anonymous session)
  // Check actual endpoint — the game likely exposes /api/empires or /api/v1/empires publicly.
  // MCP path: game_server_url /mcp with anonymous session + get_empire_info tool call.
  // Prefer the REST API path if available (avoids MCP session overhead).
  
  start(): ReturnType<typeof setInterval>;
  stop(): void;
  refresh(): Promise<void>;
  get(): { data: EmpireInfo[] | null; stale: boolean; age_seconds: number };
  restore(data: EmpireInfo[], fetchedAt: number): void;
}
```

**Fetch strategy:** `get_empire_info` is documented as "public, no-login" — meaning it works via MCP without a game session. However, the game's public REST API (`/api/empires` or similar) is preferable for a cache, since it doesn't require the 3-step MCP handshake. Check which endpoint the server actually exposes. The `MarketCache` uses `https://game.spacemolt.com/api/market` directly, which is the model to follow.

If only the MCP path works: use `fetchMcpToolsFromUrl`-style anonymous MCP session, call `tools/call` for `get_empire_info` without credentials, parse the result. This is heavier but works.

**Cache persistence:** Add `empireInfo` to `restorePublicCaches()` in `cache-persistence.ts` — same pattern as `marketData`.

**Integration in `mcp-factory.ts`:**

1. Instantiate `EmpireInfoCache` alongside `marketCache`:
   ```typescript
   const empireInfoCache = new EmpireInfoCache(config.gameUrl);
   ```
2. Register timer: `mcpTimers.register("empireInfoCache", empireInfoCache.start())`.
3. Pass to `sharedInstanceState` and `registerPublicTools`.
4. On game version change in `pollGameHealth`, call `empireInfoCache.forceRefresh()` (same as `galaxyGraphRef.current.forceRefresh()`).

**New public tool registered in `public-tools.ts`:**

```typescript
mcpServer.registerTool("get_empire_policies", {
  description: "Get cached empire policy snapshots: tax rates, citizenship status, fuel/repair costs, contraband. FREE — no game action cost. Updates hourly.",
  inputSchema: {
    empire_id: z.string().optional().describe("Filter to a specific empire ID (omit for all empires)"),
  },
}, requireLogin(({ empire_id }) => {
  const { data, stale, age_seconds } = empireInfoCache.get();
  if (!data) return textResult({ error: "empire info not yet loaded — try again shortly" });
  const empires = empire_id ? data.filter(e => e.id === empire_id) : data;
  return textResult({ empires, _cache: { age_seconds, stale } });
}));
registeredTools.push("get_empire_policies");
```

Tool name is `get_empire_policies` (not `get_empire_info`) to distinguish Gantry's cached aggregate from the raw game tool. The raw `get_empire_info` remains in `INTENTIONALLY_SKIPPED` — agents call the Gantry wrapper instead.

---

### 2c. Tax-Collection-Active Monitor

**Goal:** When `tax_collection_active` flips from `false` → `true` in the empire info cache, fire a fleet-wide alert (using the existing `createAlert` in `alerts-db.ts`) so the operator sees it on the dashboard and agents can be nudged.

#### New file: `server/src/proxy/tax-monitor.ts`

```typescript
import { createAlert, hasRecentAlert } from "../services/alerts-db.js";
import type { EmpireInfoCache } from "./empire-info-cache.js";

export class TaxMonitor {
  private previousActiveState = new Map<string, boolean>(); // empireId → was_active
  
  /**
   * Called on each empire info cache refresh (or on a timer).
   * Compares previous tax_collection_active per empire to current.
   * Fires a fleet-wide alert on any false→true transition.
   */
  check(empires: EmpireInfo[]): void {
    for (const empire of empires) {
      const prev = this.previousActiveState.get(empire.id);
      const curr = empire.tax_collection_active;
      if (prev === false && curr === true) {
        // Transition: tax just went live
        const category = `tax_active:${empire.id}`;
        if (!hasRecentAlert("fleet", category, 24 * 60 * 60 * 1000)) {
          createAlert(
            "fleet",
            "high",
            category,
            `TAX ACTIVATED in ${empire.name}: income tax (${Math.round(empire.tax_rate_income * 100)}%), sales tax (${Math.round(empire.tax_rate_sales * 100)}%). Citizenship reduces rates — review strategy.`,
          );
        }
      }
      this.previousActiveState.set(empire.id, curr);
    }
  }
}
```

**Integration:** Wire into `EmpireInfoCache.refresh()` or as a separate observer. On each successful refresh, call `taxMonitor.check(newEmpireData)`. The first refresh after server start populates `previousActiveState` without firing alerts (since `prev === undefined`, not `false`). Only subsequent refreshes where the value changes trigger an alert.

**Dashboard visibility:** The existing `/api/alerts` REST endpoint (`web/routes/alerts.ts`) and Alerts UI component already display `agent_alerts` rows — `fleet`-category alerts will appear there.

---

### 2d. Prompt Additions for Trader Agents

**File:** `examples/common-rules.txt.example`

Add a new numbered rule (insert after rule 18 TRADING, before 19 NON-EXISTENT TOOLS):

```
18b. TAX AWARENESS (preview → live):
    - Call get_tax_estimate() before large purchases to understand your tax exposure.
    - tax_collection_active=false means tax is in PREVIEW — no charges yet.
    - When tax goes live: sales tax applies to all purchases; stateless agents pay a surcharge.
    - Call get_empire_policies() to compare empire tax rates, fuel costs, and citizenship requirements.
    - Citizenship reduces income tax and eliminates the stateless surcharge — check if applications are open.
    - Route decisions: factor in per-empire fuel surcharge and repair cost modifiers from get_empire_policies().
```

**Agent-specific files** (if per-agent `.txt` files exist in the agent template): trader-role agents should additionally have:

```
TRADER-SPECIFIC TAX RULES:
- Before any buy() or create_buy_order(): compare expected sales tax across empires via get_empire_policies().
- Track your taxable_income_by_source from get_tax_estimate() — prioritize activities with lower effective tax.
- If citizenship is open in a favorable empire, flag it in your strategy doc for operator review (don't apply autonomously).
```

**Note:** Actual agent prompt files live outside this repo (in the private spacemolt repo per `gantry-repo-is-public.md` memory note). The `common-rules.txt.example` is the right place to document the pattern for public reference; the live file is deployed separately.

---

### 2e. Citizenship Strategy Hook

**Goal:** When empire applications open (`citizenship_open` flips `false` → `true`), alert the operator without having agents auto-apply (citizenship is an irreversible, strategically significant choice).

#### Extend `TaxMonitor.check()`:

```typescript
if (prev !== undefined) {
  const wasOpen = this.previousCitizenshipOpen.get(empire.id) ?? false;
  if (!wasOpen && empire.citizenship_open) {
    const category = `citizenship_open:${empire.id}`;
    if (!hasRecentAlert("fleet", category, 24 * 60 * 60 * 1000)) {
      createAlert(
        "fleet",
        "medium",
        category,
        `CITIZENSHIP OPEN in ${empire.name}: applications now accepted. Requirements: ${empire.citizenship_requirements}. Review agent citizenship strategy before applying.`,
      );
    }
  }
  this.previousCitizenshipOpen.set(empire.id, empire.citizenship_open);
}
```

**Agent prompt rule** (in `common-rules.txt.example`, as addendum to the citizenship section):

```
    IMPORTANT — citizenship applications require operator approval. Do NOT call apply_citizenship() autonomously.
    If citizenship opens and you believe it would benefit your operations, write a note in your strategy doc:
    spacemolt_social(action="write_doc", title="strategy", mode="append", content="CITIZENSHIP NOTE: [empire] is now open — recommend applying for [reason]")
    Then stop. Operator will review and issue a directive if approved.
```

**`spacemolt_citizenship` tool** (the full preset from v0.291/v0.298): When empires open, it may surface via the v2 preset as a new tool group. Until then, add `spacemolt_citizenship` to `INTENTIONALLY_SKIPPED` in `schema-drift.test.ts` with comment:

```
// v0.291 citizenship preset — not proxied until empires open applications and
// operator-approval workflow is in place. See docs/research/tax-citizenship-bundle-plan.md.
```

---

## 3. Exact File Changes Summary

| File | Change |
|------|--------|
| `server/src/proxy/empire-info-cache.ts` | **NEW** — EmpireInfoCache class, EmpireInfo types |
| `server/src/proxy/tax-monitor.ts` | **NEW** — TaxMonitor (tax_active + citizenship_open alerts) |
| `server/src/proxy/public-tools.ts` | Add `get_empire_policies` tool; add `EmpireInfoCache` to `PublicToolDeps` |
| `server/src/proxy/mcp-factory.ts` | Instantiate EmpireInfoCache + TaxMonitor; register timer; restore cache; wire version-change refresh; expose in `sharedInstanceState` |
| `server/src/proxy/cache-persistence.ts` | Add `empireInfo` to `restorePublicCaches()` / `persistPublicCaches()` |
| `server/src/proxy/schema-drift.test.ts` | Move `get_tax_estimate` from `INTENTIONALLY_SKIPPED` → `V1_PROXIED_TOOLS`; add `spacemolt_citizenship` to `INTENTIONALLY_SKIPPED` |
| `server/src/proxy/tool-registry.ts` | Add `get_tax_estimate` to `NO_PARAM_DESCRIPTIONS` (or `TOOL_SCHEMAS` if param needed) |
| `server/src/proxy/mcp-factory.ts` | Add `get_tax_estimate: []` to `OUR_SCHEMA_PARAMS` |
| `server/src/proxy/schema.ts` | Confirm `get_tax_estimate` not in `DENIED_TOOLS`; keep `get_empire_info` absent (Gantry wrapper replaces it) |
| `examples/common-rules.txt.example` | Add TAX AWARENESS rule block |

---

## 4. Tests (bun test)

### 4a. `server/src/proxy/empire-info-cache.test.ts` (new)

Tests to write:
- `EmpireInfoCache.get()` returns `{ data: null }` before first fetch.
- `refresh()` parses response and populates cache.
- `refresh()` uses stale data on fetch failure (TTL still honored).
- `get(empire_id)` filter in `get_empire_policies` tool handler returns subset.
- Cache TTL: `get()` marks `stale: true` when `fetchedAt` is old.
- `restore()` populates cache without a fetch (startup case).

Use a mock `fetch` (same pattern as `market-cache.test.ts`):
```typescript
import { describe, it, expect, mock, beforeEach } from "bun:test";
```

### 4b. `server/src/proxy/tax-monitor.test.ts` (new)

- `check()` on first call populates `previousActiveState` without creating alerts.
- `check()` on second call with `tax_collection_active: false` → no alert.
- `check()` with transition `false → true` calls `createAlert` once.
- Duplicate call within 24h: `hasRecentAlert` prevents second alert (mock the db calls).
- Citizenship `false → true` creates a `medium` severity alert.
- Citizenship already open from first check: no duplicate alert.

Use db mocks (same pattern as `alerts-db.test.ts`):
```typescript
import { createAlert, hasRecentAlert } from "../services/alerts-db.js";
mock.module("../services/alerts-db.js", () => ({
  createAlert: mock(() => 1),
  hasRecentAlert: mock(() => false),
}));
```

### 4c. `server/src/proxy/schema-drift.test.ts` (modify existing)

Existing static test `"V1_PROXIED_TOOLS and INTENTIONALLY_SKIPPED are disjoint"` will automatically validate the move of `get_tax_estimate`.

Add regression guard:
```typescript
it("get_tax_estimate is in V1_PROXIED_TOOLS (tax economy surface)", () => {
  expect(V1_PROXIED_TOOLS.has("get_tax_estimate")).toBe(true);
  expect(INTENTIONALLY_SKIPPED.has("get_tax_estimate")).toBe(false);
});

it("spacemolt_citizenship is in INTENTIONALLY_SKIPPED (operator-approval required)", () => {
  expect(INTENTIONALLY_SKIPPED.has("spacemolt_citizenship")).toBe(true);
});
```

### 4d. `server/src/proxy/public-tools.test.ts` (extend existing)

Add:
```typescript
describe("get_empire_policies", () => {
  it("returns error when cache empty", ...);
  it("returns all empires when no filter", ...);
  it("filters by empire_id", ...);
  it("includes _cache metadata", ...);
  it("returns error when not logged in", ...);
});
```

---

## 5. Definition of Done

- [ ] `bun test` passes (all existing + new tests green).
- [ ] `get_tax_estimate` appears in `V1_PROXIED_TOOLS` and NOT in `INTENTIONALLY_SKIPPED`.
- [ ] `get_empire_policies` is visible in the registered tool list (check `/health` response: `tools` count increases by 1).
- [ ] `EmpireInfoCache` refreshes on startup and is accessible via `get_empire_policies`.
- [ ] `TaxMonitor.check()` unit tests cover transition logic with mocked DB.
- [ ] `empire-info-cache.test.ts` passes with mocked fetch.
- [ ] `common-rules.txt.example` includes TAX AWARENESS section.
- [ ] `INTENTIONALLY_SKIPPED` includes `spacemolt_citizenship` with comment.
- [ ] `schema-drift` regression guards pass.

### Verification checklist (manual, after deploy)

- [ ] Call `get_empire_policies` via a v1 MCP test session — returns empire list.
- [ ] Call `get_tax_estimate` via a v1 MCP test session — returns tax data.
- [ ] Dashboard `/alerts` shows no spurious tax alerts on clean startup (first-check baseline, no transitions yet).
- [ ] Manually invoke `taxMonitor.check()` with a synthetic `tax_collection_active: true` empire — alert appears on `/alerts`.
- [ ] `/health` response shows `tools` count consistent with new registrations.
- [ ] `bun test server/src/proxy/empire-info-cache.test.ts` green.
- [ ] `bun test server/src/proxy/tax-monitor.test.ts` green.

---

## 6. Design Notes and Deferred Decisions

**Why not surface `get_tax_estimate` as a v2 action?** It already passes through naturally on v2 via `spacemolt(action="get_tax_estimate")` — no explicit v2 registration needed. The DENIED_ACTIONS_V2 check in `schema.ts` doesn't block it. Only v1 requires explicit inclusion in `V1_PROXIED_TOOLS`.

**Why `get_empire_policies` instead of proxying `get_empire_info` raw?** The raw game tool requires a login session and hits the game server per-call. Gantry's cached aggregate is FREE for agents (no game API quota), returns all empires in one call, and is available during transit. This is the same argument that led to `get_global_market` replacing per-empire market calls.

**`get_property_tax` (v0.307):** Property tax on ship value is a per-agent concern (depends on which ship each agent owns). It's best surfaced as a direct passthrough tool, same treatment as `get_tax_estimate`. Add to `V1_PROXIED_TOOLS` and `NO_PARAM_DESCRIPTIONS` in the same commit.

**Citizenship application workflow:** The current plan is operator-only. If future work wants to automate it, the pattern would be a directive from the overseer agent to a specific fleet agent (same as current `fleet_orders`/`directives` flow), not autonomous self-application. The citizenship tool itself (`spacemolt_citizenship`) should stay in INTENTIONALLY_SKIPPED until that workflow is designed.

**Tax-aware routing:** `get_empire_policies` returning `fuel_surcharge` and `repair_cost_modifier` per empire enables future work in the `ArbitrageAnalyzer` or a new `TaxAwareRouter` to factor these into route profitability. That's out of scope for this bundle but the cache infrastructure makes it straightforward to add.

**EmpireInfoCache persistence:** Use the same `cache-persistence.ts` pattern as `marketData`. Write to `fleet.db` as a `proxy_public_caches` JSON blob (or a dedicated table if schema warrants it — check what `persistPublicCaches` currently persists). On startup, restored empire data prevents the 1-minute gap where agents would get errors from `get_empire_policies` before the first fetch completes.
