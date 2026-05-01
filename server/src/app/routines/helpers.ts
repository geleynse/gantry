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

// `formatDuration` lives in lib/format now. Re-exported here so the rest
// of this page (and its tests) keeps importing from the same module path.
export { formatDuration } from "@/lib/format";
