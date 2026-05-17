// USD per million tokens — sourced from Anthropic public pricing as of 2026-05.
// Update when rates change.
export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  "claude-opus-4-7":   { input: 15, output: 75, cacheRead: 1.50, cacheWrite: 18.75 },
  "claude-haiku-4-5":  { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1.00 },
};

export function lookupPricing(modelId: string | undefined): typeof MODEL_PRICING[string] | null {
  if (!modelId) return null;
  // Match by prefix — model IDs may have suffixes like -20251001
  for (const [key, val] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key)) return val;
  }
  return null;
}

export function computeCost(
  metrics: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
  modelId: string | undefined,
): number | null {
  const p = lookupPricing(modelId);
  if (!p) return null;
  const inp = (metrics.inputTokens ?? 0) * p.input;
  const out = (metrics.outputTokens ?? 0) * p.output;
  const cr  = (metrics.cacheReadTokens ?? 0) * p.cacheRead;
  const cw  = (metrics.cacheCreationTokens ?? 0) * p.cacheWrite;
  return (inp + out + cr + cw) / 1_000_000;
}
