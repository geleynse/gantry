# API Drift Monitor — Implementation Plan

**Date:** 2026-05-30  
**Context:** Continuous detection of new/changed SpaceMolt game-server API fields between manual audits.

---

## 1. Problem Statement

Gantry currently detects tool-list drift only via `schema-drift.test.ts` (CI-only, static) and `schema.ts`'s `checkSchemaDrift()` (startup-only, logs only). Neither runs continuously at runtime. A peer wrapper (rsned/spacemolt api-monitor) caught four new `DockResponse` fields and `drone_id` on `mining_yield` on 2026-05-28 before Gantry noticed. New fields get silently stripped between manual passthrough audits.

**Gap:** No mechanism persists a baseline of what the game server's MCP tool schemas look like and diffs it on a schedule to surface drift.

---

## 2. Current Code Inventory

### What Already Exists

**`server/src/proxy/schema.ts`**
- `fetchMcpToolsFromUrl(url, label)` — performs the 3-step MCP handshake (initialize → initialized → tools/list) and returns `ServerTool[]`
- `ServerTool` interface: `{ name, description?, inputSchema?: { type?, properties?: Record<string, unknown>, required?: string[] } }`
- `checkSchemaDrift(ourSchemaParams, serverTools)` — compares Gantry's Zod param names against server `inputSchema.properties`; logs `⚠ Drift` per tool; runs once at startup only
- `invalidateSchemaCache()` — deletes `$FLEET_DIR/data/schema-cache.json`; called from `mcp-factory.ts` when `pollGameHealth()` detects a version bump
- `resolveGameTools()` / `resolveGameToolsV2()` — both write fetched `serverTools` into the schema cache (`SchemaCacheEntry.serverTools`); the cache already stores the full `ServerTool[]` per fetch

**`server/src/proxy/mcp-factory.ts`**
- `pollGameHealth()` runs every 10 s polling `$GAME_URL/health`; detects `version` changes; calls `invalidateSchemaCache()` + galaxy-graph refresh on version bump
- `LifecycleManager` + `mcpTimers.register(name, interval)` is the established pattern for periodic jobs
- `fleetHealthMonitor` (60 s) and `gameHealth` (10 s) are canonical examples of periodic tick registration

**`server/src/services/alerts-db.ts`**
- `createAlert(agent, severity, category, message)` — inserts into `agent_alerts` table; `agent` is a string, can be a synthetic name like `"system"`
- `hasRecentAlert(agent, category, withinMs)` — idempotency guard; used by health-monitor for `quota_exhausted` dedup; default 24 h window
- Severity options (from `app/alerts/helpers.ts`): `"info"`, `"warning"`, `"error"`, `"critical"`

**`server/src/config/env.ts`**
- `envInt()` helper; existing timing constants: `SCHEMA_TTL_MS` (default 3600000), `MARKET_SCAN_INTERVAL_MS`, etc.
- Pattern to follow: `export const API_DRIFT_MONITOR_INTERVAL_MS = envInt("API_DRIFT_MONITOR_INTERVAL_MS", 3600000)`

---

## 3. Design Decisions

### 3a. Spec-diff vs Response-diff

**Chosen approach: spec-diff (MCP tools/list schema diff), NOT response-diff.**

Rationale:
- Response-diff (sampling live tool call outputs) requires authenticated sessions per agent, leaks real game actions, and is order-of-magnitude harder to implement safely.
- The peer wrapper (rsned) that caught the DockResponse drift does schema-level diffing from the OpenAPI/MCP spec — not live calls. That is the right signal: the game server's declared `inputSchema.properties` is exactly what `fetchMcpToolsFromUrl()` already retrieves.
- The schema cache (`schema-cache.json`) already stores `serverTools: ServerTool[]` including full `inputSchema`. The monitor can use the same fetch path.

**Two-layer diff:**
1. **Tool list diff** — tools added/removed on the server (already caught by `schema-drift.test.ts` in CI; replicate at runtime)
2. **Per-tool inputSchema diff** — properties added/removed/type-changed per tool (the gap `checkSchemaDrift()` partially covers at startup only)

