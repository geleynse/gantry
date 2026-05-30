# Explore-Loop Guard Plan

**Date:** 2026-05-30  
**Status:** PLAN — implementation pending  
**Problem:** Three agents (brass-meridian, cinder-wake, rust-vane) enter explore-loops despite explicit operator/overseer orders to dock and sell. Root cause is structural: agents ignore injected orders and keep chasing mining/exploration POIs until the turn timer kills them.

---

## 1. How the Proxy Currently Gates Actions

### 1.1 Interception Points

All tool calls flow through one of two guardrail functions in `server/src/proxy/pipeline.ts`:

- **`checkGuardrailsV1(ctx, agentName, toolName, args)`** — v1 (individual tool) path
- **`checkGuardrailsV2(ctx, agentName, toolName, action, args, sessionId)`** — v2 (action-dispatch) path

Both run *before* the tool reaches `handlePassthrough()` or the compound-tool dispatch in `gantry-v2.ts`. Returning a non-null string from either function short-circuits execution and returns `textResult({ error: blockedMessage })` to the agent.

The call chain in `gantry-v2.ts` (line 724):
```
checkGuardrails(agentName, toolName, action, args, extra.sessionId)
  → pipelineModule.checkGuardrailsV2(pipelineCtx, ...)
```

### 1.2 How Game State Is Available at Intercept Time

`PipelineContext.statusCache` is a `Map<string, { data: Record<string, unknown>; fetchedAt: number }>` updated by the WebSocket tick loop (independent of MCP calls). At guardrail time, `statusCache.get(agentName)` is always accessible.

Cargo data lives inside the `ship` sub-object. The authoritative extraction pattern (from `override-system.ts` `extractAgentState()`):
```typescript
const data = cached.data;
const player = (data.player ?? data) as Record<string, unknown>;
const ship = (data.ship ?? player.ship ?? {}) as Record<string, unknown>;
const cargoUsed = typeof ship.cargo_used === "number" ? ship.cargo_used : undefined;
const cargoCapacity = typeof ship.cargo_capacity === "number" ? ship.cargo_capacity : undefined;
```

This pattern is already used in:
- `override-system.ts` → `extractAgentState()` (for the `cargo-full` override rule at line 119–128)
- `pipeline.ts` → `brokeMiningOverride()` (reads `player.credits` from `statusCache`)
- `passthrough-handler.ts` → error-hint extraction (reads `ship.cargo_used`, `ship.cargo_capacity`)
- `state-hints.ts` → `getAgentData()` (same structure)

### 1.3 Existing DENIED_ACTIONS_V2 / agentDeniedTools

`DENIED_ACTIONS_V2` (schema.ts line 516) is a compile-time blocklist of tool+action pairs. Checked in `checkGuardrailsV2` after instability and transit gates.

`agentDeniedTools` (fleet-config.json, keyed by agent name or `"*"`) is the operator-configured runtime blocklist. Also checked in `checkGuardrailsV2` — looks up `toolName`, `action`, and `toolName:action` composite keys.

### 1.4 Existing Cargo-Full Override (Injection Path)

There is already a `cargo-full` rule in `override-system.ts` BUILT_IN_RULES (priority 20, 3-min cooldown):
```typescript
condition: cargoUsed >= cargoCapacity,
directive: "NOTICE: Cargo hold is full. Sell, deposit, or jettison..."
```

This fires as a *soft injection* (`_overrides` key in tool response) — it **does not block the action**. The agent reads it as a notice and proceeds to ignore it, which is the confirmed failure mode.

### 1.5 Response Injection Pipeline

After a tool executes, `withInjections()` calls `InjectionRegistry.run()` (priority-ordered) and merges results into the response JSON. Injections include:
- Priority 5: `_overrides` (OverrideRegistry — fires conditions, includes cargo-full)
- Priority 20: `fleet_orders` (operator orders from comms DB)
- Priority 70: `standing_orders` (active directives from directives DB)

All of these are advisory. None block the next tool call.

---

## 2. Candidate Guards

