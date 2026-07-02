---
name: add-v2-action
description: Use when exposing a new game action, proxy-computed helper, or cached-data query through the v2 `spacemolt(action="...")` action-dispatch surface in gantry-v2.ts — covers the namespace/dispatch model, which of three action categories you're adding, the v1-alias and enrichment plumbing, and the canonical example commit to copy.
---

# Adding a v2 Action — Gantry Server

## 1. The dispatch model

v2 consolidates the game's tools into a handful of namespaced MCP tools —
`spacemolt` (default/core gameplay), `spacemolt_market`, `spacemolt_catalog`,
`spacemolt_storage`, `spacemolt_battle`, `spacemolt_salvage`, `spacemolt_ship`,
`spacemolt_social`, `spacemolt_facility`, `spacemolt_faction`, `spacemolt_auth`
(login/logout only, intercepted separately) — instead of 60+ individually
named v1 tools. Each namespaced tool takes an `action` string param (or, for
`spacemolt_catalog`, a `type` param) that selects the behavior:
`spacemolt(action="jump", id="sirius")`,
`spacemolt_storage(action="deposit", item_id="iron_ore", qty=10)`.

**Stale doc warning:** `AGENTS.md` says "6 namespaces." The actual v1→v2
alias table (`V1_TO_V2_DISPATCH` in `server/src/proxy/dispatch-v1-to-v2.ts`)
covers 9 distinct `spacemolt_*` tool names, and the live namespace count
isn't fixed by gantry code at all — `createGantryServerV2()` registers
whatever tool names the **live game server** advertises
(`shared.v2Tools`, fetched per-preset in `schema.ts`). Don't cite a namespace
count — grep `V1_TO_V2_DISPATCH`, or check the running server's `GET /health`
(`tools_v2` count, `v2_presets` list) for the live figures.

Most namespaced tools' `action` param is a **bare string with no enum** —
`withPrayerScriptSchema()` in `gantry-v2.ts` notes this explicitly for
`spacemolt`: "client-side Zod accepts any string... proxy actions validate
without enum injection." That means **adding a new action usually requires
zero schema changes**, just a dispatch branch. The one namespace that *does*
enum-constrain its dispatch key is `spacemolt_catalog` (`type` has a real
enum) — see §5.

## 2. Which of three categories are you adding?

**A. Proxy-computed helper action (no game-server round trip).** The action
is answered entirely from gantry's own state (SQLite, in-memory caches,
computed from existing data) — e.g. `find_local_route`, `find_item_market`,
`recent_snapshot`, `snapshot_coverage`, `craft_chains`, `arbitrage_routes`.
**This is the pattern demonstrated by the canonical example commit — see §3.**
You add an `if (action === "your_action") { ... return textResult(...); }`
branch inside the big per-tool dispatch chain in `createGantryServerV2()`
(`server/src/proxy/gantry-v2.ts`).

**B. Cached-state query (read from the WebSocket status cache, no compute).**
e.g. `get_status`, `get_cargo`. Add an extractor function to
`STATUS_SLICE_EXTRACTORS` in `server/src/proxy/cached-queries.ts` — the
generic `if (action in STATUS_SLICE_EXTRACTORS)` branch in `gantry-v2.ts`
(~line 1035) picks it up automatically, including staleness annotation and
transit-stuck detection. Don't add a bespoke `if (action === ...)` branch for
this category — that's what `STATUS_SLICE_EXTRACTORS` is for.

**C. Pure passthrough to a real game-server action.** The game server itself
already implements the action under an existing v2 namespace. **This needs
NO gantry code at all** — new actions on an already-registered tool are
auto-advertised (`shared.v2Tools`/`v2ToolSchemas` are fetched live from the
game server, not hard-coded in gantry) and auto-forwarded: the fallback at
the bottom of the dispatch chain (`gantry-v2.ts` ~line 1352,
`return handlePassthrough(...)`) forwards anything that didn't match an
earlier proxy-handled branch straight to the game server. Touch gantry code
here only if: (a) routines/compound tools need a short v1-style name for it
— add an entry to `V1_TO_V2_DISPATCH` in `dispatch-v1-to-v2.ts` (§7); (b) the
v1 WebSocket game client needs different param names than the v2 generic
`id`/`text` the agent sends — add an entry to `V2_TO_V1_PARAM_MAP` in
`schema.ts` (keyed by v1 action name, e.g. `jump: { id: "target_system" }`);
(c) it should be denied for some roles — check/edit `DENIED_ACTIONS_V2` (§7);
a brand-new game action is allowed by default (opt-out, not opt-in).

This skill is written around **category A**, since that's what the
canonical example and its follow-up commit exercise end-to-end.

