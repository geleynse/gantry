/**
 * Combat encounter grouping utilities (#228).
 * Pure functions — no React, no Next.js dependencies.
 */

import type { Encounter } from "@/components/encounter-card";

export type GroupBy = "flat" | "agent" | "system";

/**
 * Group a flat list of encounters by a key.
 * Returns ordered pairs of { key, encounters[] }.
 *
 * - "flat": single group with key "__flat__", all encounters preserved in order
 * - "agent": one group per distinct agent name
 * - "system": one group per distinct system name (null system → "Unknown")
 */
export function groupEncounters(
  encounters: Encounter[],
  groupBy: GroupBy
): Array<{ key: string; encounters: Encounter[] }> {
  if (groupBy === "flat") {
    return [{ key: "__flat__", encounters }];
  }

  const keyFn =
    groupBy === "agent"
      ? (e: Encounter) => e.agent
      : (e: Encounter) => e.system ?? "Unknown";

  const map = new Map<string, Encounter[]>();
  for (const enc of encounters) {
    const k = keyFn(enc);
    let group = map.get(k);
    if (!group) { group = []; map.set(k, group); }
    group.push(enc);
  }

  return Array.from(map.entries()).map(([key, encs]) => ({ key, encounters: encs }));
}