### Guard A — Cargo-Saturation Hard Block

**Mechanism:** Inside `checkGuardrailsV2` (and optionally `checkGuardrailsV1`), add a pre-flight check: when `cargoUsed / cargoCapacity >= threshold` AND the requested action is in a "non-resolution" set, return a hard block with an actionable error.

**Blocked action set** (actions that cannot resolve a cargo-full state):
```
mine, batch_mine, travel (to non-station), jump, jump_route,
survey_system, get_nearby, explore_system
```

**Allowed-through actions** (always pass regardless of cargo level):
```
sell, multi_sell, deposit, deposit_items, dock, undock, travel (to station),
logout, captains_log_add, get_status, get_location, get_cargo, get_ship,
analyze_market, view_market, create_sell_order, get_active_missions,
complete_mission, find_route, get_system, write_diary, read_diary
```

**Error returned to agent:**
```json
{
  "error": "CARGO_SATURATION_BLOCK: Cargo is at X/Y (Z%). You must dock and sell before mining or exploring. Travel to a station and use sell or multi_sell to clear cargo."
}
```

**Threshold:** `>= 0.95` (not 1.0 — the game's cargo-full check is >=, so at 95% a mine attempt would fail anyway; blocking at 95% avoids the wasted round-trip and gives agents a clear window to sell without needing to be exactly full).

**Config flag:** `cargoSaturationGuard` in `GantryConfig` / `FleetConfigSchema`, with per-agent opt-in via agent config `cargoSaturationGuardEnabled?: boolean`. Default: **true** (opt-out for edge cases).

**Anti-deadlock:** If there is no seller in the system, the agent must be allowed to navigate away. Block only non-navigation actions. Jump and travel remain allowed at saturation so the agent can reposition to a selling station. Mining and exploration are the specific behaviors to stop.

**Sellability check:** Do NOT check whether the current system has a buyer before blocking — that requires a market lookup and introduces latency. The error message should direct the agent to travel to a selling station if needed. If the agent is already at a station, it can sell directly; if not, it should jump/travel first (both of which pass the guard).

---

### Guard B — Operator-Order Enforcement Layer

**Mechanism:** Read pending fleet orders (`ctx.getFleetPendingOrders(agentName)`) and/or active directives (`ctx.getActiveDirectives(agentName)`). If any order/directive contains a dock/sell command and the agent is attempting a non-compliant action, block it.

**Complexity issues:**
1. Orders are free-text strings — parsing "dock at station X and sell" requires either regex matching or LLM classification, both fragile.
2. Orders are delivered once via injection then marked delivered. After delivery, there is no "outstanding order" signal in the proxy — the agent is expected to act on it. The proxy has no state tracking whether the agent complied.
3. Directives (from `directives DB`) have a `priority` field (`"critical"` or `"normal"`), but their text is also free-form.
4. The risk of false positives is high — an order like "sell surplus crystals when convenient" should not block a jump.

**Verdict:** Guard B is not buildable cleanly without a structured order schema or compliance-state tracking that doesn't exist today. Too much complexity for too much fragility.

---

### Recommendation: Guard A (cargo-saturation hard block) as primary, with a tighter `cargo-full` override injection as secondary

The `cargo-full` existing override is at priority 20 and cooldown 180s — it fires too infrequently and is advisory only. The new guard operates at the **guardrail layer** (hard block), which is the right enforcement tier for structural loop prevention.

**Hybrid tweak:** Simultaneously tighten the existing `cargo-full` override to:
1. Lower threshold from `cargoUsed >= cargoCapacity` to `cargoUsed / cargoCapacity >= 0.90` (fire earlier)
2. Reduce cooldown from 180s to 60s
3. Change directive from "NOTICE" to "URGENT" wording

This means agents get a soft warning at 90% and a hard block at 95%.

---

## 3. Implementation Specification

### 3.1 Files to Modify

**Primary change — guardrail:**
- `server/src/proxy/pipeline.ts` — add `checkCargoSaturationBlock()` helper, call it in `checkGuardrailsV2` (and optionally `checkGuardrailsV1`)

**Config changes:**
- `server/src/config/schemas.ts` — add `cargoSaturationGuard?: z.boolean().optional()` to `FleetConfigSchema`, add `cargoSaturationGuardEnabled?: z.boolean().optional()` to `AgentConfigSchema`
- `server/src/config/types.ts` — add `cargoSaturationGuard?: boolean` to `GantryConfig`

**Secondary change — tighten existing override:**
- `server/src/proxy/override-system.ts` — adjust `cargo-full` rule threshold (0.9), cooldown (60s), wording

### 3.2 Interception Point

In `checkGuardrailsV2` (pipeline.ts), add after the instability gate and before the denied-tools check (line ~800, after the transit-throttle block):

```typescript
// Cargo saturation guard — block non-resolution actions when cargo >= 95%
const cargoBlock = checkCargoSaturationBlock(ctx, agentName, action ?? toolName);
if (cargoBlock) {
  log.info("v2 blocked by cargo saturation", { agent: agentName, action, toolName });
  return cargoBlock;
}
```

The same helper can be called in `checkGuardrailsV1` after the duplicate-detection block for v1 agents.

### 3.3 `checkCargoSaturationBlock()` Implementation

```typescript
/**
 * Actions that CANNOT resolve a cargo-full state.
 * When cargo is >= CARGO_SATURATION_THRESHOLD, these are blocked.
 */
const CARGO_BLOCKING_ACTIONS = new Set([
  "mine", "batch_mine",
  // Exploration that produces cargo
  "survey_system",
  // Navigation that moves agent AWAY from selling without selling
  // NOTE: jump, travel, jump_route are NOT blocked — agent needs to navigate to a seller
]);

const CARGO_SATURATION_THRESHOLD = 0.95;

/**
 * Returns an error string if the agent's cargo is at saturation and the action
 * cannot resolve it. Returns null if the action is allowed through.
 *
 * Only fires when:
 * 1. statusCache has cargo data (skips if cache miss — fail open)
 * 2. cargoUsed / cargoCapacity >= CARGO_SATURATION_THRESHOLD
 * 3. The action is in CARGO_BLOCKING_ACTIONS
 * 4. Guard is enabled (default true, per-agent opt-out supported)
 */
export function checkCargoSaturationBlock(
  ctx: PipelineContext,
  agentName: string,
  verb: string,
): string | null {
  // Check guard is enabled (default: true)
  const agentConfig = ctx.config.agents.find(a => a.name === agentName);
  if (agentConfig?.cargoSaturationGuardEnabled === false) return null;
  if (ctx.config.cargoSaturationGuard === false) return null;

  if (!CARGO_BLOCKING_ACTIONS.has(verb)) return null;

  const cached = ctx.statusCache?.get(agentName);
  if (!cached) return null; // Fail open — no cache data

  const data = cached.data;
  const ship = (data.ship ?? (data.player as Record<string, unknown> | undefined)?.ship ?? {}) as Record<string, unknown>;
  const cargoUsed = typeof ship.cargo_used === "number" ? ship.cargo_used : undefined;
  const cargoCapacity = typeof ship.cargo_capacity === "number" ? ship.cargo_capacity : undefined;

  if (cargoUsed === undefined || cargoCapacity === undefined || cargoCapacity === 0) return null;

  const ratio = cargoUsed / cargoCapacity;
  if (ratio < CARGO_SATURATION_THRESHOLD) return null;

  const pct = Math.round(ratio * 100);
  return (
    `CARGO_SATURATION_BLOCK: Cargo is at ${cargoUsed}/${cargoCapacity} (${pct}%). ` +
    `You cannot ${verb} until you sell or deposit cargo. ` +
    `Travel to a station (jump/travel are still available) then use sell, multi_sell, or deposit to clear space. ` +
    `If no buyer exists here, navigate to a market station first.`
  );
}
```

### 3.4 Error/Response Shape

The error is returned as `textResult({ error: "<message>" })` — identical to all other guardrail blocks. The agent sees it as a tool error, not a special message. This matches the established pattern for `self_destruct`, instability gates, and shutdown signals.

The message is self-contained: it tells the agent (a) what the problem is, (b) what actions are available (jump/travel still work), and (c) the resolution path (sell/deposit). This avoids creating a secondary loop where the agent tries to sell but has nowhere to navigate to.

### 3.5 Config Flags

**`FleetConfigSchema`** addition:
```typescript
cargoSaturationGuard: z.boolean().optional().default(true),
```

**`AgentConfigSchema`** addition:
```typescript
cargoSaturationGuardEnabled: z.boolean().optional(),
// When false, this agent bypasses the cargo saturation block (e.g. a jettison-capable combat agent)
```

**`GantryConfig`** addition:
```typescript
cargoSaturationGuard?: boolean; // global default, default true
```

Per-agent override takes precedence over global flag, consistent with how `brokeMiningOverride` and `DENIED_ACTIONS_V2` work.

### 3.6 Edge Cases

| Scenario | Behavior |
|---|---|
| No statusCache entry (login in progress) | `null` → fail open, tool passes through |
| `cargo_capacity === 0` (data not yet populated) | `null` → fail open |
| Agent is at 95% cargo but at a market station | Block fires, but `sell`/`multi_sell`/`deposit` are not in CARGO_BLOCKING_ACTIONS → agent can sell immediately |
| Agent is at 95% cargo in deep space with no seller | Block fires, but `jump`/`travel`/`jump_route` are not blocked → agent can navigate to a seller |
| Agent's cargo is legitimately unsellable (mission items, quest cargo) | Block still fires for mine/survey — agent must navigate to a mission dropoff or jettison (both non-blocked). If truly stuck, operator must opt this agent out via `cargoSaturationGuardEnabled: false` |
| `brokeMiningOverride` interplay | Broke mining override (credits < 500) bypasses ROLE denials in `agentDeniedTools`. Cargo saturation block is separate and orthogonal — a broke agent with full cargo still can't mine more. The override does NOT bypass cargo saturation. This is correct: mining with a full cargo hold would no-op or error regardless |
| v1 agent | Same `checkCargoSaturationBlock()` function, called from `checkGuardrailsV1` after the deposit guard (line ~718) |
| Prayer scripts | Prayer scripts call `handlePassthrough` directly, bypassing `checkGuardrailsV2`. Add the cargo check inside the prayer executor's `isToolDenied` callback in `gantry-v2.ts` (the lambda at line ~582). Pattern: if verb is in CARGO_BLOCKING_ACTIONS and cargo is saturated, return the block message |
| Routine execution | Routines call game tools via `routineClient.execute()` which routes through `handlePassthrough` for state-changing tools and `compoundActions` for compound tools. The cargo saturation check should be added to `compoundActions.mine` / `compoundActions.batch_mine` entry points in `compound-tools-impl.ts` as a pre-flight guard. Alternatively, add a check in the routine dispatcher. |

---

## 4. Tests to Add (bun test)

All new tests go in `server/src/proxy/pipeline.test.ts` (cargo saturation section) and `server/src/proxy/override-system.test.ts` (tighter cargo-full rule).

### 4.1 `checkCargoSaturationBlock` Unit Tests

New `describe("checkCargoSaturationBlock")` block in `pipeline.test.ts`:

```
- returns null when no statusCache entry (fail open)
- returns null when cargo_capacity is 0 (data not populated)
- returns null when cargoUsed / cargoCapacity < 0.95
- returns null at exactly 0.94 ratio
- returns error string at exactly 0.95 ratio
- returns error string at 1.0 ratio (full)
- error string contains cargoUsed, cargoCapacity, and percentage
- error string contains "jump" hint (navigation still allowed)
- error string contains "sell" or "multi_sell" resolution hint
- returns null for "sell" action even at 100% cargo
- returns null for "jump" action at 100% cargo
- returns null for "travel" action at 100% cargo
- returns null for "dock" action at 100% cargo
- returns null for "logout" action at 100% cargo
- blocks "mine" at 95% cargo
- blocks "batch_mine" at 95% cargo
- blocks "survey_system" at 95% cargo
- returns null when agentConfig.cargoSaturationGuardEnabled === false
- returns null when ctx.config.cargoSaturationGuard === false
- per-agent opt-out overrides global guard enabled
```

### 4.2 Integration with `checkGuardrailsV2`

New tests in the `checkGuardrailsV2` describe block:

```
- blocked "mine" when cargo at 95%
- allowed "mine" when cargo at 94%
- allowed "sell" regardless of cargo level
- cargo saturation block message returned as string (not null)
```

### 4.3 Tighter `cargo-full` Override Rule

In `override-system.test.ts`, update `"cargo-full"` tests:

```
- fires at 90% cargo (not just 100%)
- does not fire at 89% cargo
- cooldown is 60 seconds (not 180)
- directive wording contains "URGENT" (not "NOTICE")
```

---

## 5. Definition of Done + Verification Checklist

### Implementation Complete When:

- [ ] `checkCargoSaturationBlock()` exported from `pipeline.ts`
- [ ] Called in `checkGuardrailsV2` (and `checkGuardrailsV1` for v1 agents)
- [ ] `FleetConfigSchema` and `AgentConfigSchema` updated with opt-out flags
- [ ] `GantryConfig` type updated
- [ ] `cargo-full` override rule updated (90% threshold, 60s cooldown, URGENT wording)
- [ ] Prayer executor's `isToolDenied` callback checks cargo saturation for CARGO_BLOCKING_ACTIONS
- [ ] All tests in section 4.1, 4.2, 4.3 written and passing (`bun test`)
- [ ] `bun test` clean (no regressions)
- [ ] `tsc --noEmit` clean

### Manual Verification Checklist (post-deploy):

- [ ] Trigger a mine action on an agent with ≥95% cargo → confirm `CARGO_SATURATION_BLOCK` error in tool logs
- [ ] Confirm agent can still `sell` / `jump` / `travel` with full cargo (not blocked)
- [ ] Confirm `_overrides` injection fires at 90% with URGENT wording (soft warning precedes hard block)
- [ ] Set `cargoSaturationGuardEnabled: false` for one agent in fleet config → confirm that agent can mine with full cargo
- [ ] Observe brass-meridian / cinder-wake / rust-vane for one full turn: confirm they do not loop into mine actions after cargo saturation, and instead navigate to a station

### Metrics to Watch Post-Deploy:

- Count of `CARGO_SATURATION_BLOCK` log entries per agent per session (high count = agent is thrashing)
- Compare sell-actions-per-session before vs. after (should increase)
- Watch for new deadlock pattern: agent navigating in circles if no seller is reachable — if seen, check whether jump/travel routes are resolving correctly

---

## 6. What This Does NOT Fix

- **Frontier topology trap** (cinder-wake trigger #2): agent is in a system with no reachable station. Cargo saturation guard allows navigation, so agent can still route out. No new deadlock introduced. However, if the agent's galaxy graph is wrong or routes are broken, it may loop on `find_route` errors. That is a separate nav-graph bug, not an explore-loop issue.
- **Anti-deposit prompt rule blocking sell orders** (rust-vane trigger #3): if this is a prompt-level rule injected by the system prompt (`systemPrompt` in agent config) that says "do not deposit anything", the guardrail cannot override it — the agent will still refuse sell calls. To fix: remove the offending prompt rule. The cargo saturation guard will at minimum prevent the explore loop from continuing, forcing the agent into a state where it keeps getting blocked until the operator intervenes.
- **Override/order compliance**: Guard B was rejected. Agents can still ignore fleet orders. The cargo saturation guard is a behavioral constraint (prevents the bad outcome) rather than an order-compliance system (forces following orders). It is sufficient to stop the loop; it does not teach agents to follow orders.

---

*Plan authored 2026-05-30. Ready for implementation in an isolated worktree.*
