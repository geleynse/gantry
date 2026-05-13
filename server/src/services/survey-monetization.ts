/**
 * Survey monetization adoption metric.
 *
 * Two scout agents have prompts that tell them to post tradeable game-notes
 * tagged with `INTEL-[REGION]-[DATE]` (drifter-gale, price=1000) or
 * `BELT-REPORT-[SYSTEM]-[DATE]` (lumen-shoal, price=500). Until now there
 * was no feedback loop showing whether the agents actually do this.
 *
 * This module reads `proxy_tool_calls` and pulls out anything that looks
 * like a tagged note creation. We deliberately match by *title prefix*
 * rather than the underlying tool name because:
 *
 *  - `create_note` is allowed in DENIED_ACTIONS_V2 — agents calling
 *    `spacemolt_social(action="create_note", ...)` pass through to the
 *    game server and the v2 dispatch logs them under `tool_name =
 *    'create_note'`.
 *  - The title-prefix path stays as a fallback: if an agent ever calls
 *    `write_note(title="INTEL-...")` after creating, or some other emit
 *    path appears in args/results, we still count it.
 *  - And finally: the title pattern is the source of truth — that's what
 *    the agent prompts pin against. If the agent ever invokes anything
 *    that emits an INTEL-* / BELT-REPORT-* string into args/results,
 *    we count it.
 *
 * Sale detection is best-effort. Game state for note listings owned by a
 * player isn't stored in our DB today, so matched notes default to
 * `sold: null` (unknown) unless we find a result containing `sold` /
 * `purchased_by` markers. As of the get_notes unblock, agents (or a
 * future poller) can call `spacemolt_social(action="get_notes")` and the
 * passthrough result gets logged into `proxy_tool_calls`; classifyRow
 * scans `result_summary` for sale markers and populates `sold` from
 * there.
 *
 * No filesystem writes, no schema changes, no agent-prompt edits.
 */

import { queryAll } from './database.js';