## 3. Canonical example — commit `e5a68c6`

`feat(proxy): expose find_item_market as a spacemolt v2 action` touched
**one file, 14 lines**: `server/src/proxy/gantry-v2.ts`.

```typescript
// 1. Import the (already-tested) service function that does the real work.
import { getStationsForItem } from "../services/market-history.js";

// 2. Add a branch inside the existing `if (toolName === "spacemolt" && action) { ... }`
//    block (~line 1064), alongside sibling actions like find_local_route, recent_snapshot:
if (action === "find_item_market") {
  const itemId = String(args.id ?? "");
  if (!itemId) return textResult({ error: "id (item_id) is required for find_item_market" });
  const t = typeof args.text === "string" ? args.text.toLowerCase().trim() : "";
  const type = t === "buy" || t === "sell" ? t : undefined;
  const stations = getStationsForItem(itemId, { type });
  if (stations.length === 0) {
    return textResult({ item_id: itemId, stations: [], hint: "No recent station observations..." });
  }
  return textResult({ item_id: itemId, stations });
}
```

No schema change (bare-string `action`, per §1). No new test file — behavior
tests live on the underlying service, not on the dispatch branch (see §9).

**Follow-up commit `0afb57d`** (`fix(market): address dual-review findings on
per-station tracking`, same day) shows what a second-pass review catches on
this exact pattern: (1) **param-name parity** — the first version only
accepted `args.id`/`args.text` (v2 generic names), the fix widened it to
`args.id ?? args.item_id` and `args.text ?? args.type` to match the
equivalent v1-surface tool's param names — check this if a same-named
sibling exists elsewhere; (2) **6 new unit tests**, all added to the
*service* test files (`market-history.test.ts`, `market-insights.test.ts`),
none to `gantry-v2.test.ts` — confirms §9's testing guidance; (3) a
correctness bug in the service's sort comparator was caught by dual review
(Opus + Codex), not the original tests — if your action's logic has an
ordering/comparison concern, write an explicit antisymmetry/property test,
not just a black-box "returns the right items" test.

## 4. Where action names/schemas actually live

Nowhere in gantry, for the most part. `server/src/proxy/schema.ts`
(`fetchGameCommandsV2` / `resolveGameToolsV2`) fetches each namespaced tool's
real `inputSchema` from the live game server per preset, caches it to disk
(1h TTL), and `gantry-v2.ts` converts it to Zod via `serverSchemaToZod()`.
Gantry only **grafts onto** that fetched schema in two known cases, both in
`withPrayerScriptSchema()` (`gantry-v2.ts`): `spacemolt_catalog`'s `type`
enum gets `craft_chains`/`arbitrage_routes` appended (synthetic catalog
types — §5), and `spacemolt`'s schema gets `script`/`max_steps`/
`timeout_ticks`/`async` added as hints for prayer-script/`execute_routine`
params. If your new action is on `spacemolt` (or any tool without an enum'd
`action`), skip schema code entirely — just add the dispatch branch.

## 5. If your action needs an enum graft (spacemolt_catalog only)

Follow the `craft_chains`/`arbitrage_routes` precedent in
`withPrayerScriptSchema()`: append your type name to
`properties.type.enum` idempotently (guard against re-appending on repeat
calls — the function runs per registration). Then add the handling branch
keyed on `type`, e.g.
`if (toolName === "spacemolt_catalog" && action === "your_new_type") { ... }`
— dispatch code already treats `spacemolt_catalog`'s dispatch key as
`args.type`, not `args.action` (line ~699). Test the idempotency and
enum-injection the way `gantry-v2.test.ts` does for
`craft_chains`/`arbitrage_routes`.

## 6. Preset system

`mcp-factory.ts` maintains `v2SchemaByPreset: Map<string, {...}>`, populated
at startup by fetching `resolveGameToolsV2(gameUrl, preset)` per preset
referenced in fleet config. **Default preset is the first key in that map**
(`v2SchemaByPreset.keys().next().value ?? "standard"`) — `"standard"` is only
the fallback when the map is *empty*, not a hardcoded default. Per
`http-game-client-v2.ts`: `"standard"` ≈ 9 tools, `"full"` ≈ 16 (adds
`spacemolt_battle`/`spacemolt_facility`/etc). `createGantryServerV2`'s
`allowedTools` param does **advisory filtering only** — it controls what's
registered/visible to the LLM; the proxy still handles calls to unregistered
tools if they somehow arrive. A new action on an existing tool is
preset-gated the same way the tool itself is — no extra plumbing needed
unless you're introducing an entirely new namespaced tool.

## 7. v1 alias + deny-list plumbing

