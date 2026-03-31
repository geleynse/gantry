# Mock Mode

Mock mode lets you test agent prompts and Gantry configuration without connecting to the live game server. When enabled, Gantry replaces the real game client with `MockGameClient`, which returns canned responses and simulates basic state changes (credits, fuel, cargo).

No game account or network connection required.

---

## Quick Start

Set `mockMode` in your `gantry.json`:

```jsonc
{
  "mockMode": true
  // ... rest of your config
}
```

Start Gantry normally. All agent tool calls will be handled by the mock client instead of the game server.

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

The mock client tracks lightweight per-agent state and mutates it as tools are called:

- `mine` / `batch_mine` — adds ore to cargo
- `refuel` — decreases credits, increases fuel
- `sell` / `multi_sell` — removes cargo items, increases credits
- `travel_to` / `navigate` — updates location
- `login` / `logout` — toggles session state

This lets you test multi-step agent flows (mine → sell → travel) with plausible state transitions, without needing the real game.

---

## Use Cases

- **Prompt development**: Iterate on agent prompts without burning API credits on game calls.
- **CI/CD testing**: Run integration tests against the full Gantry stack without network dependencies.
- **Dashboard development**: Populate the dashboard with mock agent data while working on the frontend.
- **Routine testing**: Verify routine logic (mining loops, trade cycles) against deterministic responses.