// `session_handoffs` rows mark the *end* of a fleet runner session for an
// agent (the agent serializes its state before the runner restarts it).
// Two consecutive handoffs delimit one session window. See
// services/analytics-query.ts getSessionPnl for the same pairing pattern.
interface SessionHandoffRow {
  agent: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Tag schema — keep in sync with fleet-agents/{drifter-gale,lumen-shoal}.txt
// ---------------------------------------------------------------------------

/**
 * Per-agent expected tag prefix and target sale price.
 * `targetPrice` is informational only — used to spot off-list pricing.
 */
export interface SurveyTagSpec {
  agent: string;
  prefix: string;        // e.g. "INTEL-"
  targetPrice: number;   // creds, from prompt
}

export const SURVEY_TAG_SPECS: SurveyTagSpec[] = [
  { agent: 'drifter-gale', prefix: 'INTEL-',       targetPrice: 1000 },
  { agent: 'lumen-shoal',  prefix: 'BELT-REPORT-', targetPrice: 500 },
];

/**
 * Anchored pattern with capture groups for the segments expected after
 * the prefix: PREFIX-REGION-YYYY-MM-DD. We require at least one
 * non-hyphen-only region segment and a 4-2-2 date suffix. If the date
 * is missing or malformed we still match the prefix and report the title
 * as `tagDate: null` so the metric counts attempts even when off-format.
 *
 * Example matches:
 *   INTEL-SIRIUS-2026-04-27
 *   INTEL-NEXUS_CORE-2026-05-06
 *   BELT-REPORT-VEGA-2026-05-01
 *
 * Off-format we still want to count as "attempted":
 *   INTEL-SIRIUS         (no date)
 *   INTEL-2026-04-27     (no region — uncommon, but accepted)
 */
const TAG_TITLE_REGEX = /\b(INTEL-|BELT-REPORT-)([A-Z0-9_]*)(?:-(\d{4}-\d{2}-\d{2}))?/i;

/**
 * Match a candidate string and return `{ prefix, region, date }` or null.
 * Title casing is normalized to upper for the prefix; region is preserved
 * verbatim so we can differentiate `SIRIUS` vs `SIRIUS_OUTER`.
 */
export function matchSurveyTag(title: string): {
  prefix: string;
  region: string | null;
  date: string | null;
} | null {
  if (!title) return null;
  const m = title.match(TAG_TITLE_REGEX);
  if (!m) return null;
  const prefix = m[1].toUpperCase();
  const region = m[2] && m[2].length > 0 ? m[2] : null;
  const date = m[3] ?? null;
  return { prefix, region, date };
}

/**
 * Map a matched prefix back to the agent that's *supposed* to be using it.
 * If a different agent posts under that prefix, we still count the note
 * but `taggedFor` will mismatch `recordedAgent`, which the dashboard can
 * surface as a misuse signal.
 */
export function expectedAgentFor(prefix: string): string | null {
  const spec = SURVEY_TAG_SPECS.find((s) => s.prefix === prefix.toUpperCase());
  return spec?.agent ?? null;
}

// ---------------------------------------------------------------------------
// Raw proxy_tool_calls row shape (subset we need)
// ---------------------------------------------------------------------------

interface ProxyCallRow {
  id: number;
  agent: string;
  tool_name: string;
  args_summary: string | null;
  result_summary: string | null;
  success: number;
  error_code: string | null;
  created_at: string;
}

interface SurveyActionInfo {
  action: string | null;
  looksLikePostAttempt: boolean;
}

// ---------------------------------------------------------------------------
// Public: per-note record
// ---------------------------------------------------------------------------

export interface SurveyNoteRecord {
  /** proxy_tool_calls.id — stable across queries */
  id: number;
  /** Agent that issued the tool call (may not match `taggedFor` if misused) */
  recordedAgent: string;
  /** "INTEL-" or "BELT-REPORT-" */
  prefix: string;
  /** Agent the prefix is reserved for, per fleet-agents prompts */
  taggedFor: string | null;
  /** Title region segment (e.g. "SIRIUS"). Null if not present in title. */
  region: string | null;
  /** YYYY-MM-DD if the date suffix matched, else null */
  tagDate: string | null;
  /** Original title verbatim, for diagnostics */
  title: string;
  /** Listed price in creds, if we could parse one. */
  price: number | null;
  /** When the proxy logged the call (ISO8601 from SQLite). */
  postedAt: string;
  /**
   * Whether the call succeeded. False covers proxy block + game error.
   * `create_note` is no longer in DENIED_ACTIONS_V2 (as of the survey-
   * monetization unblock), so adoption-zero now reflects agent behavior
   * rather than a proxy gate.
   */
  success: boolean;
  /** Error code from proxy, if any */
  errorCode: string | null;
  /**
   * `true` if we have positive evidence the note was bought.
   * `false` if we have positive evidence it's still on sale.
   * `null` if we don't know — current default for all rows.
   */
  sold: boolean | null;
  /** Sale price when sold; same caveat as `sold`. */
  salePrice: number | null;
  /** Hours between post and sale, or null. */
  hoursToSale: number | null;
}

// ---------------------------------------------------------------------------
// Public: per-agent aggregate
// ---------------------------------------------------------------------------

export interface SurveyAgentSummary {
  agent: string;
  prefix: string;
  targetPrice: number;
  /** Total tagged-note attempts logged within the window. */
  notesPosted: number;
  /** How many of those calls the proxy/game returned as success=1. */
  notesPostedSuccessful: number;
  /** Within last 24h regardless of `hours` window. */
  notesPosted24h: number;
  /** notesSold / notesWithKnownStatus (null if no known statuses). */
  sellThroughRate: number | null;
  /** Sum of salePrice where sold=true. */
  totalCreditsEarned: number;
  /** Most recent post timestamp (ISO8601), or null. */
  lastPostedAt: string | null;
}

// ---------------------------------------------------------------------------
// Aggregate response
// ---------------------------------------------------------------------------

export interface SurveyMonetizationReport {
  /** Window in hours that bounded the queries (notesPosted24h ignores this) */
  hours: number;
  agents: SurveyAgentSummary[];
  /** Most recent ~50 notes for the chosen agent(s), newest first. */
  recent: SurveyNoteRecord[];
  /**
   * Per-agent, per-session buckets — newest session first. This is the
   * "≥1 saleable note posted per session" target tracker. Always present;
   * empty when there's nothing to report.
   */
  sessions: SurveySessionBucket[];
}

// ---------------------------------------------------------------------------
// Per-session bucket
// ---------------------------------------------------------------------------

export interface SurveySessionBucket {
  /** Spec agent the bucket is for (attributed by tag prefix). */
  agent: string;
  /** "INTEL-" / "BELT-REPORT-" */
  prefix: string;
  /**
   * Start of the session window (ISO8601). Inclusive lower bound.
   * Null for the first/synthetic bucket when there's no prior handoff —
   * in that case it's an open-on-the-left bucket of everything older.
   */
  sessionStart: string | null;
  /**
   * End of the session window (ISO8601). Exclusive upper bound. Null means
   * this is the *current* (still-open) session — from the last handoff to now.
   */
  sessionEnd: string | null;
  /** Tagged-note attempts (any success) whose postedAt falls in the window. */
  notesPosted: number;
  /** Subset of `notesPosted` the proxy/game returned success=1. */
  notesPostedSuccessful: number;
  /** Notes in this window we have positive evidence were sold. */
  salesDetected: number;
  /** Sum of salePrice for the sold notes in this window. */
  creditsEarned: number;
  /** Whether the "≥1 saleable note posted" target was hit this session. */
  meetsTarget: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Try every reasonable place a posted-note title might surface in a logged
 * tool call:
 *   - args_summary as JSON: { title, price, ... }
 *   - args_summary as `key=value, key=value` flattened by the v2 dispatcher
 *     log line in gantry-v2.ts (see `argsSnippet`).
 *   - assistant_text accidentally containing the title (unlikely; we don't
 *     read assistant_text here — handled elsewhere).
 */
function extractTitleFromArgs(argsSummary: string | null): {
  title: string | null;
  price: number | null;
} {
  if (!argsSummary) return { title: null, price: null };
  const trimmed = argsSummary.trim();

  // Path 1: JSON-shaped (typical for logToolCall when args is an object)
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const title = typeof obj.title === 'string' ? obj.title : null;
      const price =
        typeof obj.price === 'number' ? obj.price :
        (typeof obj.price === 'string' && /^\d+$/.test(obj.price) ? parseInt(obj.price, 10) : null);
      return { title, price };
    } catch {
      // Truncated / malformed JSON — fall through to regex scan
    }
  }

