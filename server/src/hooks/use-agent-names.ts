"use client";

import { useMemo } from "react";
import { useFleetStatus } from "./use-fleet-status";

export function useAgentNames(): string[] {
  const { data } = useFleetStatus();
  const key = data?.agents?.map((a) => a.name).filter((n) => n !== "overseer").join(",") ?? "";
  return useMemo(() => (key ? key.split(",") : []), [key]);
}
