/**
 * Strategy doc sanitizer — strips known contamination patterns from strategy doc content.
 *
 * Unlike the contamination word filter (which rejects the entire write), this operates
 * at line granularity: bad lines get dropped, clean lines pass through. This handles
 * Haiku agents that ignore prompt-level cleanup rules and preserve stale/hallucinated
 * content like "Navigation unstable" across strategy doc rewrites.
 *
 * Only applied to write_doc(title='strategy'). Other doc types use the standard
 * contamination word rejection.
 */

/**
 * Patterns that indicate hallucinated/contaminated lines in strategy docs.
 * Lines containing any of these patterns (case-insensitive) will be stripped.
 *
 * These mirror the forbidden words in common-rules.txt that Haiku consistently
 * fails to clean up on its own.
 */
export const STRATEGY_CONTAMINATION_PATTERNS: string[] = [
  "navigation unstable",
  "backend failure",
  "infrastructure lock",
  "queue lock",
  "phantom",
  "cache lag",
  "deadlock",
  "system degraded",
  "data corruption",
];

export interface SanitizeResult {
  /** Content with contaminated lines removed. */
  cleaned: string;
  /** List of lines that were removed, for logging. */
  removed: string[];
}

/**
 * Sanitize strategy doc content by stripping lines that contain known contamination patterns.
 *
 * Only strips full lines — no substring replacement within otherwise-valid lines.
 * Empty lines adjacent to removed lines are preserved to avoid mangling doc structure.
 *
 * @param content Raw strategy doc content from agent
 * @param patterns Contamination patterns to check (default: STRATEGY_CONTAMINATION_PATTERNS)
 * @returns { cleaned, removed } — cleaned content and list of stripped lines
 */
export function sanitizeStrategyContent(
  content: string,
  patterns: string[] = STRATEGY_CONTAMINATION_PATTERNS,
): SanitizeResult {
  if (!content || patterns.length === 0) {
    return { cleaned: content, removed: [] };
  }

  const lines = content.split("\n");
  const removed: string[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const matched = patterns.some((p) => lower.includes(p.toLowerCase()));
    if (matched) {
      removed.push(line);
    } else {
      kept.push(line);
    }
  }

  return {
    cleaned: kept.join("\n"),
    removed,
  };
}