If routines or compound tools should reach your action via a short v1-style
name (`ctx.client.execute("your_action")`), add it to `V1_TO_V2_DISPATCH` in
`dispatch-v1-to-v2.ts`: `your_action: { tool: "spacemolt", action: "your_action" }`.
If the tool is in `TRANSLATE_TOOLS` (`spacemolt`, `spacemolt_battle`,
`spacemolt_salvage`, `spacemolt_ship`), args get renamed via the inverse of
`V2_TO_V1_PARAM_MAP` automatically; other namespaces pass args through as-is.

**Deny-list check — do this even for proxy-only actions.** `DENIED_ACTIONS_V2`
(`schema.ts`) is an opt-out blocklist checked in `pipeline.ts` *before* your
dispatch branch ever runs. A new action is reachable by default; only add it
there if it should be blocked for some agents. If grafting a new `type` onto
`spacemolt_catalog` (§5), assert in a test that it's **absent** from every
`DENIED_ACTIONS_V2` set — see `gantry-v2.test.ts`'s `"arbitrage_routes is
not in DENIED_ACTIONS_V2 (must reach agents)"` test for the pattern to copy.

## 8. Enrichment / summarizer hooks

`summarizeToolResult()` (`server/src/proxy/summarizers.ts`) and the
market/threat/cargo enrichment logic (analyze_market caching, buy hints,
stale-market warnings, threat-summary injection) all live inside
`handlePassthrough()` (`passthrough-handler.ts`) and only run for calls that
**flow through the real passthrough path** — category C actions, or category
A/B actions that explicitly call `handlePassthrough` themselves (the
`execute_routine` block routes sub-tool calls through it at ~line 928 for
this reason). A plain `return textResult({...})` from inside your
`if (action === "...")` branch (the `find_item_market` pattern) **bypasses
summarization/enrichment entirely** — your handler owns the full response
shape. If your action's response should get the same shaping as
`analyze_market`/`buy`, route it through `handlePassthrough` instead of
returning `textResult()` directly.

## 9. Testing

`gantry-v2.test.ts` is almost entirely **structural** — registration counts,
schema-injection idempotency, deny-list membership — not where per-action
behavior tests live. Test at the layer that actually has the logic:
- **Category A:** unit-test the service function directly — copy
  `server/src/services/market-history.test.ts`'s style (real SQLite via
  `createDatabase(':memory:')`, direct function calls, no MCP server).
  For handler-level coverage (arg parsing, error text), copy
  `server/src/proxy/public-tools.test.ts`'s pattern: build a mock
  `McpServer` that records `registerTool` calls into a `Map`, pull the
  handler back out, invoke it directly.
- **Category B:** add cases to `server/src/proxy/cached-queries.test.ts`
  (extractor-level, keyed by action name).
- **Category C:** if you added a `V1_TO_V2_DISPATCH` or `V2_TO_V1_PARAM_MAP`
  entry, test `dispatchV1ToV2()` / the param-map inversion directly — see
  `dispatch-v1-to-v2.test.ts` and `schema.test.ts`.
- If you touched `withPrayerScriptSchema()` (§5), assert enum-injection AND
  idempotency (calling twice shouldn't duplicate the entry) AND deny-list
  absence (§7), mirroring the three `craft_chains` tests in `gantry-v2.test.ts`.

Run targeted: `bun test src/proxy/gantry-v2.test.ts` (from `server/`) plus
whichever service test file you added cases to.

## 10. Validation checklist

1. Action added inside the correct dispatch branch for its category (§2).
2. Bare-string `action` (the common case): confirmed no unnecessary schema/
   enum graft added.
3. `spacemolt_catalog`-style enum'd dispatch key: enum extended idempotently
   in `withPrayerScriptSchema()`, handler branch keyed on `type` not `action`.
4. Not accidentally present in `DENIED_ACTIONS_V2` for its tool name — add a
   test asserting absence if the action name is generic enough to collide.
5. If needed by routines/compound tools under a v1-style name: entry added
   to `V1_TO_V2_DISPATCH` (+ `V2_TO_V1_PARAM_MAP` if param names differ).
6. Response returned via `textResult(...)` with an `error` key on failure,
   matching sibling actions' shape — or routed through `handlePassthrough`
   if it needs summarizer/enrichment treatment (§8).
7. Unit tests added at the correct layer (§9), not just structural
   assertions in `gantry-v2.test.ts`.
8. `bun test src/proxy/gantry-v2.test.ts` and the relevant service test file
   pass (from `server/`).
9. `bun run build:server` succeeds (from `server/`).
10. Update `server/docs/API.md` or in-code comments if the action should be
    agent-discoverable documentation, not just implemented.
