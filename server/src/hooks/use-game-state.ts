"use client";

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

const POLL_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShipModule {
  slot_type?: string;
  item_id?: string;
  item_name?: string;
}

export interface CargoItem {
  item_id?: string;
  name?: string;
  quantity?: number;
}

export interface SkillData {
  name?: string;
  level?: number;
  xp?: number;
  xp_to_next?: number;
}

export interface EmpireStanding {
  Fame?: number;
  Criminal?: number;
  CriminalEncounters?: number;
  Love?: number;
  Hate?: number;
  Fear?: number;
  Need?: number;
}

export type Standings = Record<string, EmpireStanding>;

export interface AgentShip {
  name: string;
  class: string;
  hull: number;
  max_hull: number;
  shield: number;
  max_shield: number;
  fuel: number;
  max_fuel: number;
  cargo_used: number;
  cargo_capacity: number;
  modules: ShipModule[];
  cargo: CargoItem[];
}

export interface LifetimeStats {
  [key: string]: number | string | undefined;
}

export interface AgentGameState {
  credits: number;
  current_system: string | null;
  current_poi: string | null;
  docked_at_base: string | null;
  ship: AgentShip | null;
  faction?: {
    tag?: string;
    storage_used?: number;
    storage_capacity?: number;
  };
  home_system?: string | null;
  home_poi?: string | null;
  skills: Record<string, SkillData>;
  standings?: Standings;
  lifetime_stats?: LifetimeStats;
  data_age_s?: number;
  last_seen?: string;
}

export interface UseGameStateResult {
  data: Record<string, AgentGameState> | null;
  loading: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Fetches per-agent game state from `/api/game-state/all` on mount and
 * re-polls every `pollIntervalMs` milliseconds (default 15 s). The returned
 * `data` is a map of agent name to AgentGameState.
 *
 * @param pollIntervalMs  Polling interval in ms. Override in tests to use small
 *                        values and avoid waiting 15 s.
 */
export function useGameState(pollIntervalMs = POLL_INTERVAL_MS): UseGameStateResult {
  const [data, setData] = useState<Record<string, AgentGameState> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const result = await apiFetch<Record<string, AgentGameState>>('/game-state/all');
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch game state');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchState();
    const id = setInterval(fetchState, pollIntervalMs);
    return () => clearInterval(id);
  }, [fetchState, pollIntervalMs]);

  return { data, loading, error };
}
