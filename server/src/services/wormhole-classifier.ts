/**
 * wormhole-classifier.ts
 *
 * Classifies galaxy graph connections as either "jump" (normal short-range)
 * or "wormhole" (long-range anomalous). Classification is based on Euclidean
 * distance: connections whose length exceeds 2.5 standard deviations from
 * the mean are classified as wormholes.
 *
 * Pure function — no React or database dependencies.
 */

export type ConnectionType = "jump" | "wormhole";

export interface SystemCoords {
  id: string;
  x: number;
  y: number;
}

export interface WormholeConnection {
  systemA: string;
  systemB: string;
  distance: number;
  type: ConnectionType;
}

/**
 * Classify all connections in the galaxy graph.
 *
 * @param systems - Array of systems with coordinates
 * @param connections - Array of [systemA, systemB] pairs (deduplicated)
 * @param stdDevThreshold - Number of std devs above mean to classify as wormhole (default 2.5)
 * @returns Map keyed by "systemA:systemB" (alphabetically sorted) -> connection type
 */
export function classifyConnections(
  systems: SystemCoords[],
  connections: Array<[string, string]>,
  stdDevThreshold = 2.5,
): Map<string, ConnectionType> {
  const result = new Map<string, ConnectionType>();

  if (connections.length === 0) return result;

  const coordsById = new Map<string, { x: number; y: number }>();
  for (const sys of systems) {
    coordsById.set(sys.id, { x: sys.x, y: sys.y });
  }

  // Compute distances for all connections
  const distances: { key: string; dist: number }[] = [];
  for (const [a, b] of connections) {
    const ca = coordsById.get(a);
    const cb = coordsById.get(b);
    if (!ca || !cb) continue;

    const dx = ca.x - cb.x;
    const dy = ca.y - cb.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    distances.push({ key, dist });
  }

  if (distances.length === 0) return result;

  // Compute mean and standard deviation
  let sum = 0;
  for (const d of distances) sum += d.dist;
  const mean = sum / distances.length;

  let sumSqDiff = 0;
  for (const d of distances) {
    const diff = d.dist - mean;
    sumSqDiff += diff * diff;
  }
  const stdDev = Math.sqrt(sumSqDiff / distances.length);

  const threshold = mean + stdDevThreshold * stdDev;

  for (const d of distances) {
    result.set(d.key, d.dist > threshold ? "wormhole" : "jump");
  }

  return result;
}

/**
 * Extract just the wormhole connections from the classification result.
 * Returns array of { systemA, systemB } pairs.
 */
export function getWormholes(
  classification: Map<string, ConnectionType>,
): Array<{ systemA: string; systemB: string }> {
  const wormholes: Array<{ systemA: string; systemB: string }> = [];
  for (const [key, type] of classification) {
    if (type === "wormhole") {
      const [systemA, systemB] = key.split(":");
      wormholes.push({ systemA, systemB });
    }
  }
  return wormholes;
}
