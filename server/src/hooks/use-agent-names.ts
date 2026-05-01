"use client";

import { useMemo } from "react";
import { useFleetStatus } from "./use-fleet-status";

/**
 * Returns the list of agent names from the live fleet status SSE stream.
 * Updates automatically when the fleet configuration changes.
 * Falls back to an empty array until the first status event arrives.
 *
 * The returned array is referentially stable across renders when the agent
 * names haven't changed, which matters for `useEffect`/`useCallback` dep
 * arrays — a fresh array each render previously caused render loops on
 * pages that fan-out per-agent fetches (e.g. /missions).
 */
export function useAgentNames(): string[] {
  const { data } = useFleetStatus();
  const names = data?.agents?.map((a) => a.name).filter((n) => n !== "overseer") ?? [];
  // Stabilize identity by joining → memoizing on the joined string.
  const key = names.join(",");
  return useMemo(() => key.length === 0 ? [] : key.split(","), [key]);
}
