# Mock Mode

Mock mode lets you test agent prompts and Gantry configuration without connecting to the live game server. When enabled, Gantry replaces the real game client with `MockGameClient`, which returns canned responses and simulates basic state changes (credits, fuel, cargo).

No game account or network connection required.

---

## Quick Start

**Option A — env var (zero-touch, recommended for CI):**

```bash
GANTRY_MOCK=1 bun dist/index.js
```

No changes to `gantry.json` needed. Uses default mock state (5000 credits, 80 fuel, docked at `nexus_station`).

**Option B — config key (fine-grained control):**

Set `mockMode` in your `gantry.json`:

```jsonc
{
  "mockMode": true
  // ... rest of your config
}
```

Start Gantry normally. All agent tool calls will be handled by the mock client instead of the game server.

**Precedence:** `mockMode` in `gantry.json` always wins. `GANTRY_MOCK=1` only activates mock mode when `mockMode` is absent from the config. If `mockMode: { enabled: false }` is set explicitly, that overrides the env var.

---

## Configuration

`mockMode` accepts either a boolean or a config object:

```jsonc
// Simple — just enable it
"mockMode": true

// Advanced — customize behavior
"mockMode": {
  "enabled": true,
  "responsesFile": "./my-responses.json",
  "tickIntervalMs": 0,
  "initialState": {
    "credits": 10000,
    "fuel": 100,
    "location": "nexus_core",
    "dockedAt": "nexus_station",
    "cargo": [
      { "item_id": "iron_ore", "quantity": 50 }
    ]
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | — | Enable mock mode. |
| `responsesFile` | string | `examples/mock-responses.json` | Path to canned response definitions. |
| `tickIntervalMs` | number | 500 | Delay (ms) for simulated tick waits. Set to `0` for instant responses. |
| `initialState` | object | See below | Starting state for each mock agent session. |

### Initial State Defaults

If `initialState` is omitted, agents start with:

| Field | Default |
|-------|---------|
| `credits` | 5000 |
| `fuel` | 80 |
| `location` | (from responses file) |
| `dockedAt` | `nexus_station` |
| `cargo` | empty |
| `cargoCapacity` | 100 |
| `hull` | 100 |
| `shield` | 50 |

---

## Canned Responses

The mock client reads tool responses from a JSON file (default: `examples/mock-responses.json`). Each key is a tool/action name, and the value is the response returned to the agent.

The `default` key is returned when no specific match exists.

You can extend the file to cover more actions or add alternate response states. See `examples/mock-responses.json` for the full format.

---

## State Simulation

The mock client tracks lightweight per-agent state and mutates it as tools are called.

### Tier-2 supported handlers (stateful)

| Tool | Behaviour |
|------|-----------|
| `login` / `logout` | Toggle session auth state |
| `get_status` | Returns full simulated status snapshot |
| `get_credits` / `get_fuel` / `get_location` / `get_cargo` / `get_cargo_summary` | Read current state |
| `get_system` | Returns mock system with POI list; patches id to requested system |
| `travel_to` | Deducts 8 fuel, updates `poi`/`dockedAt` based on POI name (station vs. belt) |
| `jump` | Moves to any target system, deducts 10 fuel, clears docked state |
| `dock` | Sets `dockedAt` and `poi` to the specified station |
| `undock` | Clears `dockedAt` |
| `mine` / `batch_mine` | Adds `iron_ore` to cargo |
| `refuel` | Deducts credits, fills fuel |
| `sell` | Single-item sell: deducts cargo, adds credits at canned price |
| `multi_sell` | Bulk sell: deducts cargo, adds credits |
| `buy` | Deducts credits, adds item to cargo |
| `repair` | Restores hull (5 cr/hp); no-op if hull already at 100 |
| `craft` | Converts `iron_ore` → `steel_plate` (2:1 ratio) |
| `view_market` | Returns canned item list with `price_buy`/`price_sell` fields |
| `view_storage` | Returns empty storage list with capacity fields |
| `get_notifications` | Returns `{ notifications: [] }` — prevents parse errors |
| `analyze_market` | Returns canned market recommendations |
| `scan` | Returns canned NPC scan result |
| `get_missions` / `captains_log_*` / `read_doc` / `write_diary` / `write_doc` | Canned or no-op |

### Tier-3 tools (canned defaults — not stateful)

The `default` fallback handles all other tools (combat, skills, forum, trade offers, etc.) with `{ status: "ok", message: "Mock response: action completed successfully." }`. These tools are intentionally not simulated — Tier 3 would require a full game ruleset.

Tools that return canned defaults only: `attack`, `get_battle_status`, `scan_and_attack`, `install_mod`, `get_skills`, `missions/*`, `forum_*`, `trade_offer`, `chat`.

This lets you test multi-step agent flows (mine → sell → travel) with plausible state transitions, without needing the real game.

---

## Use Cases

- **Prompt development**: Iterate on agent prompts without burning API credits on game calls.
- **CI/CD testing**: Run integration tests against the full Gantry stack without network dependencies.
- **Dashboard development**: Populate the dashboard with mock agent data while working on the frontend.
- **Routine testing**: Verify routine logic (mining loops, trade cycles) against deterministic responses.
