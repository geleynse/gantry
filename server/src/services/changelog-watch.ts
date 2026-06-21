/**
 * changelog-watch.ts — early-warning canary for BREAKING game changes.
 *
 * The api-drift monitor catches API *shape* changes (tools added/removed/retyped)
 * but is blind to behaviour/strictness changes — e.g. "login now rejects
 * session_id" (v0.335.0), which silently broke fleet-wide re-auth. The game ships
 * its release notes in the login/renewal greeting ("Latest release: vX.Y.Z\n  - …"),
 * so we scan those notes for breaking keywords and file a deduped alert for review
 * BEFORE the change bites agents.
 */
import { createAlert as createAlertImpl, hasRecentAlert as hasRecentAlertImpl } from "./alerts-db.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("changelog-watch");

/**
 * Phrases that signal a backwards-incompatible change. Deliberately phrase-based
 * (not bare "required"/"must") to keep noise down — a canary that cries wolf gets
 * ignored. Over-matching a benign note is cheap (deduped, review-only); missing a
 * real break is what we're guarding against.
 */
const BREAKING_KEYWORDS = [
  "no longer",
  "removed",
  "deprecat",          // deprecated / deprecation
  "now requires",
  "now require",
  "must now",
  "now rejects",
  "rejects",
  "rejected",
  "breaking",
  "unknown parameter",
  "invalid_payload",
  "now strict",
  "stricter",
];

export interface ChangelogScan {
  /** Version parsed from "Latest release: vX.Y.Z", or null. */
  version: string | null;
  /** Note lines that matched a breaking keyword (bullet markers stripped). */
  breakingLines: string[];
}

/** Scan a login/renewal greeting for a version + breaking-change note lines. */
export function detectBreakingChangelog(greetingText: string): ChangelogScan {
  const text = typeof greetingText === "string" ? greetingText : "";
  const versionMatch = text.match(/Latest release:\s*v?([0-9][0-9.]*)/i);
  const version = versionMatch ? versionMatch[1] : null;

  const breakingLines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Skip structural lines (greeting header, session id, the version header).
    const lower = line.toLowerCase();
    if (lower.startsWith("welcome") || lower.startsWith("session id:") || lower.startsWith("latest release:")) {
      continue;
    }
    if (BREAKING_KEYWORDS.some((k) => lower.includes(k))) {
      breakingLines.push(line.replace(/^[-*•]\s*/, "").trim());
    }
  }
  return { version, breakingLines };
}

export interface ChangelogWatchDeps {
  createAlert: (agent: string, severity: string, category: string | null, message: string) => number;
  hasRecentAlert: (agent: string, category: string) => boolean;
}

const DEFAULT_DEPS: ChangelogWatchDeps = {
  createAlert: createAlertImpl,
  hasRecentAlert: (agent, category) => hasRecentAlertImpl(agent, category, 7 * 24 * 60 * 60 * 1000),
};

/**
 * Scan a greeting and file a single (per-version) alert when it carries breaking
 * notes. Safe to call on every login/renewal — dedup keeps it to one alert per
 * version. Never throws (alerting must not break the login path).
 */
export function checkChangelogForBreaking(
  greetingText: string,
  deps: ChangelogWatchDeps = DEFAULT_DEPS,
): void {
  try {
    const { version, breakingLines } = detectBreakingChangelog(greetingText);
    if (breakingLines.length === 0) return;

    const category = `changelog-breaking:${version ?? "unknown"}`;
    if (deps.hasRecentAlert("system", category)) return;

    const message =
      `Possible BREAKING game change in release ${version ?? "(unknown version)"} — review before it bites agents:\n` +
      breakingLines.map((l) => `  • ${l}`).join("\n");
    deps.createAlert("system", "warning", category, message);
    log.warn("breaking changelog note detected", { version, count: breakingLines.length });
  } catch (err) {
    log.debug("changelog watch failed (non-fatal)", { error: String(err) });
  }
}