### 3b. Diff target: anonymous MCP session

Uses the same `fetchMcpToolsFromUrl()` from `schema.ts` — no auth required. The game server allows unauthenticated `tools/list` (same as `schema-drift.test.ts` proves). The game URL is `config.gameUrl` (already available in `mcp-factory.ts`).

### 3c. Where it runs

**Periodic job in `mcp-factory.ts`**, same pattern as `fleetHealthMonitor` and `gameHealth`. Default interval: 1 hour (matches `SCHEMA_TTL_MS`). Runs independently of agent sessions — no auth dependency.

Also hook into the **version-change path**: when `pollGameHealth()` detects a version change and calls `invalidateSchemaCache()`, immediately trigger a drift check. This catches same-deploy-day schema changes.

### 3d. Baseline storage

A new JSON file: `$FLEET_DIR/data/api-drift-baseline.json`

```ts
interface ApiDriftBaseline {
  version: string;           // game server version when baseline was captured
  capturedAt: number;        // epoch ms
  tools: BaselineTool[];
}

interface BaselineTool {
  name: string;
  description: string;
  params: BaselineParam[];   // sorted by name for stable diffs
}

interface BaselineParam {
  name: string;
  type: string;              // normalized: string | number | integer | boolean | array | object | unknown
  required: boolean;
  hasDescription: boolean;   // true/false — avoid storing description text (noisy, not structural)
}
```

File lives alongside `schema-cache.json` in `$FLEET_DIR/data/`. Read/write functions mirror the existing `readSchemaCache()` / `writeSchemaCache()` pattern in `schema.ts`.

**No SQLite table needed.** A JSON file is consistent with existing patterns (schema-cache.json, galaxy-cache.json) and is easy to inspect by hand.

### 3e. Diff algorithm

```
DriftReport {
  newTools: string[]            // server has it, baseline doesn't
  removedTools: string[]        // baseline has it, server doesn't (excluding INTENTIONALLY_SKIPPED)
  changedTools: ToolDiff[]
}

ToolDiff {
  name: string
  newParams: string[]           // server has param, baseline doesn't
  removedParams: string[]       // baseline has param, server doesn't
  typeChanges: { param: string; from: string; to: string }[]
  requiredChanges: { param: string; from: boolean; to: boolean }[]
}
```

**Filtering:**
- Skip tools in `INTENTIONALLY_SKIPPED` (imported from `schema-drift.test.ts` — or extracted to a shared constant) for `removedTools` only; new tools always reported
- Skip `session_id` param (handled at proxy level, per existing `IGNORED_SERVER_PARAMS` in `checkSchemaDrift()`)
- `removedTools` that are in `DENIED_TOOLS` (from `schema.ts`) are not reported — they're intentionally blocked, not missing from Gantry's perspective

### 3f. Alert filing

When non-empty drift is detected:

```ts
// One alert per drift event; category "api-drift"; agent "system"
// Dedup: hasRecentAlert("system", "api-drift", 6 * 3600 * 1000) — 6h window
// (shorter than 24h because drift that lasts >6h is worth re-alerting if unacknowledged)

createAlert(
  "system",
  drift.removedTools.length > 0 ? "warning" : "info",
  "api-drift",
  buildAlertMessage(drift, gameVersion)
);
```

Message format:
```
API drift detected (game v0.323):
  NEW tools (3): get_action_log, captains_log_get, distress_signal
  CHANGED tools (2):
    dock: +drone_id (string, optional)
    mine: +mining_yield.drone_id (string, optional)
  REMOVED tools (0): (none)
Review: update V1_PROXIED_TOOLS or INTENTIONALLY_SKIPPED in schema-drift.test.ts
```

`severity = "warning"` if any `removedTools` (something Gantry proxied disappeared); `"info"` otherwise (new stuff exists). The distinction matters: removed tools cause hard failures in agents; new tools are opportunities.

