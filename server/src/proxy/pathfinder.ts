/**
 * GalaxyGraph — BFS shortest-path finder built from the public /api/map endpoint.
 *
 * The public API returns an array of systems, each with an id, name, and connections
 * (array of system IDs representing jump links). We build an adjacency list and
 * provide BFS-based shortest path finding.
 */

import { createLogger } from "../lib/logger.js";
import { persistGalaxyGraph } from "./cache-persistence.js";

const log = createLogger("pathfinder");

/**
 * Normalize a system name or ID for comparison:
 * - trim whitespace
 * - lowercase
 * - replace underscores with spaces
 *
 * This handles cases where the game returns IDs like "node_beta" but the
 * graph stores display names like "Node Beta", and vice versa.
 */
export function normalizeSystemName(name: string): string {
  return name.trim().toLowerCase().replace(/_/g, " ");
}

export interface MapSystem {
  id: string;
  name: string;
  x: number;
  y: number;
  empire?: string;
  online?: number;
  connections: string[];
}

export interface MapData {
  systems: MapSystem[];
}

export class GalaxyGraph {
  /** Adjacency list: system_id -> set of connected system_ids */
  private adj = new Map<string, Set<string>>();
  /** System names: system_id -> name */
  private names = new Map<string, string>();
  /** Background refresh interval handle */
  private refreshInterval: ReturnType<typeof setInterval> | null = null;
  /** Timestamp of last successful fetch */
  private lastFetch = 0;
  /** URL for periodic refresh */
  private refreshUrl: string | null = null;
  /** AbortController for ongoing refresh retries */
  private refreshAbort: AbortController | null = null;

  /** Set the last-fetch timestamp directly (used when restoring persisted cache). */
  setLastFetch(ts: number): void {
    this.lastFetch = ts;
  }

  addEdge(from: string, to: string): void {
    if (!this.adj.has(from)) this.adj.set(from, new Set());
    if (!this.adj.has(to)) this.adj.set(to, new Set());
    this.adj.get(from)!.add(to);
    this.adj.get(to)!.add(from);
  }

  addSystem(id: string, name: string): void {
    this.names.set(id, name);
    if (!this.adj.has(id)) this.adj.set(id, new Set());
  }

  /** Check if two systems are direct neighbors (connected by a jump link). */
  isNeighbor(from: string, to: string): boolean {
    const neighbors = this.adj.get(from);
    return neighbors ? neighbors.has(to) : false;
  }

  /** BFS shortest path from source to dest. Returns null if unreachable.
   *  Accepts either system IDs or display names — resolves names internally. */
  findRoute(source: string, dest: string): { route: string[]; jumps: number; names: string[] } | null {
    // Resolve names to IDs so callers can pass display names directly
    const srcId = this.adj.has(source) ? source : (this.resolveSystemId(source) ?? source);
    const dstId = this.adj.has(dest) ? dest : (this.resolveSystemId(dest) ?? dest);

    if (srcId === dstId) {
      return { route: [srcId], jumps: 0, names: [this.names.get(srcId) ?? srcId] };
    }

    if (!this.adj.has(srcId) || !this.adj.has(dstId)) {
      return null;
    }

    // Rebind locals to resolved IDs for BFS below
    source = srcId;
    dest = dstId;

    // BFS
    const visited = new Set<string>([source]);
    const parent = new Map<string, string>();
    const queue: string[] = [source];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = this.adj.get(current);
      if (!neighbors) continue;

      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, current);

        if (neighbor === dest) {
          // Reconstruct path
          const route: string[] = [];
          let node: string | undefined = dest;
          while (node !== undefined) {
            route.unshift(node);
            node = parent.get(node);
          }
          return {
            route,
            jumps: route.length - 1,
            names: route.map((id) => this.names.get(id) ?? id),
          };
        }