  // Path 2: regex extraction. Two shapes to support:
  //   - JSON-ish: `"title":"INTEL-..."` (truncated JSON falls here)
  //   - Flattened: `title="INTEL-..."` from the v2 dispatcher's argsSnippet
  const titleMatch =
    trimmed.match(/"title"\s*:\s*"([^"]+)"/) ??
    trimmed.match(/\btitle\s*[:=]\s*"([^"]+)"/) ??
    trimmed.match(/\btitle\s*[:=]\s*([^,\s}]+)/);
  const priceMatch =
    trimmed.match(/"price"\s*:\s*(\d+)/) ??
    trimmed.match(/\bprice\s*[:=]\s*(\d+)/);
  return {
    title: titleMatch?.[1] ?? null,
    price: priceMatch ? parseInt(priceMatch[1], 10) : null,
  };
}

function extractSurveyActionInfo(argsSummary: string | null): SurveyActionInfo {
  if (!argsSummary) return { action: null, looksLikePostAttempt: false };
  const trimmed = argsSummary.trim();

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const action = typeof obj.action === "string" ? obj.action : null;
      const title = typeof obj.title === "string" ? obj.title : null;
      return {
        action,
        looksLikePostAttempt:
          action === "create_note" ||
          action === "write_note" ||
          title !== null,
      };
    } catch {
      // Fall through to regex matching for truncated JSON / flattened logs.
    }
  }

  const actionMatch =
    trimmed.match(/"action"\s*:\s*"([^"]+)"/) ??
    trimmed.match(/\baction\s*[:=]\s*"([^"]+)"/) ??
    trimmed.match(/\baction\s*[:=]\s*([^,\s}]+)/);
  const titleMatch =
    trimmed.match(/"title"\s*:\s*"([^"]+)"/) ??
    trimmed.match(/\btitle\s*[:=]\s*"([^"]+)"/) ??
    trimmed.match(/\btitle\s*[:=]\s*([^,\s}]+)/);

  const action = actionMatch?.[1] ?? null;
  return {
    action,
    looksLikePostAttempt:
      action === "create_note" ||
      action === "write_note" ||
      titleMatch !== null,
  };
}

