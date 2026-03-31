"use client";

import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import type { OverseerDecision } from "@/shared/types/overseer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OverseerStatusResponse {
  costToday: number;
  decisionsToday: number;
}

export interface UseOverseerStatusResult {
  data: OverseerStatusResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export interface UseOverseerDecisionsResult {
  data: OverseerDecision[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const STATUS_POLL_MS = 30_000;

export function useOverseerStatus(): UseOverseerStatusResult {
  const [data, setData] = useState<OverseerStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<OverseerStatusResponse>("/overseer/status");
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  return { data, loading, error, refresh: load };
}

export function useOverseerDecisions(limit = 50): UseOverseerDecisionsResult {
  const [data, setData] = useState<OverseerDecision[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<OverseerDecision[]>(
        `/overseer/decisions?limit=${limit}`
      );
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refresh: load };
}
