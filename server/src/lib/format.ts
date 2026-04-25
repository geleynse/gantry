/**
 * Shared number / currency formatting helpers.
 *
 * Two parallel families: full-precision (for tables, detail rows) and
 * compact (for chart axes, dense headers). Mixing them in the same column
 * is the bug we're fixing here — pick one form per column, not per cell.
 *
 * Helpers:
 *   - `formatNumber(n)`              → "1,234,567"        (counts, generic)
 *   - `formatCredits(n)`             → "1,234,567 cr"     (full precision + suffix)
 *   - `formatCreditsCompact(n)`      → "1.23M cr"         (compact + suffix)
 *   - `formatDelta(n)`               → "+1,234" / "-1,234" (signed, no suffix)
 *   - `formatCreditsDelta(n)`        → "+1,234 cr" / "-1,234 cr"
 *   - `formatCreditsDeltaCompact(n)` → "+1.23M cr"
 *   - `formatCompactNumber(n)`       → "1.23M"            (compact, no suffix)
 *
 * All helpers safely handle `null` / `undefined` (returning "—") and
 * non-finite numbers.
 */

type NumInput = number | null | undefined;

function safeNumber(n: NumInput): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  return n;
}

/** Generic thousand-separator integer/decimal — no suffix. */
export function formatNumber(n: NumInput, fractionDigits: number = 0): string {
  const v = safeNumber(n);
  if (v == null) return "—";
  return v.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Compact form with K / M / B suffix.
 *
 * Chooses 2-significant-figure decimal precision in the chosen unit, so:
 *   1_234        → "1.23K"
 *   1_234_567    → "1.23M"
 *   12_300_000   → "12.3M"
 *   123_000_000  → "123M"
 *
 * Sign is preserved.
 */
export function formatCompactNumber(n: NumInput): string {
  const v = safeNumber(n);
  if (v == null) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${trimZeros(abs / 1_000_000_000, 2)}B`;
  if (abs >= 1_000_000) return `${sign}${trimZeros(abs / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${sign}${trimZeros(abs / 1_000, 2)}K`;
  return `${sign}${formatNumber(abs)}`;
}

/**
 * Full-precision credits string with the canonical "cr" suffix and
 * thousands separators. For tables and detail views.
 */
export function formatCredits(n: NumInput): string {
  const v = safeNumber(n);
  if (v == null) return "—";
  return `${formatNumber(v)} cr`;
}

/**
 * Compact credits — for chart labels, dense headers, narrow columns.
 * Avoids mixing precision in one column.
 */
export function formatCreditsCompact(n: NumInput): string {
  const v = safeNumber(n);
  if (v == null) return "—";
  return `${formatCompactNumber(v)} cr`;
}

/**
 * Signed integer with thousand separators — always prefixed with `+` or `-`.
 * Useful for delta columns where direction matters at a glance.
 */
export function formatDelta(n: NumInput): string {
  const v = safeNumber(n);
  if (v == null) return "—";
  if (v === 0) return "0";
  const sign = v > 0 ? "+" : "-";
  return `${sign}${formatNumber(Math.abs(v))}`;
}

/** Signed credits delta, full precision. */
export function formatCreditsDelta(n: NumInput): string {
  const v = safeNumber(n);
  if (v == null) return "—";
  if (v === 0) return "0 cr";
  const sign = v > 0 ? "+" : "-";
  return `${sign}${formatNumber(Math.abs(v))} cr`;
}

/** Signed credits delta, compact form. */
export function formatCreditsDeltaCompact(n: NumInput): string {
  const v = safeNumber(n);
  if (v == null) return "—";
  if (v === 0) return "0 cr";
  const sign = v > 0 ? "+" : "-";
  return `${sign}${formatCompactNumber(Math.abs(v))} cr`;
}

/**
 * Trim trailing zeros for compact-form values. We don't want `1.20M` —
 * we want `1.2M`. But we keep `1M` as-is (no decimal at all).
 */
function trimZeros(n: number, maxDecimals: number): string {
  // Round to maxDecimals first, then strip trailing zeros + dangling dot.
  const fixed = n.toFixed(maxDecimals);
  return fixed.replace(/\.?0+$/, "");
}
