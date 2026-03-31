import { stringify } from "yaml";

/**
 * Format tool result data as JSON or YAML based on agent preference.
 * YAML is more token-efficient (no quoted keys, no braces for simple structures).
 */
export function formatForAgent(data: unknown, format: "json" | "yaml"): string {
  if (format === "yaml") {
    return stringify(data, { indent: 2, lineWidth: 0 });
  }
  return JSON.stringify(data);
}
