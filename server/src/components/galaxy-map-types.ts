/**
 * galaxy-map-types.ts
 *
 * Shared types for the galaxy map components. Centralizes the GraphNode
 * interface that was previously duplicated across galaxy-map.tsx,
 * galaxy-map-tooltip.tsx, and galaxy-map-renderer.ts.
 */

export interface GraphNode {
  id: string;
  name: string;
  x: number;
  y: number;
  empire: string;
  hasAgents: boolean;
  agents: string[];
}

/** Data returned by GET /api/map/system-detail */
export interface SystemPopupData {
  id: string;
  name: string;
  empire: string | null;
  x: number;
  y: number;
  pois: Array<{
    id: string;
    name: string;
    type: string | null;
    services: string[];
  }>;
  agents: Array<{
    name: string;
    poi: string | null;
    docked: boolean;
    shipClass: string | null;
  }>;
  connections: Array<{
    id: string;
    name: string;
    empire?: string;
  }>;
}

/** Wormhole pair returned by GET /api/map/wormholes */
export interface WormholePair {
  systemA: string;
  systemB: string;
}