Also **always log** the drift report at `log.warn` level even if dedup suppresses the DB alert, so it appears in `gantry-server.log`.

### 3g. Baseline update policy

- **First run** (no baseline file): capture current server state as baseline, log "initial baseline captured", no alert.
- **After each diff**: if drift is detected, alert and log but do NOT auto-update the baseline. Operator acknowledges the alert (via UI) and a separate `POST /api/admin/api-drift/accept` endpoint atomically updates the baseline to the current server state.
- **On version change** (via `pollGameHealth`): run immediate diff, then auto-update baseline if the only changes are additions consistent with the new version. If tools were removed, require manual acknowledgment.

---

## 4. Files to Add / Change

### New Files

**`server/src/services/api-drift-monitor.ts`**  
Primary module. Exports:
- `ApiDriftBaseline`, `BaselineTool`, `BaselineParam`, `DriftReport`, `ToolDiff` interfaces
- `readDriftBaseline(): ApiDriftBaseline | null`
- `writeDriftBaseline(baseline: ApiDriftBaseline): void`
- `buildBaseline(serverTools: ServerTool[], gameVersion: string): ApiDriftBaseline`
- `diffBaseline(baseline: ApiDriftBaseline, current: ApiDriftBaseline): DriftReport`
- `isDriftEmpty(report: DriftReport): boolean`
- `formatDriftAlert(report: DriftReport, gameVersion: string): string`
- `createApiDriftMonitor(deps: ApiDriftMonitorDeps): ApiDriftMonitor` — factory

`ApiDriftMonitorDeps`:
```ts
interface ApiDriftMonitorDeps {
  mcpUrl: string;               // config.gameUrl (the MCP base URL)
  getGameVersion: () => string | null;  // from gameHealthRef
  fleetDir: string;             // FLEET_DIR
  onDrift?: (report: DriftReport) => void;  // callback for testing
}
```

`ApiDriftMonitor`:
```ts
interface ApiDriftMonitor {
  tick(): Promise<void>;         // one check pass
  forceCheck(): Promise<void>;   // immediate check, skips dedup on alert (for version-change hook)
  acceptBaseline(): void;        // update baseline to current server state (for admin endpoint)
  getCurrentBaseline(): ApiDriftBaseline | null;
  getLastReport(): DriftReport | null;
}
```

**`server/src/services/api-drift-monitor.test.ts`**  
Unit tests (bun:test). See §6 for specifics.

### Changed Files

**`server/src/config/env.ts`**  
Add:
```ts
export const API_DRIFT_MONITOR_INTERVAL_MS = envInt("API_DRIFT_MONITOR_INTERVAL_MS", 3600000);
export const API_DRIFT_MONITOR_ENABLED = process.env.API_DRIFT_MONITOR_ENABLED !== "0"; // default on
```

**`server/src/config/index.ts`**  
Re-export the two new constants.

**`server/src/proxy/mcp-factory.ts`**  
Wiring (after `pollGameHealth` setup, around line 487):
```ts
import { createApiDriftMonitor } from "../services/api-drift-monitor.js";
import { API_DRIFT_MONITOR_INTERVAL_MS, API_DRIFT_MONITOR_ENABLED } from "../config/env.js";

// --- API drift monitor ---
const apiDriftMonitor = API_DRIFT_MONITOR_ENABLED
  ? createApiDriftMonitor({
      mcpUrl: config.gameUrl,
      getGameVersion: () => gameHealthRef.current?.version ?? null,
      fleetDir: FLEET_DIR,
    })
  : null;

if (apiDriftMonitor) {
  // Initial check (non-blocking, after startup)
  apiDriftMonitor.tick().catch((err) =>
    log.warn("api-drift initial check failed", { error: err instanceof Error ? err.message : String(err) })
  );

  const driftInterval = setInterval(async () => {
    try { await apiDriftMonitor.tick(); }
    catch (err) { log.warn("api-drift monitor tick failed", { error: err instanceof Error ? err.message : String(err) }); }
  }, API_DRIFT_MONITOR_INTERVAL_MS);
  driftInterval.unref();
  mcpTimers.register("apiDriftMonitor", driftInterval);
  log.info("api-drift monitor started", { intervalMs: API_DRIFT_MONITOR_INTERVAL_MS });
}
```