/**
 * Pull every proxy_tool_calls row that *might* be a survey-note attempt,
 * over the requested window. Cast wide on purpose: we filter in JS rather
 * than encode all the heuristics in SQL.
 *
 * Filters:
 *  - If `agent` is supplied, scope to that agent.
 *  - Time window in hours (>=1).
 *  - tool_name OR args_summary OR result_summary mentions create_note /
 *    INTEL- / BELT-REPORT- / 'note'-shaped tool. We then run a precise
 *    regex match in JS to drop false positives.
 */
function fetchCandidateRows(opts: { hours: number; agent?: string }): ProxyCallRow[] {
  const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(opts.hours))); // cap at 30d
  const params: (string | number)[] = [];
  const where: string[] = [];

  where.push(`datetime(created_at) >= datetime('now', ?)`);
  params.push(`-${safeHours} hours`);

  if (opts.agent) {
    where.push(`agent = ?`);
    params.push(opts.agent);
  }

  // Cast a wide net; the JS-side regex makes the final call.
  where.push(`(
       tool_name = 'create_note'
    OR tool_name = 'spacemolt_social'
    OR (args_summary IS NOT NULL AND (
          args_summary LIKE '%create_note%'
       OR args_summary LIKE '%INTEL-%'
       OR args_summary LIKE '%BELT-REPORT-%'
    ))
    OR (result_summary IS NOT NULL AND (
          result_summary LIKE '%INTEL-%'
       OR result_summary LIKE '%BELT-REPORT-%'
    ))
  )`);

  return queryAll<ProxyCallRow>(
    `SELECT id, agent, tool_name, args_summary, result_summary, success, error_code, created_at
     FROM proxy_tool_calls
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT 1000`,
    ...params,
  );
}

/**
 * Classify one row. Returns null if it's not actually a survey-note attempt
 * (e.g. `INTEL-` mentioned in unrelated assistant text, captured by the
 * over-broad SQL but caught by the regex).
 */
