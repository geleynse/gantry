/**
 * Pure helpers for the Routines page. Lives in its own module so the
 * page.tsx file only exports a default Page component (Next.js
 * convention) and so the helpers are unit-testable without rendering.
 */

/** Abbreviate a trace ID to its first 8 chars. */
export function abbreviateTrace(trace: string | null | undefined): string {
  if (!trace) return "—";
  return trace.length > 8 ? trace.slice(0, 8) : trace;
}

/** Format a duration in milliseconds as a short human-readable string. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}