In the version-change block (around line 459, after `invalidateSchemaCache()`):
```ts
// Trigger immediate drift check on game version bump
apiDriftMonitor?.forceCheck().catch((err) =>
  log.warn("api-drift force check failed on version change", { error: err instanceof Error ? err.message : String(err) })
);
```

**`server/src/app.ts` (or relevant route file)**  
Add admin endpoint:
```
POST /api/admin/api-drift/accept
GET  /api/admin/api-drift/status   → { baseline: ..., lastReport: ..., lastCheckedAt: ... }
```
These require operator auth (same as other `/api/admin/` routes). The `accept` endpoint calls `apiDriftMonitor.acceptBaseline()`.

**`server/src/proxy/schema-drift.test.ts`** (optional refactor, not required for MVP)  
Extract `INTENTIONALLY_SKIPPED` to a shared constant in `server/src/proxy/proxy-constants.ts` so the runtime monitor can import it without pulling in bun:test. If deferred, the monitor can maintain its own copy of the skip set initially and a follow-up task can DRY it up.

---

## 5. Data Model Details

### Baseline file path

```ts
function getDriftBaselinePath(fleetDir: string): string {
  return join(fleetDir, "data", "api-drift-baseline.json");
}
```

### Normalization

When building a `BaselineTool` from a `ServerTool`:
1. Sort `params` by `name` (stable diff)
2. Normalize `type`: coerce `"number"` and `"integer"` both to `"number"` for comparison purposes (game server sometimes uses either; type changes between the two are not structural)
3. `required`: derive from `inputSchema.required` array; default `false` if absent
4. Skip `session_id` param
5. `hasDescription`: `true` if `properties[p]` has a non-empty description string (not stored, just flagged)

### Diff algorithm (pseudocode)

```
diffBaseline(baseline, current):
  baselineMap = Map(baseline.tools, by name)
  currentMap  = Map(current.tools,  by name)

  newTools = currentMap.keys - baselineMap.keys
  removedTools = (baselineMap.keys - currentMap.keys) filtered by (not in DENIED_TOOLS)

  changedTools = []
  for name in intersection(baselineMap.keys, currentMap.keys):
    bt = baselineMap[name]
    ct = currentMap[name]
    bparams = Map(bt.params, by name)
    cparams = Map(ct.params, by name)

    newParams     = cparams.keys - bparams.keys
    removedParams = bparams.keys - cparams.keys
    typeChanges   = [p for p in intersection where bparams[p].type !== cparams[p].type]
    reqChanges    = [p for p in intersection where bparams[p].required !== cparams[p].required]

    if any of above non-empty → changedTools.push(...)

  return { newTools, removedTools, changedTools }
```

---

## 6. Tests (`bun test`)

File: `server/src/services/api-drift-monitor.test.ts`

```
describe("buildBaseline")
  - normalizes types (integer → number)
  - sorts params alphabetically
  - omits session_id
  - sets required correctly from inputSchema.required

describe("diffBaseline")
  - empty diff for identical snapshots
  - detects newTools
  - detects removedTools (excluding DENIED_TOOLS)
  - detects param additions on a changed tool
  - detects param removals on a changed tool
  - detects type changes
  - detects required changes
  - no false positives for number/integer normalization

describe("formatDriftAlert")
  - includes game version
  - shows correct counts
  - severity = "warning" when removedTools is non-empty
  - severity = "info" for additions-only

describe("createApiDriftMonitor — unit (mock fetch)")
  - tick(): captures baseline on first run (no alert)
  - tick(): no alert when baseline matches current
  - tick(): files alert on drift (createAlert called)
  - tick(): respects hasRecentAlert dedup (createAlert NOT called on second tick within 6h)
  - tick(): skips if game server unreachable (null fetch result — no throw, no alert)
  - forceCheck(): bypasses dedup, always calls createAlert if drift
  - acceptBaseline(): overwrites baseline file; subsequent tick sees no drift
  - API_DRIFT_MONITOR_ENABLED=0: monitor is null (test env var path)
```