export function classifyRow(row: ProxyCallRow): SurveyNoteRecord | null {
  // Discount __reasoning / __assistant_text rows — those are agent prose,
  // not tool calls. They can mention "INTEL-X" without ever invoking the
  // game's note tool, and counting them inflates adoption.
  if (row.tool_name.startsWith('__')) return null;

  const argInfo = extractTitleFromArgs(row.args_summary);
  const actionInfo = extractSurveyActionInfo(row.args_summary);
  let title = argInfo.title;
  const price = argInfo.price;

  const isCreateNoteTool = row.tool_name === "create_note";
  const isWritePath =
    isCreateNoteTool ||
    (row.tool_name === "spacemolt_social" && actionInfo.looksLikePostAttempt);

  // Fall back to scanning result_summary for an INTEL-/BELT-REPORT- token,
  // but only for note-create/write paths. Read/list calls like get_notes can
  // legitimately echo existing note titles and must not count as new posts.
  if (!title && isWritePath && row.result_summary) {
    const m = row.result_summary.match(TAG_TITLE_REGEX);
    if (m) title = m[0];
  }

  if (!title) {
    // tool_name=create_note with no title in args — still a tagged-attempt
    // signal if the tool name itself is the source. Drop it — without a
    // title we can't classify which prefix family it belongs to.
    return null;
  }

  const tag = matchSurveyTag(title);
  if (!tag) return null;

  // Sale signal — best-effort. We look for "sold" / "purchased_by" tokens
  // in the result. If the result_summary parses as JSON with a buyer
  // field, treat as sold. Otherwise null (= unknown).
  let sold: boolean | null = null;
  let salePrice: number | null = null;
  if (row.result_summary) {
    const r = row.result_summary;
    if (/\b(sold|purchased_by|buyer_id|sold_at)\b/i.test(r)) {
      sold = true;
      const sp = r.match(/\b(?:sale_price|sold_for)\s*[:=]\s*(\d+)/i);
      if (sp) salePrice = parseInt(sp[1], 10);
      else if (price != null) salePrice = price;
    } else if (/\bunsold\b|"status"\s*:\s*"listed"/i.test(r)) {
      sold = false;
    }
  }

  return {
    id: row.id,
    recordedAgent: row.agent,
    prefix: tag.prefix,
    taggedFor: expectedAgentFor(tag.prefix),
    region: tag.region,
    tagDate: tag.date,
    title,
    price,
    postedAt: row.created_at,
    success: row.success === 1,
    errorCode: row.error_code,
    sold,
    salePrice,
    hoursToSale: null, // requires a separate sold_at lookup; unimplemented
  };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export interface SurveyMonetizationOpts {
  /** Window for headline counts. Default 24h. */
  hours?: number;
  /** Restrict to a specific agent. Default: drifter-gale + lumen-shoal. */
  agent?: string;
}

/**
 * Build the full report. Caller is the API route or a CLI sanity dump.
 *
 * Implementation note: we always produce one row per spec agent even if
 * they have zero attempts — the explicit zero is the whole point of the
 * metric.
 */
export function getSurveyMonetizationReport(
  opts: SurveyMonetizationOpts = {},
): SurveyMonetizationReport {
  const hours = opts.hours ?? 24;
  const rows = fetchCandidateRows({ hours, agent: opts.agent });

  // Always classify, then drop unmatched.
  const classified = rows.map(classifyRow).filter((n): n is SurveyNoteRecord => n !== null);

  // Pre-compute 24h cutoff once.
  const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // Build agent summaries — always include both spec agents, scoped if
  // caller asked for a single agent.
  const wantedSpecs = opts.agent
    ? SURVEY_TAG_SPECS.filter((s) => s.agent === opts.agent)
    : SURVEY_TAG_SPECS;

  const agents: SurveyAgentSummary[] = wantedSpecs.map((spec) => {
    // We attribute by `taggedFor` (prefix-derived) rather than `recordedAgent`
    // so a misposted tag still counts toward the right line. The dashboard
    // can call out misuse separately.
    const forSpec = classified.filter((n) => n.taggedFor === spec.agent);

    const sellable = forSpec.filter((n) => n.sold !== null);
    const sold = sellable.filter((n) => n.sold === true);

    const sellThroughRate = sellable.length > 0
      ? sold.length / sellable.length
      : null;

    const totalCreditsEarned = sold.reduce((acc, n) => acc + (n.salePrice ?? 0), 0);

    const lastPostedAt = forSpec[0]?.postedAt ?? null; // rows are DESC sorted

    return {
      agent: spec.agent,
      prefix: spec.prefix,
      targetPrice: spec.targetPrice,
      notesPosted: forSpec.length,
      notesPostedSuccessful: forSpec.filter((n) => n.success).length,
      notesPosted24h: forSpec.filter((n) => n.postedAt >= cutoff24h).length,
      sellThroughRate,
      totalCreditsEarned,
      lastPostedAt,
    };
  });

  return {
    hours,
    agents,
    recent: classified.slice(0, 50),
    sessions: bucketBySession(classified, opts.agent),
  };
}

// ---------------------------------------------------------------------------
// Session bucketing
// ---------------------------------------------------------------------------

/**
 * Per-agent session windows from `session_handoffs`, newest session first.
 * Two consecutive handoff timestamps bound one closed session; the span from
 * the last handoff to "now" is the open session. If an agent has no handoffs
 * we emit a single open-ended bucket covering everything.
 *
 * Returns `[start, end]` pairs where `end === null` marks the open session
 * and `start === null` marks the "everything older than the first handoff"
 * bucket. Buckets are returned newest-end-first.
 */
function sessionWindowsFor(agent: string): Array<{ start: string | null; end: string | null }> {
  const handoffs = queryAll<SessionHandoffRow>(
    `SELECT agent, created_at FROM session_handoffs WHERE agent = ? ORDER BY created_at ASC`,
    agent,
  );
  if (handoffs.length === 0) {
    // No session boundaries known — one open-ended bucket.
    return [{ start: null, end: null }];
  }
  const windows: Array<{ start: string | null; end: string | null }> = [];
  // Everything before the first handoff.
  windows.push({ start: null, end: handoffs[0].created_at });
  // Closed sessions between consecutive handoffs.
  for (let i = 1; i < handoffs.length; i++) {
    windows.push({ start: handoffs[i - 1].created_at, end: handoffs[i].created_at });
  }
  // Open session: from the last handoff to now.
  windows.push({ start: handoffs[handoffs.length - 1].created_at, end: null });
  // Newest first.
  return windows.reverse();
}

/** True if `ts` (ISO8601) is in [start, end): start null = -inf, end null = +inf. */
function inWindow(ts: string, start: string | null, end: string | null): boolean {
  if (start !== null && ts < start) return false;
  if (end !== null && ts >= end) return false;
  return true;
}

/**
 * Bucket classified notes into per-agent session windows.
 *
 * Attribution is by `taggedFor` (prefix-derived), consistent with the
 * headline summaries — a misposted tag still lands in the right agent's
 * session timeline. `scopeAgent`, when set, limits output to that agent.
 */
function bucketBySession(
  notes: SurveyNoteRecord[],
  scopeAgent?: string,
): SurveySessionBucket[] {
  const wantedSpecs = scopeAgent
    ? SURVEY_TAG_SPECS.filter((s) => s.agent === scopeAgent)
    : SURVEY_TAG_SPECS;

  const out: SurveySessionBucket[] = [];
  for (const spec of wantedSpecs) {
    const forSpec = notes.filter((n) => n.taggedFor === spec.agent);
    for (const w of sessionWindowsFor(spec.agent)) {
      const inIt = forSpec.filter((n) => inWindow(n.postedAt, w.start, w.end));
      // Skip empty closed buckets to keep the list short; always keep the
      // current open session (end === null) so "0 this session" is visible.
      if (inIt.length === 0 && w.end !== null) continue;
      const sold = inIt.filter((n) => n.sold === true);
      out.push({
        agent: spec.agent,
        prefix: spec.prefix,
        sessionStart: w.start,
        sessionEnd: w.end,
        notesPosted: inIt.length,
        notesPostedSuccessful: inIt.filter((n) => n.success).length,
        salesDetected: sold.length,
        creditsEarned: sold.reduce((acc, n) => acc + (n.salePrice ?? 0), 0),
        meetsTarget: inIt.length >= 1,
      });
    }
  }
  return out;
}

/**
 * Convenience wrapper for callers that only want the session timeline
 * (e.g. the dashboard's adoption widget). Uses the same `hours` window as
 * the headline report to bound how far back we classify notes.
 */
export function getSurveyMonetizationBySession(
  opts: SurveyMonetizationOpts = {},
): SurveySessionBucket[] {
  return getSurveyMonetizationReport(opts).sessions;
}

// ---------------------------------------------------------------------------
// Test exports — kept minimal, only what unit tests need direct access to.
// ---------------------------------------------------------------------------

export const __test__ = {
  extractTitleFromArgs,
  classifyRow,
  TAG_TITLE_REGEX,
};
