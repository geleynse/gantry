# Drone Integration Recommendation — 2026-05-28

**Status:** Recommendation for human review. No fleet changes implied.

## Summary

SpaceMolt's bay-based drone system (v0.278.0) is now surfaced to the fleet via
`feat/gantry-drone-surface`. Eight tools are proxied: `deploy_drone`,
`recall_drone`, `load_drone`, `unload_drone`, `upload_drone_script`,
`get_drones`, `get_drone`, `set_drone_name`. This doc recommends where to
start.

---

## Recommended First Integration: Lumen-Shoal Mining Drones

**Lowest risk, clearest ROI.** Lumen-shoal is already a dedicated miner. Adding
drone-assisted mining:

- Increases yield per tick without a new agent slot.
- Attribution lands immediately: v0.329.0 added `drone_id` to `mining_yield`
  WebSocket notifications, so each drone's contribution is traceable.
- No new game mechanic to learn — lumen-shoal already knows where the belts are.

---

## Hull Selection

v0.278.0 added drone bays to 10 hull classes. In rough order of fit for a
mining-focused drone carrier:

| Hull class | Notes |
|---|---|
| `mining_*` | Purpose-built ore extraction. Most drone-bay slots per cargo ratio. First choice. |
| `freighter_*` | Highest cargo volume but fewer slots. Worth it if load-out is mostly cargo. |
| `refinery_*` | On-board refining + drone bay combo. Good for high-value ore loops. |
| `outerrim_*` | Deep-belt explorer. Pairs well with survey_system + drone mining. |
| `nebula_*` | Multipurpose. Usable but not specialized. |
| `blockade_*` | Tanky, low cargo. Defensive positioning, not yield-optimal. |
| `fighter_*` | Combat primary. Drone bays present but cargo too small. |
| `courier_*` | Speed-optimized. Wrong tradeoff for sustained mining. |
| `cargo_*` | High cargo, sparse slots. Fine for a hybrid run but not ideal. |
| `voidborn_*` | Faction-locked, hard to source. Defer. |

**Recommendation:** commission a T3 or T4 `mining_*` hull for lumen-shoal's
drone work. The existing starter hull can keep running while the commission
completes.

### Drone-Bay Module Tier

- **T2**: available from most station markets; fits T2 drones. Viable for
  early testing.
- **T3**: significant yield step-up. Worth the crafting cost once the drone
  loop is proven.
- **T4**: top-tier throughput but requires faction rep or premium sourcing.
  Defer until T3 loop is profitable.

---

## Drone-Control Skill Grind

The `drone_control` skill governs simultaneous drone count and reaction speed.
Grind notes:

- XP accrues per deploy/recall cycle. Bulk `deploy_drone(all=true)` followed
  by `recall_drone` per drone gives faster XP/tick than ad-hoc calls.
- v0.331.2 confirmed: **XP persists across server restarts.** No need to pause
  grind around maintenance windows.
- Recommended grind order: reach drone_control rank 3 before T3 bay
  installation — the yield difference below rank 3 doesn't justify the module
  cost.

---

## DroneLang Scripts vs Plain Deploy/Recall

Two modes are available:

### Plain deploy/recall (no script)

`deploy_drone(drone_id=...)` → drone mines autonomously with default behaviour →
`recall_drone(drone_id=...)`.

- No script authoring overhead.
- Proxy handles the deploy/recall cycle. Agent sees `mining_yield` events with
  `drone_id` attribution.
- Correct starting point. Ship this first.

### DroneLang scripts (`upload_drone_script`)

DroneLang lets drones react to local conditions: belt depletion, pirate
proximity, low-yield switching. Upload via `upload_drone_script(drone_id, script)`.

- Higher ceiling: scripted drones can self-redirect without round-tripping
  through the agent.
- Higher complexity: DroneLang is a separate language the fleet does not yet
  know. Agents would need prompt additions (see below) before scripting is
  safe.
- **Defer scripting until plain deploy/recall loop is stable.** Mixing both
  modes before yield attribution is validated adds unnecessary debug surface.

---

## common-rules.txt Usage Guidance (SpaceMolt-side prompts)

The following guidance should be added to the SpaceMolt agent prompt
(`common-rules.txt` or equivalent). This is a specification for the prompt
author — **Gantry does not own those prompts.**

```
## Drone Operations

- Call get_drones() before any drone action to confirm bay contents and
  deployment state.
- To mine with drones: load_drone → deploy_drone → [wait for mining_yield
  events] → recall_drone → unload_drone (if docking).
- deploy_drone(all=true) deploys every loaded drone simultaneously. Use this
  for routine mining starts; use per-drone deploy only when selectively
  activating specific drones.
- mining_yield events carry a drone_id field (v0.329.0+). Use this to track
  individual drone contributions when reporting yield.
- Do NOT upload drone scripts without operator approval. DroneLang scripting
  changes drone behaviour persistently; ad-hoc script uploads are not
  reversible without a full reload cycle.
- set_drone_name(drone_id, name) — use descriptive names (e.g. "iron-miner-1")
  so yield attribution in logs is human-readable. Names persist across restarts.
- Recall all drones before jumping or docking. Deployed drones that cannot
  follow will be left behind.
```

---

## mining_yield / drone_id Attribution

v0.329.0 added `drone_id` to `mining_yield` WebSocket notification payloads.
The Gantry `EventBuffer` stores event payloads as opaque `unknown` and returns
them verbatim — no field stripping occurs. `drone_id` is preserved end-to-end.
Verified by new tests in `event-buffer.test.ts`.

The existing `mine` tool summarizer (`summarizers.ts`) uses `discoverPick`,
which passes through all non-suppressed fields. If the game ever returns
`drone_id` in a synchronous mine response (not just the WebSocket event), it
will reach the agent without any code change.

---

## Decision Checklist

Before enabling drone mining on lumen-shoal:

- [ ] Commission T3 `mining_*` hull (or confirm existing hull has drone bay).
- [ ] Install T2 drone-bay module and load 2-3 T2 drones.
- [ ] Add drone guidance block to `common-rules.txt` (see above).
- [ ] Run one supervised session: watch `mining_yield` events for `drone_id`
      attribution, confirm recall before jump.
- [ ] After stable loop: grind drone_control to rank 3, upgrade to T3 bay.
- [ ] Evaluate DroneLang scripting only after 5+ clean automated sessions.
