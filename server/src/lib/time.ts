/**
 * Shared timestamp utilities for the Gantry frontend.
 *
 * SQLite stores timestamps without timezone (e.g. "2026-02-24 01:19:17").
 * These helpers normalize them to UTC before parsing.
 *
 * App-wide convention:
 *   - `formatAbsolute(ts)` → "Apr 24 13:58:25" — month abbrev + 24h HH:MM:SS
 *     (preferred for tables, detail views, audit-style displays).
 *   - `relativeTime(ts)` → "2m ago" — preferred for activity feeds, recency.
 *   - `formatWithTooltip(ts)` returns `{ display, tooltip }` so a cell can
 *     show one form and surface the other on hover.
 *
 * Anything that previously called `Date#toLocaleString`,
 * `Date#toLocaleTimeString`, or `Date#toLocaleDateString` should migrate to
 * one of these helpers — see `formatAbsolute` for the canonical absolute
 * representation.
 */

/** Accepts strings (DB or ISO), Date instances, or epoch milliseconds. */
type TimeInput = string | number | Date | null | undefined;

/** Parse a DB timestamp string into a Date, treating bare timestamps as UTC. */
export function parseDbTimestamp(ts: string): Date {
  const normalized = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  return new Date(normalized);
}

/** Coerce anything we accept into a Date, handling the bare-DB-timestamp case. */
function toDate(input: TimeInput): Date | null {
  if (input == null) return null;
  if (input instanceof Date) {
    return Number.isFinite(input.getTime()) ? input : null;
  }
  if (typeof input === "number") {
    const d = new Date(input);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  // string
  const d = parseDbTimestamp(input);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Relative time string like "2h ago". Accepts string|Date|number. */
export function relativeTime(input: TimeInput): string {
  const d = toDate(input);
  if (!d) return "—";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 0) return "—";
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

/**
 * Canonical absolute timestamp — "Apr 24 13:58:25".
 *
 * Use this for tables, detail rows, tooltips, and any other surface that
 * previously called `toLocaleString()` for an at-a-glance time. We
 * deliberately omit the year (rare to need it) and any timezone abbreviation
 * (already implied by the local-time rendering).
 */
export function formatAbsolute(input: TimeInput): string {
  const d = toDate(input);
  if (!d) return "—";
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Date-only canonical form — "Apr 24". */
export function formatDate(input: TimeInput): string {
  const d = toDate(input);
  if (!d) return "—";
  const month = d.toLocaleString("en-US", { month: "short" });
  return `${month} ${d.getDate()}`;
}

/**
 * Pair an absolute timestamp with a relative tooltip (or vice versa).
 *
 * Default behaviour: show absolute, tooltip with relative. Pass
 * `primary: "relative"` for activity feeds where relative is the headline.
 */
export function formatWithTooltip(
  input: TimeInput,
  primary: "absolute" | "relative" = "absolute",
): { display: string; tooltip: string } {
  const abs = formatAbsolute(input);
  const rel = relativeTime(input);
  return primary === "absolute"
    ? { display: abs, tooltip: rel }
    : { display: rel, tooltip: abs };
}

/** Check whether an ISO timestamp is within a threshold of now (default 2 minutes). */
export function isRecent(isoTimestamp: string | null | undefined, thresholdMs: number = 2 * 60 * 1000): boolean {
  if (!isoTimestamp) return false;
  const ts = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < thresholdMs;
}
