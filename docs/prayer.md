# PrayerLang

PrayerLang is a tiny DSL that agents can execute server-side via the `spacemolt_pray` MCP tool. Instead of burning 20 LLM turns on a mining loop, an agent writes a bounded script once and the proxy runs it to completion, returning a structured result.

Gantry's implementation is inspired by [prayer.rs](https://github.com/MatthewBlanchard/prayer.rs) by Matthew Blanchard — the idea of letting an LLM submit small deterministic programs to a trusted runtime instead of driving every step itself.

## Why

Most game loops are repetitive: mine until full, sell at haven, refuel if low, jump home. Driving those with the LLM costs tokens, creates hallucination surface area, and wastes tool calls on trivial state checks. PrayerLang scripts:

- run on the server with direct access to the agent's game state cache
- short-circuit when predicates go true (`until CARGO_PCT >= 90`)
- fail closed with a structured error the agent can read and react to
- cost one tool call per script, regardless of step count

## Invocation

Agents call the `spacemolt_pray` MCP tool:

```json
{
  "name": "spacemolt_pray",
  "arguments": {
    "script": "until CARGO_PCT >= 90 { mine here; }",
    "max_steps": 20,
    "timeout_ticks": 10
  }
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `script` | string | yes | PrayerLang source |
| `max_steps` | integer | no | Hard cap on executed statements (default 25) |
| `timeout_ticks` | integer | no | Maximum game ticks the script may span (default 8) |

The response is a structured `PrayResult` with status, steps executed, handoff reason (if any), and the final game state snapshot.

## Language

A program is a sequence of statements separated by `;`. Trailing semicolons are optional.

### Commands

| Command | Args | Notes |
|---|---|---|
| `halt` | — | Stop execution successfully |
| `wait` | `<ticks>` | Sleep for N game ticks |
| `mine` | `<destination>` | Mine at a POI; use `here` for current location |
| `go` | `<destination>` | Travel to a POI (accepts `home`, `nearest_station`, or an identifier) |
| `dock` | — | Dock at current POI |
| `undock` | — | Undock from current station |
| `refuel` | — | Refuel at current station |
| `repair` | — | Repair at current station |
| `sell` | `<item>` | Sell all of an item |
| `stash` | `<item>` | Deposit an item into storage |

Destinations and items accept bare identifiers (`haven`, `durasteel`) or the built-in macros `here`, `home`, `nearest_station`.

### Control flow

```
if <predicate> { ... }
until <predicate> { ... }
```

Predicates compare a metric against an integer using `>`, `>=`, `<`, `<=`, `==`, `!=`.

| Metric | Meaning |
|---|---|
| `FUEL` | Current fuel units |
| `CREDITS` | Current credit balance |
| `CARGO_PCT` | Cargo fill as a 0–100 integer |
| `CARGO <item>` | Quantity of one item in cargo |
| `MINED` | Count of successful `mine` steps in this script |

### Examples

Mine until cargo is 90%+ full, then dock and sell:

```
until CARGO_PCT >= 90 { mine here; }
go nearest_station;
dock;
sell nebulite;
```

Refuel only if low, then head home:

```
if FUEL < 100 { refuel; }
go home;
```

Stash everything valuable before a risky jump:

```
if CARGO durasteel > 0 { stash durasteel; }
if CARGO nebulite > 0 { stash nebulite; }
```

## Configuration

Per-agent enablement lives in the agent config block:

```json
{
  "name": "lumen-shoal",
  "prayer": { "enabled": true }
}
```

When `prayEnabled` is true, the agent's system prompt is augmented with PrayerLang instructions and the `spacemolt_pray` tool is registered in its MCP session.

## Observability

Every prayer call is logged to the `proxy_tool_calls` table with `tool_name = 'pray'`. Sub-commands dispatched by the script (mine, travel_to, dock, etc.) are logged with `parent_id` pointing at the parent prayer row, so you can expand a single prayer in the dashboard and see every step it ran.

The dashboard exposes:

- **Agent → Prayer tab** — recent prayer calls with script source, result, step-by-step subcall breakdown
- **Diagnostics → Prayer Adoption** — per-agent adoption rate (prayers per turn), success rate, avg steps, last prayer timestamp
- **Agent controls → Prayer Canary button** — one-shot verification run that boots an agent into a dedicated prompt that calls `spacemolt_pray` once, then exits. Useful when diagnosing adoption drops or verifying a prompt change landed.

## Operator endpoint

```
POST /api/prayer-canary
Body: { "agent": "<name>" }
```

Starts the named agent in canary mode. Rejects if the agent is already running.

## Prior art

[prayer.rs](https://github.com/MatthewBlanchard/prayer.rs) — the original Rust implementation that introduced the "pray to a server-side interpreter" pattern. Gantry's PrayerLang borrows the core idea (bounded deterministic scripts executed on the server with structured results) but re-implements the runtime in TypeScript and wires it to the Space Molt game-tool surface.
