/**
 * Action Log Parser
 *
 * Parses raw get_action_log results from the game server into structured
 * ActionLogEntry records suitable for storage in agent_action_log.
 *
 * The game API format may evolve, so parsing is defensive: JSON.parse first,
 * then regex fallbacks for common patterns. Unknown or malformed entries are
 * silently skipped.
 */

import { getDb } from "./database.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("action-log-parser");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionLogEntry {
  agent: string;
  actionType: string;
  item?: string;
  quantity?: number;
  creditsDelta?: number;
  station?: string;
  system?: string;
  rawData: string;
  gameTimestamp?: string;
}

// Game API action log entry shape (best-guess from known game patterns).
// The game may return different shapes - we are defensive throughout.
interface RawActionEntry {
  type?: string;
  action?: string;
  action_type?: string;
  event?: string;
  item?: string;
  item_id?: string;
  item_name?: string;
  quantity?: number;
  amount?: number;
  credits?: number;
  credits_delta?: number;
  price?: number;
  total?: number;
  total_credits?: number;
  cost?: number;
  station?: string;
  station_id?: string;
  location?: string;
  poi?: string;
  system?: string;
  timestamp?: string;
  created_at?: string;
  time?: string;
  date?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise action type strings from varying game naming conventions. */
function normaliseActionType(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

/** Extract credits delta from a raw entry using multiple candidate fields. */
function extractCreditsDelta(entry: RawActionEntry): number | undefined {
  // Explicit delta field first
  if (typeof entry.credits_delta === "number") return entry.credits_delta;

  // Positive revenue fields
  if (typeof entry.total_credits === "number") return entry.total_credits;

  // Cost fields (negative - money spent)
  if (typeof entry.cost === "number") return -entry.cost;

  // price x quantity inference
  const price = typeof entry.price === "number" ? entry.price : undefined;
  const qty =
    typeof entry.quantity === "number"
      ? entry.quantity
      : typeof entry.amount === "number"
      ? entry.amount
      : undefined;
  if (price !== undefined && qty !== undefined) {
    const actionType =
      entry.type ?? entry.action_type ?? entry.action ?? entry.event ?? "";
    const lower = String(actionType).toLowerCase();
    if (
      lower.includes("sell") ||
      lower.includes("rescue") ||
      lower.includes("deposit")
    ) {
      return price * qty;
    }
    if (
      lower.includes("buy") ||
      lower.includes("purchase") ||
      lower.includes("commission")
    ) {
      return -(price * qty);
    }
    return price * qty;
  }

  if (typeof entry.total === "number") return entry.total;
  if (typeof entry.credits === "number") return entry.credits;

  return undefined;
}

/** Extract action type string from a raw entry. */
function extractActionType(entry: RawActionEntry): string | null {
  const raw = entry.type ?? entry.action_type ?? entry.action ?? entry.event;
  if (typeof raw === "string" && raw.trim()) return normaliseActionType(raw.trim());
  return null;
}

/** Extract item name from a raw entry (various field names the game might use). */
function extractItem(entry: RawActionEntry): string | undefined {
  const item = entry.item_name ?? entry.item ?? entry.item_id;
  if (typeof item === "string" && item.trim()) return item.trim();
  return undefined;
}

/** Extract quantity from a raw entry. */
function extractQuantity(entry: RawActionEntry): number | undefined {
  const q = entry.quantity ?? entry.amount;
  if (typeof q === "number" && q > 0) return q;
  return undefined;
}

/** Extract station/POI from a raw entry. */
function extractStation(entry: RawActionEntry): string | undefined {
  const s = entry.station ?? entry.station_id ?? entry.poi ?? entry.location;
  if (typeof s === "string" && s.trim()) return s.trim();
  return undefined;
}

/** Extract system from a raw entry. */
function extractSystem(entry: RawActionEntry): string | undefined {
  if (typeof entry.system === "string" && entry.system.trim()) return entry.system.trim();
  return undefined;
}

/** Extract game timestamp from a raw entry. */
function extractTimestamp(entry: RawActionEntry): string | undefined {
  const t = entry.timestamp ?? entry.created_at ?? entry.time ?? entry.date;
  if (typeof t === "string" && t.trim()) return t.trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Regex fallback patterns for plain-text action log lines
// ---------------------------------------------------------------------------

const SELL_REGEX =
  /sold\s+(\d+)x?\s+(.+?)\s+(?:at|@)\s+(.+?)\s+for\s+([\d,]+)\s+credits?/i;
const BUY_REGEX =
  /bought\s+(\d+)x?\s+(.+?)\s+(?:at|@)\s+(.+?)\s+for\s+([\d,]+)\s+credits?/i;
const RESCUE_REGEX =
  /rescue\s+(?:payment|payout)[:\s]+([\d,]+)\s+credits?/i;
const INSURANCE_REGEX =
  /(?:self.destruct fee|insurance payout)[:\s]+([\d,]+)\s+credits?/i;
const FACTION_REGEX =
  /faction\s+(?:deposit|transfer|escrow)[:\s]+([\d,]+)\s+credits?/i;

function parseFromText(text: string, agent: string): ActionLogEntry[] {
  const entries: ActionLogEntry[] = [];

  const sellMatch = SELL_REGEX.exec(text);
  if (sellMatch) {
    entries.push({
      agent,
      actionType: "sell",
      item: sellMatch[2].trim(),
      quantity: parseInt(sellMatch[1], 10),
      creditsDelta: parseInt(sellMatch[4].replace(/,/g, ""), 10),
      station: sellMatch[3].trim(),
      rawData: text,
    });
  }

  const buyMatch = BUY_REGEX.exec(text);
  if (buyMatch) {
    entries.push({
      agent,
      actionType: "buy",
      item: buyMatch[2].trim(),
      quantity: parseInt(buyMatch[1], 10),
      creditsDelta: -parseInt(buyMatch[4].replace(/,/g, ""), 10),
      station: buyMatch[3].trim(),
      rawData: text,
    });
  }

  const rescueMatch = RESCUE_REGEX.exec(text);
  if (rescueMatch) {
    entries.push({
      agent,
      actionType: "rescue",
      creditsDelta: parseInt(rescueMatch[1].replace(/,/g, ""), 10),
      rawData: text,
    });
  }

  const insuranceMatch = INSURANCE_REGEX.exec(text);
  if (insuranceMatch) {
    const amount = parseInt(insuranceMatch[1].replace(/,/g, ""), 10);
    entries.push({
      agent,
      actionType: text.toLowerCase().includes("self") ? "self_destruct" : "insurance_payout",
      creditsDelta: amount,
      rawData: text,
    });
  }

  const factionMatch = FACTION_REGEX.exec(text);
  if (factionMatch) {
    entries.push({
      agent,
      actionType: "faction_deposit",
      creditsDelta: parseInt(factionMatch[1].replace(/,/g, ""), 10),
      rawData: text,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse raw get_action_log result text into structured ActionLogEntry records.
 *
 * Accepts the raw string result from the game server. Tries JSON first,
 * falls back to line-by-line regex matching.
 *
 * Returns an array of entries (may be empty for unrecognised formats).
 */
export function parseActionLog(agent: string, rawResult: string): ActionLogEntry[] {
  if (!rawResult || typeof rawResult !== "string") return [];

  const entries: ActionLogEntry[] = [];

  // Attempt JSON parse
  try {
    const parsed: unknown = JSON.parse(rawResult);

    const asObj =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;

    let items: unknown[] = [];
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (asObj) {
      const candidateKey = ["actions", "entries", "log", "events", "history"].find(
        (k) => Array.isArray(asObj[k])
      );
      if (candidateKey) {
        items = asObj[candidateKey] as unknown[];
      } else {
        // Might be a single entry object
        items = [parsed];
      }
    }

    for (const item of items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as RawActionEntry;

      const actionType = extractActionType(entry);
      if (!actionType) continue;

      entries.push({
        agent,
        actionType,
        item: extractItem(entry),
        quantity: extractQuantity(entry),
        creditsDelta: extractCreditsDelta(entry),
        station: extractStation(entry),
        system: extractSystem(entry),
        rawData: JSON.stringify(item),
        gameTimestamp: extractTimestamp(entry),
      });
    }

    if (entries.length > 0) return entries;

    // JSON parsed as a plain string - try text parser on it
    if (typeof parsed === "string") {
      return parseFromText(parsed, agent);
    }

    return [];
  } catch {
    // Not JSON - fall through to text parsing
  }

  // Plain text: try each line independently
  for (const line of rawResult.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lineEntries = parseFromText(trimmed, agent);
    entries.push(...lineEntries);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

/**
 * Insert action log entries into agent_action_log, skipping duplicates.
 * Entries with a game_timestamp are deduped by (agent, action_type, game_timestamp).
 * Entries without a game_timestamp are always inserted (no dedup key available).
 *
 * Returns the number of new rows inserted.
 */
export function persistActionLogEntries(entries: ActionLogEntry[]): number {
  if (entries.length === 0) return 0;

  const db = getDb();
  let inserted = 0;

  // Two statements: one for timestamped entries (dedup), one for untimestamped
  const stmtWithTs = db.prepare(`
    INSERT INTO agent_action_log (
      agent, action_type, item, quantity, credits_delta,
      station, system, raw_data, game_timestamp
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM agent_action_log
      WHERE agent = ? AND action_type = ? AND game_timestamp = ?
    )
  `);

  const stmtNoTs = db.prepare(`
    INSERT INTO agent_action_log (
      agent, action_type, item, quantity, credits_delta,
      station, system, raw_data, game_timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  const insertAll = db.transaction(() => {
    for (const entry of entries) {
      if (entry.gameTimestamp) {
        const result = stmtWithTs.run(
          entry.agent,
          entry.actionType,
          entry.item ?? null,
          entry.quantity ?? null,
          entry.creditsDelta ?? null,
          entry.station ?? null,
          entry.system ?? null,
          entry.rawData,
          entry.gameTimestamp,
          // WHERE NOT EXISTS params
          entry.agent,
          entry.actionType,
          entry.gameTimestamp,
        );
        inserted += result.changes;
      } else {
        const result = stmtNoTs.run(
          entry.agent,
          entry.actionType,
          entry.item ?? null,
          entry.quantity ?? null,
          entry.creditsDelta ?? null,
          entry.station ?? null,
          entry.system ?? null,
          entry.rawData,
        );
        inserted += result.changes;
      }
    }
  });

  try {
    insertAll();
  } catch (err) {
    log.warn("Failed to persist action log entries", {
      error: err instanceof Error ? err.message : String(err),
      count: String(entries.length),
    });
  }

  return inserted;
}

/**
 * Parse and persist action log in one step.
 * Called from passthrough-handler after a successful get_action_log call.
 */
export function syncActionLog(agent: string, rawResult: string): void {
  try {
    const entries = parseActionLog(agent, rawResult);
    if (entries.length === 0) return;
    const inserted = persistActionLogEntries(entries);
    if (inserted > 0) {
      log.info("Synced action log entries", {
        agent,
        inserted: String(inserted),
        total: String(entries.length),
      });
    }
  } catch (err) {
    log.warn("syncActionLog failed", {
      agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