        queue.push(neighbor);
      }
    }

    return null; // Unreachable
  }

  /** Get the system name for a given ID, or the ID itself if unknown. */
  getSystemName(id: string): string {
    return this.names.get(id) ?? id;
  }

  /** Resolve a system name or ID to its canonical ID.
   *  Handles case differences, leading/trailing whitespace, and underscore vs space
   *  (e.g. "node_beta" matches display name "Node Beta"). Returns null if not found. */
  resolveSystemId(nameOrId: string): string | null {
    // Fast path: exact ID match
    if (this.adj.has(nameOrId)) return nameOrId;

    // Normalize input: trim + lowercase + underscores→spaces
    const normalized = normalizeSystemName(nameOrId);

    // Search names with the same normalization
    for (const [id, name] of this.names) {
      if (normalizeSystemName(name) === normalized) return id;
    }
    return null;
  }

  get systemCount(): number {
    return this.adj.size;
  }

  /**
   * Start periodic background refresh of the galaxy graph.
   * Non-blocking initial fetch. Compares system count to detect topology changes.
   *
   * @param url - API endpoint (defaults to public spacemolt.com)
   * @param intervalMs - Refresh interval in ms (defaults to 1 hour)
   */
  start(url = "https://game.spacemolt.com/api/map", intervalMs = 3600_000): ReturnType<typeof setInterval> {
    this.refreshUrl = url;
    // Fetch immediately (non-blocking)
    this.refreshGraph().catch(() => {});
    this.refreshInterval = setInterval(() => {
      this.refreshGraph().catch(() => {});
    }, intervalMs);
    this.refreshInterval.unref();
    return this.refreshInterval;
  }

  /**
   * Stop periodic refresh. Clears the interval timer and aborts any ongoing refresh.
   */
  stop(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    if (this.refreshAbort) {
      this.refreshAbort.abort();
      this.refreshAbort = null;
    }
  }

  /**
   * Trigger an immediate graph refresh (e.g. on game server version change).
   * Returns true if topology changed.
   */
  async forceRefresh(url?: string): Promise<boolean> {
    if (url) this.refreshUrl = url;
    log.info("forceRefresh triggered (game server version changed)");
    return this.refreshGraph();
  }

  /**
   * Force a refresh of the graph. Returns true if topology changed, false on failure or no change.
   * Uses exponential backoff; on 429, stops early.
   */
  private async refreshGraph(): Promise<boolean> {
    if (!this.refreshUrl) return false;

    // Abort any previous ongoing refresh attempt
    if (this.refreshAbort) this.refreshAbort.abort();
    this.refreshAbort = new AbortController();
    const signal = this.refreshAbort.signal;

    // Exponential backoff: 1s, 2s, 4s, 8s
    const retryDelays = [0, 1000, 2000, 4000, 8000];
    let lastErr: unknown;
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      if (signal.aborted) return false;

      if (retryDelays[attempt] > 0) {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, retryDelays[attempt]);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          });
        } catch (err) {
          return false; // Aborted during wait
        }
      }

      if (signal.aborted) return false;

      try {
        return await this._doRefresh(signal);
      } catch (err) {
        // If aborted, stop immediately
        if (err instanceof Error && err.name === "AbortError") return false;

        // If 429, don't retry — back off until next scheduled refresh
        if (err instanceof Error && err.message.includes("HTTP 429")) {
          log.warn(`rate limited (429) on attempt ${attempt + 1} — backing off until next scheduled refresh`);
          return false;
        }
        lastErr = err;
        log.warn(`refresh attempt ${attempt + 1}/${retryDelays.length} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log.error(`refresh failed after ${retryDelays.length} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    this.refreshAbort = null;
    return false;
  }

  private async _doRefresh(signal?: AbortSignal): Promise<boolean> {
    if (!this.refreshUrl) return false;

    // Merge provided signal with a timeout signal
    const timeoutSignal = AbortSignal.timeout(15_000);
    const combinedSignal = signal 
      ? (AbortSignal as any).any([signal, timeoutSignal])
      : timeoutSignal;

    const resp = await fetch(this.refreshUrl, { signal: combinedSignal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    // Read full body as text first to avoid truncated JSON parsing
    const text = await resp.text();
    let data: MapData;
    try {
      data = JSON.parse(text) as MapData;
    } catch {
      throw new Error(`Invalid JSON (${text.length} chars): ${text.slice(0, 100)}...`);
    }
      if (!data.systems || !Array.isArray(data.systems)) {
        log.warn("refresh: invalid response shape — missing systems array");
        return false;
      }

      const oldCount = this.systemCount;
      const newGraph = buildGraphFromSystems(data.systems);
      const newCount = newGraph.systemCount;
      this.lastFetch = Date.now();

      // Persist galaxy graph to database so cache survives server restart
      const edges: { from: string; to: string }[] = [];
      for (const [sysId, neighbors] of newGraph.adj) {
        for (const neighbor of neighbors) {
          if (sysId < neighbor) edges.push({ from: sysId, to: neighbor });
        }
      }
      persistGalaxyGraph(data.systems, edges, this.lastFetch);

      if (oldCount !== newCount) {
        this.adj = newGraph.adj;
        this.names = newGraph.names;
        log.info(`refresh: topology changed (${oldCount} → ${newCount} systems)`);
        return true;
      }

      return false; // No change
  }
}

/**
 * Build a GalaxyGraph from a systems array.
 */
function buildGraphFromSystems(systems: MapSystem[]): GalaxyGraph {
  const graph = new GalaxyGraph();
  for (const sys of systems) graph.addSystem(sys.id, sys.name);
  for (const sys of systems) {
    for (const conn of sys.connections) graph.addEdge(sys.id, conn);
  }
  return graph;
}

/**
 * Fetch /api/map and build a GalaxyGraph.
 * Returns the graph (possibly empty on failure) and a success flag.
 */
export async function fetchAndBuildGraph(
  url = "https://game.spacemolt.com/api/map",
): Promise<{ graph: GalaxyGraph; success: boolean }> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      log.warn(`fetch failed: HTTP ${resp.status}`);
      return { graph: new GalaxyGraph(), success: false };
    }

    const data = await resp.json() as MapData;
    if (!data.systems || !Array.isArray(data.systems)) {
      log.warn("invalid response shape — missing systems array");
      return { graph: new GalaxyGraph(), success: false };
    }

    const graph = buildGraphFromSystems(data.systems);
    log.info(`graph built: ${graph.systemCount} systems`);
    return { graph, success: true };
  } catch (err) {
    log.error(`fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return { graph: new GalaxyGraph(), success: false };
  }
}
