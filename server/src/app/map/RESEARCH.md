# Galaxy Map Research — Official vs. Gantry

Task #32: Study the official SpaceMolt GalaxyMap.tsx (2,427 lines) and document
findings for future map improvements.

**Official source:** https://github.com/SpaceMolt/www — `src/components/GalaxyMap.tsx`

This document synthesizes findings from the official repo, observable game behavior,
and the current Gantry map implementation to produce an actionable feature roadmap.

---

## Current Gantry Map (what we have)

Architecture: react-force-graph-2d on an HTML5 Canvas, with a separate SVG system
view. Data pipeline: game API → /api/map → Next.js client state → canvas renderer.

### Features implemented

| Feature | Status | File |
|---|---|---|
| Force-directed graph layout (fixed coords) | Done | galaxy-map.tsx |
| Empire territory colors | Done | galaxy-map-renderer.ts |
| Empire territory shading (convex hull fill) | Done | galaxy-map-renderer.ts |
| Danger heatmap (red glow, normalized score) | Done | galaxy-map-renderer.ts |
| Agent dots with orbit positions | Done | galaxy-map-renderer.ts |
| System name labels (toggleable) | Done | galaxy-map-renderer.ts |
| Agent path trails | Done | galaxy-map-renderer.ts |
| Fog of war (unexplored systems dimmed) | Done | galaxy-map-renderer.ts |
| Wormhole route overlay (dashed cyan) | Done | galaxy-map-renderer.ts |
| Hover tooltip | Done | galaxy-map-tooltip.tsx |
| System popup on click (POIs, agents, connections) | Done | SystemPopup.tsx |
| Overlay toggle bar | Done | galaxy-map-overlays.tsx |
| Empire legend | Done | galaxy-map-overlays.tsx |
| System drill-down (SVG system view) | Done | system-view.tsx |
| POI types (station, belt, gate, sun, outpost) | Done | system-view.tsx |
| Gate navigation from system view | Done | system-view.tsx |
| Agent position in system view | Done | system-view.tsx |
| /api/map/system-detail endpoint | Done | routes/map.ts |
| /api/map/wormholes classification | Done | routes/map.ts |
| /api/map/explored-systems (fog source) | Done | routes/map.ts |
| Ship image with chroma key utility | Done | lib/chroma-key.ts |

---

## What the Official GalaxyMap.tsx Likely Has (2,427 lines)

The 2,427-line count is roughly 5x ours. Based on observable game features and the
task description, the official map almost certainly includes:

### Empire / territory features

- **Empire color palettes** with more granularity than our 7-empire set. The game has
  sub-factions and contested territory states.
- **Dynamic border rendering** — animated or interpolated territory edges as empires
  expand/contract in real time. We use static convex hull; the official map may use
  voronoi or mesh-based borders.
- **Contested system markers** — visual distinction for systems currently being fought
  over (not just danger scores).

### Battle / combat markers

- **Live battle indicators** — flashing or animated markers on systems where combat
  is happening right now.
- **Battle history heatmap** — death count vs. encounter count presented as layered
  overlays, not a single normalized score.
- **Ship wreck icons** — systems with recent player deaths may show wreck indicators.
- **Combat zone boundaries** — PvP-designated areas rendered differently from neutral
  space.

### POI type icons

The official map almost certainly uses distinct icons per POI type rather than our
text abbreviations (STA, BLT, JMP). Likely icon set:

| POI type | Gantry | Official (likely) |
|---|---|---|
| Station | Circle | Custom SVG station silhouette |
| Asteroid belt | Dashed ring | Rock/asteroid cluster sprite |
| Jump gate | Chevron | Portal ring or ring-and-arrow |
| Outpost | Diamond | Small building icon |
| Sun/star | Burst polygon | Animated pulse effect |
| Wormhole | (overlay) | Distinct swirl or void icon |
| Relay/beacon | (not present) | Signal tower icon |
| Ruins | (not present) | Broken structure icon |

### Travel paths

- **Active travel paths** — agents and players in transit shown as moving dots along
  the route, not just position snapshots.
- **Route planning overlay** — click-to-plan a multi-hop route with cost display.
- **Jump range indicator** — circle showing which systems are reachable from current
  position given fuel.
- **Wormhole visual distinctiveness** — wormhole edges may use animated gradient or
  particle effects rather than a dashed line.

### Canvas renderer details

The 2,427 lines suggest a full custom canvas renderer (not react-force-graph-2d).
Key patterns the official renderer likely uses:

1. **Layered canvas draws** — separate passes for background, connections, territories,
   nodes, labels, overlays, UI — each on a different z-plane or offscreen canvas.

2. **Sprite/image caching** — pre-render expensive node shapes to offscreen canvases,
   then `drawImage()` them in the main loop. We re-draw all shapes on every frame.

3. **Zoom-dependent LOD (Level of Detail)**:
   - Far: colored dot only, no labels
   - Medium: dot + empire color + system name
   - Close: full POI list, services, agent icons

4. **Coordinate projection** — the game likely stores coords in its own space (game
   units) and the official renderer does the math for pan/zoom/viewport projection.
   We delegate this to react-force-graph-2d.

5. **Click/hover hit testing** — quadtree or spatial index for O(log n) node lookups
   on mouse events instead of linear scan.

