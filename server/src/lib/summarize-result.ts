// ---------------------------------------------------------------------------
// Result summary helpers — shared between activity-feed and tool-call-feed
// ---------------------------------------------------------------------------

export const RESULT_INLINE_MAX = 100;

/**
 * Try to parse a string as JSON. Returns the parsed value or null.
 */
function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Pick the first meaningful string field from a parsed JSON object.
 * Prefers fields named "message", "summary", "status", "error", "reason",
 * then falls back to the first string-valued key.
 */
function firstStringField(obj: Record<string, unknown>): string | null {
  const preferred = ["message", "summary", "status", "error", "reason", "result", "text"];
  for (const key of preferred) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return `${key}: ${v}`;
  }
  for (const [key, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.trim()) return `${key}: ${v}`;
  }
  return null;
}

/**
 * Produce a short inline label for a result_summary string.
 * - Plain strings: truncate at word boundary near RESULT_INLINE_MAX
 * - JSON objects: extract a meaningful field or show key count
 * - JSON arrays: show array length
 * - Special cases: get_missions, analyze_market with dedicated formatters
 */
export function summarizeResult(raw: string, toolName?: string): string {
  const trimmed = raw.trim();
  const parsed = tryParseJson(trimmed);

  if (parsed !== null) {
    // Special handling for get_missions
    if (toolName === "get_missions" && Array.isArray(parsed)) {
      if (parsed.length === 0) return "[0 missions]";
      const topReward = parsed.reduce((max: number, m: any) => {
        const reward = typeof m?.reward === "number" ? m.reward : 0;
        return Math.max(max, reward);
      }, 0);
      const summary = `[${parsed.length} mission${parsed.length !== 1 ? "s" : ""}${topReward > 0 ? `, max ${topReward.toLocaleString()} cr` : ""}]`;
      return summary.length <= RESULT_INLINE_MAX ? summary : `[${parsed.length} missions]`;
    }

    // Special handling for analyze_market
    if (toolName === "analyze_market" && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, any>;
      const items = obj.items || [];
      if (Array.isArray(items) && items.length > 0) {
        // Find best buy/sell spread
        let bestSpread = 0;
        let bestItem = "";
        for (const item of items) {
          if (item.buy_price != null && item.sell_price != null) {
            const spread = item.sell_price - item.buy_price;
            if (spread > bestSpread) {
              bestSpread = spread;
              bestItem = item.name || item.item || "?";
            }
          }
        }
        if (bestSpread > 0) {
          const summary = `[${items.length} items, best spread: ${bestItem} +${bestSpread}]`;
          return summary.length <= RESULT_INLINE_MAX ? summary : `[${items.length} items]`;
        }
        return `[${items.length} items]`;
      }
    }

    // Standard JSON handling
    if (Array.isArray(parsed)) {
      return `[${parsed.length} item${parsed.length !== 1 ? "s" : ""}]`;
    }
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const field = firstStringField(obj);
      if (field) {
        const snippet = field.length > RESULT_INLINE_MAX ? field.slice(0, RESULT_INLINE_MAX) + "…" : field;
        return snippet;
      }
      const keys = Object.keys(obj);
      return `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
    }
  }

  // Plain string — truncate at word boundary
  if (trimmed.length <= RESULT_INLINE_MAX) return trimmed;
  const cut = trimmed.slice(0, RESULT_INLINE_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut) + "…";
}
