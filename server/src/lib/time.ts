/**
 * Shared timestamp utilities for the Gantry frontend.
 *
 * SQLite stores timestamps without timezone (e.g. "2026-02-24 01:19:17").
 * These helpers normalize them to UTC before parsing.
 */

/** Parse a DB timestamp string into a Date, treating bare timestamps as UTC. */
export function parseDbTimestamp(ts: string): Date {
  const normalized = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  return new Date(normalized);
}

/** Relative time string like "2h ago". */
export function relativeTime(ts: string): string {
  const diff = Math.floor((Date.now() - parseDbTimestamp(ts).getTime()) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Format as local "HH:MM:SS". */
export function formatTime(ts: string): string {
  try {
    const d = parseDbTimestamp(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  } catch {
    return "--:--:--";
  }
}

/** Format as local "Feb 24, 14:30". */
export function formatDateTime(ts: string): string {
  try {
    const d = parseDbTimestamp(ts);
    const month = d.toLocaleString("en-US", { month: "short" });
    return `${month} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch {
    return ts;
  }
}

/** Format as local "HH:MM" (no seconds). */
export function formatTimeShort(ts: string): string {
  try {
    const d = parseDbTimestamp(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  } catch {
    return ts;
  }
}

/** Format as full locale string. */
export function formatFullTimestamp(ts: string): string {
  try {
    return parseDbTimestamp(ts).toLocaleString();
  } catch {
    return ts;
  }
}

/** Check whether an ISO timestamp is within a threshold of now (default 2 minutes). */
export function isRecent(isoTimestamp: string | null | undefined, thresholdMs: number = 2 * 60 * 1000): boolean {
  if (!isoTimestamp) return false;
  const ts = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < thresholdMs;
}