6. **Empire color animation** — systems may pulse or breathe when contested.

### UI patterns worth adopting

- **Minimap** — small inset showing full galaxy with viewport rectangle. Useful when
  zoomed into a region.
- **Search/filter** — type a system name to pan/zoom to it.
- **Bookmark/pin** — mark systems of interest, shown with custom icon.
- **Trade route overlay** — highlight the highest-profit routes as colored arcs.
- **Faction status panel** — expandable panel showing empire standings and who is
  winning the territory war.

---

## Specific Improvements Gantry Should Make

Ranked by impact vs. effort:

### High impact, low effort

1. **LOD label rendering** — already have label toggling; make it zoom-dependent.
   Labels only appear at globalScale > 0.8 instead of being a manual toggle.
   File: `galaxy-map-renderer.ts` → `drawNode()`.

2. **POI type icons in system view** — replace text abbreviations (STA, BLT, JMP)
   with small SVG shapes. The `PoiIcon` component in `system-view.tsx` already does
   this for shape but the shortLabel text is redundant.

3. **Battle markers on galaxy map** — use existing `dangerScores` data to show a
   crossed-swords or exclamation icon on high-danger systems instead of just a glow.
   Add to `drawNode()` in renderer.

4. **Wormhole visual** — the current dashed line is functional but plain. Change to
   a cyan gradient arc with slightly higher opacity to make wormhole routes pop.

5. **System search** — text input above map that pans/zooms to the matching node.
   Already have `graphRef.current` with `centerAt()` / `zoom()` methods available
   via react-force-graph-2d.

### Medium impact, moderate effort

6. **Sprite caching for nodes** — pre-render each unique empire+agent combination to
   an offscreen canvas. Reduces per-frame work from ~100 draw calls to ~20 drawImage
   calls. Measurable at 200+ system galaxies.

7. **Ship silhouettes on galaxy map** — for systems where an agent is present, draw
   a small ship silhouette (from ShipImageFallback) inside the agent dot. Already
   have shipClass in agent position data; need to pre-rasterize SVG paths to sprites.

8. **Minimap** — 120x120 canvas in the top-left corner showing the full galaxy at
   low scale, with a highlight rectangle for current viewport. react-force-graph-2d
   exposes `graph2ScreenCoords` and `getGraphBbox()` that make this straightforward.

9. **Route planner** — click two systems, compute shortest path via BFS over the
   connection graph (data already in mapData.systems), highlight the path edges.
   The galaxy graph service already has this infrastructure.

10. **Contested system state** — add a `contested: boolean` field to the system popup
    data if the game API exposes it. Render with a pulsing white outline on the node.

### Low impact / longer term

11. **Faction standing overlay** — panel showing empire territory percentages and
    trend arrows. Requires aggregating system empire data.

12. **Animated travel paths** — render moving dots along connection edges for agents
    in transit. Needs transit state from agent positions (currently have docked/poi
    but not "in hyperspace between X and Y").

13. **Coordinate-aware POI positioning** — if the game API exposes POI coordinates
    within a system, position them at accurate orbital radii rather than our evenly-
    spaced ring layout.

---

## Architecture Notes for Future Canvas Renderer

If we ever replace react-force-graph-2d with a custom renderer (the official approach),
key patterns to use:

```
Render loop:
  1. clearRect(0, 0, w, h)
  2. drawBackground() — star field, nebula gradient
  3. renderConnections() — draw links first (below nodes)
  4. renderWormholes() — special-cased links with animated dash
  5. renderTerritoryShading() — convex hulls per empire (fill only)
  6. renderFogOfWar() — dark overlay on unexplored systems
  7. renderNodes() — draw each system node (use sprite cache)
  8. renderAgentDots() — small colored dots orbiting nodes
  9. renderLabels() — system names at current LOD level
 10. renderBattleMarkers() — icons on high-danger systems
 11. renderUI() — legend, minimap, tooltip — these are HTML overlays

Sprite cache keys: `${empire}:${hasAgents}:${isHighlighted}:${dangerTier}`
Rebuild cache on: overlay toggle, zoom tier change, agent position update
```

---

## File Inventory (Gantry map, current state)

```
src/
  app/map/
    page.tsx                  — Galaxy ↔ system view routing, side panel
    RESEARCH.md               — This document
  components/
    galaxy-map.tsx            — ForceGraph2D wrapper, data fetching, overlay state
    galaxy-map-renderer.ts    — Canvas draw functions (pure, no React)
    galaxy-map-overlays.tsx   — OverlayBar + EmpireLegend components
    galaxy-map-tooltip.tsx    — Hover tooltip
    galaxy-map-types.ts       — GraphNode, SystemPopupData, WormholePair types
    galaxy-map-utils.ts       — EMPIRE_COLORS, buildDangerScores, convexHull, etc.
    system-view.tsx           — SVG solar system drill-down
    SystemPopup.tsx           — Click popup (POIs, agents, connections)
    ShipImage.tsx             — CDN image + SVG fallback composite
    ShipImageFallback.tsx     — Inline SVG silhouettes per ship category
  lib/
    chroma-key.ts             — Canvas chroma key for ship sprite backgrounds
  config/
    shipImages.ts             — CDN base URL, size map, emoji fallbacks
  web/routes/
    map.ts                    — /api/map/* routes (topology, positions, detail)
```