All network calls mocked via bun:test `mock()`. Baseline file I/O uses a temp dir (same pattern as `schema-cache` tests in `schema.test.ts`).

---

## 7. Config Reference

| Env var | Default | Effect |
|---|---|---|
| `API_DRIFT_MONITOR_ENABLED` | `"1"` (on) | Set to `"0"` to disable entirely |
| `API_DRIFT_MONITOR_INTERVAL_MS` | `3600000` (1h) | How often to poll |

Both follow the existing `envInt` / env-var pattern in `config/env.ts`.

---

## 8. Definition of Done

### Implementation checklist
- [ ] `server/src/services/api-drift-monitor.ts` created with all exported interfaces + factory
- [ ] `server/src/services/api-drift-monitor.test.ts` passes: `bun test server/src/services/api-drift-monitor.test.ts`
- [ ] `config/env.ts` exports `API_DRIFT_MONITOR_INTERVAL_MS` and `API_DRIFT_MONITOR_ENABLED`
- [ ] `config/index.ts` re-exports both constants
- [ ] `mcp-factory.ts` wires monitor into `mcpTimers` and version-change hook
- [ ] Admin endpoints added (or deferred with a task filed)
- [ ] Full test suite still green: `bun test` from `server/`

### Verification checklist
1. **Cold start:** Delete `$FLEET_DIR/data/api-drift-baseline.json`. Start server. Check log for "initial baseline captured". Check that no alert was filed.
2. **Drift simulation:** Manually edit `api-drift-baseline.json` to remove a param from `dock`. Wait for next tick (or set `API_DRIFT_MONITOR_INTERVAL_MS=10000`). Verify `"api-drift"` alert appears in the dashboard alerts tab.
3. **Dedup:** Trigger drift twice within the 6h window. Verify only one alert in `agent_alerts` table (unacknowledged).
4. **Version change:** Force a mock version change in `pollGameHealth` (or wait for a real game deploy). Verify `forceCheck()` fires and the log shows drift check triggered.
5. **Accept baseline:** Call `POST /api/admin/api-drift/accept`. Verify `api-drift-baseline.json` is updated and next tick produces no drift.
6. **Disabled:** Set `API_DRIFT_MONITOR_ENABLED=0`, restart. Verify no `api-drift monitor started` log line and no interval registered.

---

## 9. What This Does NOT Do

- **Response-body diff** — not in scope. Would need authenticated sessions and is high-risk for live agents.
- **Description text diff** — descriptions change for cosmetic reasons; noisy and not structural. `hasDescription` bool is captured but description text is not stored in the baseline.
- **Auto-applying patches** — the monitor alerts; the operator decides whether to proxy new tools or add them to `INTENTIONALLY_SKIPPED`. No auto-commit to `schema-drift.test.ts`.
- **Per-agent alerting** — drift is fleet-wide, not per-agent. `agent = "system"` in the alert row.

---

## 10. Open Questions

1. **Admin endpoint scope:** Should `acceptBaseline` be in the existing `/api/admin/` router or exposed as a UI action in the alerts panel? The alerts panel pattern (acknowledge + category-specific action) may be cleaner UX.
2. **INTENTIONALLY_SKIPPED sharing:** Refactor `schema-drift.test.ts` to import from a shared constant vs. duplicate list in `api-drift-monitor.ts`. Recommended follow-up; not a blocker for MVP.
3. **v2 schema diff:** The monitor is scoped to the v1 MCP endpoint (`config.gameUrl`). v2 presets (`/mcp/v2?preset=X`) expose consolidated tools with different schemas. Extending to v2 is a separate task.
