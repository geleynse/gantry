# Compound Tools

Compound tools are Gantry's most valuable feature. They let an agent accomplish a multi-step game sequence — with tick waits, error recovery, and state checking built in — using a single tool call.

Without compound tools, an agent mining ore needs to call `mine`, wait for the tick, check cargo, call `mine` again, repeat 20 times, then call `get_cargo` to confirm. That's 40+ tool calls costing 40+ context window entries. With `batch_mine`, it's one call.

## Available Compound Tools

| Tool | What it does |
|------|-------------|
| [`batch_mine`](#batch_mine) | Mine N times, wait for ticks, stop if cargo full |
| [`travel_to`](#travel_to) | Undock, travel to destination, dock |
| [`jump_route`](#jump_route) | Multi-hop jump sequence with auto-refuel |
| [`multi_sell`](#multi_sell) | Sell multiple items, check demand, deconflict with fleet |
| [`scan_and_attack`](#scan_and_attack) | Full combat loop: scan, target, battle, loot |
| [`loot_wrecks`](#loot_wrecks) | Scan for wrecks and salvage them |
| [`battle_readiness`](#battle_readiness) | Pre-combat check: hull, fuel, ammo, threats |
| [`flee`](#flee) | Exit combat and travel to safety |

All compound tools are registered on the `/mcp/v2` endpoint and available to any agent with the `full` preset.

---

## batch_mine

Mine a location repeatedly. Waits for the game tick after each mine action, stops early if cargo is full.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `count` | integer | yes | Number of mine attempts (1–50) |

### Example

```json
{
  "action": "batch_mine",
  "count": 20
}
```

### Response

```json
{
  "status": "completed",
  "mined": [...],
  "mines_completed": 18,
  "cargo_after": { "items": [...], "used": 45, "capacity": 50 },
  "stopped_reason": "cargo_full"
}
```

`stopped_reason` is present only when mining stopped before reaching `count`. Values: `"cargo_full"` (no space left), `"error"` (game returned an error mid-sequence).

### When to Use

Use `batch_mine` any time you're at a mining location (asteroid belt, gas cloud) and want to fill cargo. Set `count` high (20–50) and let the tool stop itself when cargo is full.

Do not use raw `mine` calls in a loop — that burns context window and can miss tick waits.

### Notes

- Only asteroid belts and belt POIs (those with "belt" or "harvesters" in their ID) produce ore. Gas clouds do not.
- Cargo check runs every 5 mines to avoid excess status queries.
- If the first mine fails, the error is returned immediately (no partial results).

---

## travel_to

Travel to a Point of Interest and optionally dock. Handles auto-undock if the agent is docked, resolves POI names to IDs, and waits for the game state to update after travel.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `destination` | string | yes | POI ID or human-readable name (e.g., `"Sol Station"`, `"poi_0041_002"`) |
| `dock` | boolean | no | Whether to dock on arrival. Default: auto-detected from destination type |

### Example

```json
{
  "action": "travel_to",
  "id": "Sol Station"
}
```

### Response

```json
{
  "status": "completed",
  "steps": [
    { "action": "travel", "result": { ... } },
    { "action": "dock", "result": { ... } }
  ],
  "location_after": {
    "system": "sol_prime",
    "poi": "poi_0041_002",
    "docked_at": "poi_0041_002"
  },
  "elapsed_ms": 3200
}
```

### When to Use

Use `travel_to` instead of calling `undock` + `travel` + `dock` separately. It correctly handles:

- Agent already undocked (skips undock call)
- POI name resolution (`"Sol Station"` → `"poi_0041_002"`)
- Tick waits after travel and after dock

Do not use `travel_to` for inter-system jumps — use `jump_route` for that.

---

## jump_route

Execute a multi-hop jump sequence across systems. Auto-refuels when fuel drops below a threshold, handles auto-undock before the first jump, and waits for arrival ticks to confirm each jump.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `systems` | string[] | yes | Ordered list of system IDs to jump through (max 30) |
| `fuel_threshold` | integer | no | Minimum fuel % before auto-refuel stop. Default: `20` |

### Example

```json
{
  "action": "jump_route",
  "id": "nexus_core,void_reach,ember_drift"
}
```

(System IDs are comma-separated in the v2 action-dispatch interface.)

### Response

```json
{
  "status": "completed",
  "jumps": [
    { "system": "nexus_core", "result": { ... } },
    { "system": "void_reach", "result": { ... } },
    { "system": "ember_drift", "result": { ... } }
  ],
  "jumps_completed": 3,
  "elapsed_ms": 12400
}
```

If the route was interrupted (fuel too low, error), `stopped_reason` is present:

```json
{
  "status": "partial",
  "jumps_completed": 1,
  "stopped_reason": "low_fuel",
  "jumps": [...]
}
```

### When to Use

Use `jump_route` when navigating to a distant system. Get the route first with `find_route` (returns an ordered list of system IDs), then pass the list to `jump_route`.

### Notes

- The proxy remaps `target_system` → `system_id` internally. Agents should use `target_system` in their tool calls; Gantry handles the remap.
- Jump arrival is detected by watching the game's `arrival_tick` field. The proxy waits up to 8 ticks for the nav cache to update.
- Auto-undock runs only if the agent is docked at a station. If already undocked in space, the sequence starts immediately.
- Fuel check runs every 10 jumps from the status cache (not a fresh query).

---

## multi_sell

Sell multiple items in sequence at the current station. Checks that the agent called `analyze_market` first (to verify demand), waits for each sell tick, and warns the fleet about potential demand saturation.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `items` | object[] | yes | Items to sell. Each: `{ "item_id": string, "quantity": number }` |

### Prerequisite

`analyze_market` must be called before `multi_sell` in the same turn. The proxy blocks the sell if this check fails:

```json
{
  "error": "You must call analyze_market() first to check station demand before selling. Selling without demand earns 0 credits."
}
```

### Example

```json
{
  "action": "multi_sell",
  "id": "copper_ore,iron_ore",
  "count": "45,30"
}
```

### Response

```json
{
  "status": "completed",
  "sells": [
    { "item_id": "copper_ore", "quantity": 45, "result": { ... } },
    { "item_id": "iron_ore", "quantity": 30, "result": { ... } }
  ],
  "items_sold": 2,
  "credits_after": 18450
}
```

If the sell earned 0 credits (no station demand), a warning is included:

```json
{
  "warning": "0 credits earned — this station has no demand for your items. Your items were auto-listed as sell orders on the exchange (not direct sales). Travel to a different station with demand, or use analyze_market() to find buyers."
}
```

If another fleet member recently sold the same item here:

```json
{
  "fleet_sell_warning": "agent-bravo sold copper_ore (×45) here 12 min ago. Demand may be reduced."
}
```

### When to Use

Use `multi_sell` whenever you need to sell cargo. Never call raw `sell` in a loop — `multi_sell` handles ticks, demand checking, and fleet coordination automatically.

### Notes

- The demand check (`analyze_market` prerequisite) is enforced at the proxy level. Agents cannot bypass it.
- Fleet deconfliction is advisory only — it warns agents but does not block the sale.
- Sells at stations with no demand auto-create exchange orders. The items are safe but credits don't arrive until another player fills the order.

---

## scan_and_attack

Full combat loop. Scans nearby space for targets, selects one (or uses the agent's specified target), initiates battle, runs the battle loop until victory or defeat, and auto-loots wrecks if available.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `target` | string | no | Specific target username or player ID. If omitted, auto-selects |
| `stance` | string | no | Combat stance: `"aggressive"`, `"defensive"`, `"evasive"`. Default: `"aggressive"` |

### Example

```json
{
  "action": "scan_and_attack",
  "id": "pirate_npc_42"
}
```

### Response (victory)

```json
{
  "status": "victory",
  "target": "pirate_npc_42",
  "rounds": 7,
  "hull_after": 72,
  "loot": { ... },
  "battle_duration_ms": 28400
}
```

### Response (defeat)

```json
{
  "status": "defeat",
  "target": "pirate_npc_42",
  "rounds": 3,
  "hull_after": 0,
  "message": "Ship destroyed. Insurance payout initiated."
}
```

### Safe Zone Detection

Before initiating combat, `scan_and_attack` checks whether the current system is a safe zone. If the agent is in a protected system (starter systems, faction capitals), the tool returns an error:

```json
{
  "error": "Cannot initiate combat in safe zone (system: sol_prime)"
}
```

### When to Use

Use `scan_and_attack` when you want to hunt pirates or attack other players. Call `battle_readiness` first to confirm your ship is fit for combat.

Do not use raw `attack` + `battle` loops — `scan_and_attack` handles the full battle cycle including NPC auto-aggro detection and wreck cleanup.

### Notes

- Fleet-mate protection: The tool maintains a list of fleet agent names and will never select them as targets.
- Maximum battle ticks: 30. If battle hasn't resolved after 30 ticks, the tool returns a `"timeout"` status.
- Auto-loot: After a victory, `scan_and_attack` automatically calls `loot_wrecks` if wrecks are present.

---

## loot_wrecks

Scan for wrecks in the current location and salvage them.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `count` | integer | no | Maximum wrecks to salvage (1–10). Default: `5` |

### Example

```json
{
  "action": "loot_wrecks",
  "count": 5
}
```

### Response

```json
{
  "status": "completed",
  "wrecks_found": 3,
  "salvaged": [
    { "wreck_id": "wreck_001", "status": "looted", "loot": { ... } },
    { "wreck_id": "wreck_002", "status": "looted", "loot": { ... } },
    { "wreck_id": "wreck_003", "status": "empty" }
  ],
  "cargo_after": { ... }
}
```

If no wrecks are found:

```json
{
  "status": "no_wrecks",
  "wrecks_found": 0
}
```

### When to Use

Use `loot_wrecks` after combat, or when passing through a battle site. `scan_and_attack` calls this automatically after a victory, so you only need to call it manually when visiting a pre-existing wreck field.

---

## battle_readiness

Synchronous check of combat readiness. Reads from the agent's cached status — no game API calls. Returns hull, fuel, ammo status, and nearby threats.

### Parameters

None.

### Example

```json
{
  "action": "battle_readiness"
}
```

### Response (ready)

```json
{
  "ready": true,
  "hull": 95,
  "fuel": 78,
  "ammo": [
    { "id": "kinetic_ammo", "qty": 40 },
    { "id": "explosive_ammo", "qty": 20 }
  ],
  "location": { "system": "void_reach", "poi": "asteroid_belt_001" },
  "nearby_threats": 2,
  "total_nearby": 5,
  "issues": "All clear — ready to fight"
}
```

### Response (not ready)

```json
{
  "ready": false,
  "hull": 25,
  "fuel": 15,
  "ammo": "NONE",
  "issues": [
    "Hull critical (25%) — dock for repairs first",
    "Low fuel (15%) — refuel before combat",
    "No ammo in cargo — kinetic/explosive weapons won't fire"
  ]
}
```

### When to Use

Call `battle_readiness` before `scan_and_attack`. If `ready` is false, address the issues (dock for repairs, refuel, buy ammo) before engaging.

### Notes

- Reads from the status cache — fast, no API call required.
- Ammo detection looks for items with `"ammo"` in their item ID. Non-kinetic weapons (lasers, plasma) don't require ammo.
- Hull thresholds: `< 30%` = critical, `< 60%` = low but manageable.

---

## flee

Exit an active battle and travel to safety.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `destination` | string | no | Safe POI to flee to. If omitted, uses nearest station |

### Example

```json
{
  "action": "flee"
}
```

### Response

```json
{
  "status": "escaped",
  "destination": "nexus_core_station",
  "hull_after": 42,
  "steps": [
    { "action": "evade", "result": { ... } },
    { "action": "travel", "result": { ... } },
    { "action": "dock", "result": { ... } }
  ]
}
```

### When to Use

Use `flee` when your agent is in combat and hull is critically low. The tool switches to evasive stance, disengages from battle, and travels to a safe location.

---

## Error Handling

All compound tools follow the same error model:

- If the **first step fails** and no partial results exist, an `error` field is returned at the top level.
- If the **sequence is partially complete**, a `stopped_reason` field explains why.
- **Cooldown errors** mid-sequence are retried once; if they persist, the sequence stops with `stopped_reason: "cooldown"`.
- **Unexpected game errors** (not cooldowns) stop the sequence immediately and include the raw error in `last_error`.

Example partial failure:

```json
{
  "status": "partial",
  "mines_completed": 7,
  "stopped_reason": "error",
  "last_error": { "code": "location_changed", "message": "You are no longer at a mining location" },
  "cargo_after": { ... }
}
```

## Extending Compound Tools

To add a new compound tool:

1. Implement the function in `server/src/proxy/compound-tools-impl.ts`. Follow the existing pattern: accept `CompoundToolDeps` as the first argument, return `CompoundResult`.

2. Register it in `server/src/proxy/tool-registry.ts` alongside the other compound tool registrations.

3. Add the tool to the schema in `server/src/proxy/schema.ts` so agents can see it in the tool list.

4. Add tests in `server/src/proxy/compound-tools-impl.test.ts`.

See the existing `batchMine` implementation as the canonical example — it shows the tick-wait pattern, early-exit logic, and result shape.
