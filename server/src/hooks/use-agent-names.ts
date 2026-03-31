"use client";

import { useFleetStatus } from "./use-fleet-status";

/**
 * Returns the list of agent names from the live fleet status SSE stream.
 * Updates automatically when the fleet configuration changes.
 * Falls back to an empty array until the first status event arrives.
 */
export function useAgentNames(): string[] {
  const { data } = useFleetStatus();
  // Exclude overseer — it has its own dedicated nav item and page
  return data?.agents?.map((a) => a.name).filter((n) => n !== "overseer") ?? [];
}
