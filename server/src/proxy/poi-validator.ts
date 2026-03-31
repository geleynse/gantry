/**
 * POI and system name validator backed by a live GalaxyGraph reference.
 *
 * Used to detect agent hallucinations — when an agent references a system or
 * POI name that doesn't exist in the galaxy graph. Validation is advisory only:
 * warnings are injected into tool responses but calls are never blocked, since
 * the cache may be incomplete.
 */

import type { GalaxyGraph } from "./pathfinder.js";
import { normalizeSystemName } from "./pathfinder.js";
import { systemPoiCache } from "./poi-resolver.js";

export interface PoiValidator {
  isValidSystem(name: string): boolean;
  isValidPoi(systemName: string, poiName: string): boolean;
  getSuggestions(invalidName: string): string[];
}

/** Simple Levenshtein distance for fuzzy suggestion matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : 1 + Math.min(prev, row[j], row[j - 1]);
      row[j - 1] = prev;
      prev = val;
    }
    row[n] = prev;
  }
  return row[n];
}

/**
 * Create a POI validator backed by the given GalaxyGraph.
 *
 * The graph is read at call time so topology changes from periodic refreshes
 * are reflected automatically — no separate invalidation needed.
 */
export function createPoiValidator(graph: GalaxyGraph): PoiValidator {
  // Access private fields via cast — avoids modifying GalaxyGraph while still
  // reading the live map reference (which is replaced atomically on refresh).
  const g = graph as unknown as { names: Map<string, string> };

  return {
    isValidSystem(name: string): boolean {
      // Skip validation until graph has loaded
      if (graph.systemCount === 0) return true;
      return graph.resolveSystemId(name) !== null;
    },

    isValidPoi(systemName: string, poiName: string): boolean {
      const systemId = graph.resolveSystemId(systemName);
      if (!systemId) return false;

      const pois = systemPoiCache.get(systemId);
      // No POI data cached for this system — don't flag as invalid
      if (!pois || pois.length === 0) return true;

      const norm = normalizeSystemName(poiName);
      return pois.some(
        (p) =>
          p.id === poiName ||
          normalizeSystemName(p.name) === norm ||
          normalizeSystemName(p.id) === norm,
      );
    },

    getSuggestions(invalidName: string): string[] {
      if (graph.systemCount === 0) return [];

      const norm = normalizeSystemName(invalidName);
      const candidates: Array<{ name: string; dist: number }> = [];

      for (const name of g.names.values()) {
        const namNorm = normalizeSystemName(name);
        // Substring match (distance 0) before computing Levenshtein
        if (namNorm.includes(norm) || norm.includes(namNorm)) {
          candidates.push({ name, dist: 0 });
          continue;
        }
        const dist = levenshtein(norm, namNorm);
        const threshold = Math.max(2, Math.floor(Math.max(norm.length, namNorm.length) / 3));
        if (dist <= threshold) {
          candidates.push({ name, dist });
        }
      }

      candidates.sort((a, b) => a.dist - b.dist);
      return candidates.slice(0, 3).map((c) => c.name);
    },
  };
}
