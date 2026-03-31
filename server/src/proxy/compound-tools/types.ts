/**
 * compound-tools/types.ts
 *
 * Shared types and interfaces for compound MCP tool implementations.
 * All compound tool functions receive dependencies via CompoundToolDeps.
 */

import type { SellLog } from "../sell-log.js";
import type { GalaxyGraph } from "../pathfinder.js";

export interface GameClientLike {
  execute: (
    tool: string,
    args?: Record<string, unknown>,
    opts?: { timeoutMs?: number; noRetry?: boolean },
  ) => Promise<{ result?: unknown; error?: unknown }>;
  waitForTick: (ms?: number) => Promise<void>;
  lastArrivalTick: number | null;
  /** Optional: wait for the game's deferred "ok" (arrival_tick) signal.
   *  If provided, waitForNavCacheUpdate uses this instead of polling get_status. */
  waitForNextArrival?: (beforeTick: number | null, timeoutMs?: number) => Promise<boolean>;
  /** Optional: wait for the game tick to reach a specific value.
   *  Used to wait until the ship actually arrives at the arrival_tick. */
  waitForTickToReach?: (targetTick: number, timeoutMs?: number) => Promise<boolean>;
}

/** Dependencies injected into compound tool functions. */
export interface CompoundToolDeps {
  client: GameClientLike;
  agentName: string;
  /** Per-agent game state cache (populated by WebSocket state_update / polling). */
  statusCache: Map<string, { data: Record<string, unknown>; fetchedAt: number }>;
  /** Per-agent battle state (may be null when not in combat). */
  battleCache: Map<string, BattleStateForCache | null>;
  /** Sell log for fleet deconfliction. */
  sellLog: SellLog;
  /** Galaxy pathfinder graph. */
  galaxyGraph: GalaxyGraph;
  /** Persist battle state to SQLite (pass-through; no-op is fine for tests). */
  persistBattleState: (agentName: string, state: BattleStateForCache | null) => void;
  /** Persist a combat report note (used for combat alerts; may be a no-op). */
  upsertNote: (agentName: string, type: string, content: string) => void;
  /**
   * Per-agent event buffers. Optional — used by jump_route to detect pirate_combat
   * events mid-flight and abort the jump sequence early.
   */
  eventBuffers?: Map<string, { events?: Array<{ type: string }> }>;
}

export interface BattleStateForCache {
  battle_id: string;
  zone: string;
  stance: string;
  hull: number;
  shields: number;
  target: unknown;
  status: string;
  updatedAt: number;
}

export interface MultiSellItem {
  item_id: string;
  quantity: number;
}

/** Opaque result shape — callers JSON-encode this for the agent. */
export type CompoundResult = Record<string, unknown>;
