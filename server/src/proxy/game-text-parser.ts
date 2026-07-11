/**
 * game-text-parser.ts — the ONE place that parses SpaceMolt's formatted-text
 * tool dashboards back into structured data.
 *
 * The game API periodically flips tool responses from JSON to human-readable
 * TEXT (tables + labelled lines): get_status, get_cargo, analyze_market, get_base,
 * facility list, salvage_wreck, etc. The proxy passes that text straight through
 * (parseToolCallResponse's JSON.parse fails → returns the raw string), so anything
 * that used to read structured fields now receives a string.
 *
 * Historically each caller re-derived that structure with its own inline regex,
 * scattered across routine-utils, http-game-client-v2 and the compound tools. When
 * the game changed a dashboard's wording/layout those parsers silently returned
 * empty/wrong data (empty cargo, empty market, false "arrived home" handoffs).
 * Centralizing every regex here means future schema drift breaks in EXACTLY one
 * place — caught by game-text-parser.test.ts — instead of silently everywhere.
 *
 * See docs/proxy-todos.md (2026-06-23 formatted-text sweep) in the fleet repo.
 */

// ---------------------------------------------------------------------------
// Shared table primitive
// ---------------------------------------------------------------------------

/**
 * Parse the first tab-separated table out of a text dashboard.
 * Skips any preamble lines (e.g. "Cargo: 0/0 used…" / "Trading insights at …:")
 * before the header row, then collects rows until the table ends (first
 * non-tab line, e.g. a blank line or a trailing "Credits: …cr").
 * Returns lowercased header columns + the data rows (trimmed cells).
 */
export function parseTextTable(text: string): { headers: string[]; rows: string[][] } {
  let headers: string[] | null = null;
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("\t")) {
      if (headers) break;   // table started and now ended
      continue;             // still in preamble
    }
    const cols = line.split("\t").map((c) => c.trim());
    if (!headers) headers = cols.map((c) => c.toLowerCase());
    else rows.push(cols);
  }
  return { headers: headers ?? [], rows };
}

/**
 * Convert a display name to its item_id slug — the inverse of the generic
 * id→name transform in lib/utils.ts getItemDisplayName ("Power Cell" →
 * "power_cell", "Shield Booster II" → "shield_booster_ii"). Used when the
 * formatted table gives only a name column (get_cargo) and a caller needs an id.
 */
export function itemNameToId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// get_cargo text table
// ---------------------------------------------------------------------------

export interface CargoItem {
  item_id: string;
  quantity: number;
}

/** Parse get_cargo's formatted text table (header "item\tqty\tsize") into cargo items. */
export function parseCargoText(text: string): CargoItem[] {
  const { headers, rows } = parseTextTable(text);
  if (headers.length === 0) return [];
  const nameIdx = headers.findIndex((h) => h === "item" || h === "name");
  const qtyIdx = headers.findIndex((h) => h === "qty" || h === "quantity");
  const idIdx = headers.findIndex((h) => h === "item_id" || h === "id");
  if (nameIdx === -1 && idIdx === -1) return [];
  const out: CargoItem[] = [];
  for (const cols of rows) {
    const name = nameIdx >= 0 ? (cols[nameIdx] ?? "") : "";
    // Prefer an explicit id column if the game ever adds one; else slug the name.
    const item_id = (idIdx >= 0 && cols[idIdx]) ? cols[idIdx] : itemNameToId(name);
    const quantity = qtyIdx >= 0 ? parseInt(cols[qtyIdx], 10) : NaN;
    if (item_id && !isNaN(quantity) && quantity > 0) out.push({ item_id, quantity });
  }
  return out;
}

/**
 * Read the "Cargo: <used>/<capacity>" line from a get_status text dashboard.
 * Returns null when the line is absent or capacity is 0 (unreliable).
 * NOTE: get_cargo's OWN header reports "0/0" and must NOT drive utilization —
 * pass a get_status result here, whose "Cargo: U/C" line carries the true numbers.
 */
export function parseCargoUtilizationText(text: string): {
  used: number;
  capacity: number;
  freeSpace: number;
  pctFull: number;
} | null {
  const m = text.match(/Cargo:\s*(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  const used = parseInt(m[1], 10);
  const capacity = parseInt(m[2], 10);
  if (isNaN(used) || isNaN(capacity) || capacity <= 0) return null;
  return { used, capacity, freeSpace: Math.max(0, capacity - used), pctFull: (used / capacity) * 100 };
}

// ---------------------------------------------------------------------------
// analyze_market text table
// ---------------------------------------------------------------------------

// analyze_market insight categories (observed live, v0.427.x) that mean the
// station BUYS the item from us — i.e. a valid sell target:
//   demand          — station has buy demand for the item
//   sell_here       — explicitly flagged as a good place to sell
//   supply_imbalance — captured live: "<item> has N units of unfilled buy orders
//                      here at <price> with nothing for sale — potential
//                      opportunity." i.e. a supply SHORTAGE = strong buy demand,
//                      often the highest-value sell target. (Excluding it made
//                      agents skip premium shortage stations / leave cargo.)
// Excluded (not direct buy-demand): opportunity/arbitrage (cross-station hints),
// depth_warning, manager_activity.
const SELL_TARGET_CATEGORIES = new Set(["demand", "sell_here", "supply_imbalance"]);

/**
 * Parse analyze_market's formatted text table for items the station demands.
 * Returns a Map keyed by item_id AND the display-name slug, each mapped to the
 * CANONICAL item_id. See extractDemandItems in routine-utils for the rationale
 * behind the slug alias key.
 */
export function parseMarketDemandText(text: string): Map<string, string> {
  const demandItems = new Map<string, string>();
  const { headers, rows } = parseTextTable(text);
  const idIdx = headers.findIndex((h) => h === "item_id" || h === "id");
  const catIdx = headers.findIndex((h) => h === "category");
  const nameIdx = headers.findIndex((h) => h === "item" || h === "name");
  if (idIdx === -1) return demandItems;
  for (const cols of rows) {
    const id = cols[idIdx];
    if (!id) continue;
    const cat = catIdx >= 0 ? (cols[catIdx] ?? "").toLowerCase() : "";
    // No category column → can't tell direction; include (better to attempt
    // the sell, which no-ops at the game, than to skip a real buyer).
    if (catIdx === -1 || SELL_TARGET_CATEGORIES.has(cat) || cat.includes("demand")) {
      demandItems.set(id, id);
      // Also key by the name→id slug as an alias → the CANONICAL id. parseCargoText
      // derives a cargo item's id by slugging its display NAME (the cargo table has
      // no id column), so for items whose real id isn't the literal slug (e.g.
      // mining_laser_1 vs "Mining Laser I" → mining_laser_i) the cargo↔demand join
      // would miss. Mapping the slug → canonical id lets callers both match AND
      // resolve the cargo item to the real game id for the sell command.
      if (nameIdx >= 0 && cols[nameIdx]) demandItems.set(itemNameToId(cols[nameIdx]), id);
    }
  }
  return demandItems;
}

/**
 * Build a slug/id → CANONICAL item_id alias map from EVERY row of an
 * analyze_market text table, regardless of insight category. Unlike
 * parseMarketDemandText (which only includes rows the station buys), this covers
 * all items the market knows about, so callers that need canonical ids for
 * NON-demand items (e.g. create_sell_order on leftovers) can resolve
 * name-slug cargo ids like mining_laser_i to real ids like mining_laser_1.
 * Items absent from the market table stay unresolved — callers should fall
 * back to the raw id (correct for the common slug==id case, e.g. ores).
 */
export function parseMarketAliasesText(text: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const { headers, rows } = parseTextTable(text);
  const idIdx = headers.findIndex((h) => h === "item_id" || h === "id");
  const nameIdx = headers.findIndex((h) => h === "item" || h === "name");
  if (idIdx === -1) return aliases;
  for (const cols of rows) {
    const id = cols[idIdx];
    if (!id) continue;
    aliases.set(id, id);
    if (nameIdx >= 0 && cols[nameIdx]) aliases.set(itemNameToId(cols[nameIdx]), id);
  }
  return aliases;
}

// ---------------------------------------------------------------------------
// get_status text dashboard
// ---------------------------------------------------------------------------

export interface ParsedGetStatus {
  username?: string;
  empire?: string;
  credits?: number;
  systemDisplayName?: string;
  hull?: number;
  maxHull?: number;
  shield?: number;
  maxShield?: number;
  armor?: number;
  speed?: number;
  /** Station id from the "Docked at: <id>" line; undefined when not docked. */
  dockedAt?: string;
  fuel?: number;
  maxFuel?: number;
  cargoUsed?: number;
  cargoCapacity?: number;
  cpuUsed?: number;
  cpuCapacity?: number;
  powerUsed?: number;
  powerCapacity?: number;
  modules: Array<{ id?: string; class_id?: string; slot?: string; size?: string; wear?: string }>;
  cargo: Array<{ name: string; quantity: number }>;
  skills: Array<{ name: string; level: number; xp: number; xpToNext: number }>;
  /** v0.280+ per-empire standings: keyed by empire name (lowercase), e.g. "solarian". */
  standings: Record<string, { reputation: number; baseline: number; bounty: number }>;
}

/**
 * Parse the `spacemolt(get_status)` text dashboard into a structured shape.
 * Each regex is independent — a format change in one line doesn't break the
 * others. See plan §A for the regex contracts.
 */
export function parseGetStatusText(text: string): ParsedGetStatus {
  const out: ParsedGetStatus = { modules: [], cargo: [], skills: [], standings: {} };

  // Header: "Username [Empire] | 1,234,567cr | System Display Name"
  // Empire token is \w+ (e.g. "Drifter") but the username can have arbitrary
  // characters; non-greedy match for the username up to " [".
  for (const line of text.split("\n")) {
    const headerMatch = line.match(/^(\S.*?) \[(\w+)\] \| ([\d,]+)cr \| (.+)$/);
    if (headerMatch) {
      out.username = headerMatch[1].trim();
      out.empire = headerMatch[2];
      out.credits = parseInt(headerMatch[3].replace(/,/g, ""), 10);
      out.systemDisplayName = headerMatch[4].trim();
      break;
    }
  }

  const num = (re: RegExp): number | undefined => {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : undefined;
  };
  const numPair = (re: RegExp): [number | undefined, number | undefined] => {
    const m = text.match(re);
    if (!m) return [undefined, undefined];
    return [parseInt(m[1], 10), parseInt(m[2], 10)];
  };

  [out.hull, out.maxHull] = numPair(/Hull:\s*(\d+)\/(\d+)/);
  [out.shield, out.maxShield] = numPair(/Shield:\s*(\d+)\/(\d+)/);
  out.armor = num(/Armor:\s*(\d+)/);
  out.speed = num(/Speed:\s*(\d+)/);
  [out.fuel, out.maxFuel] = numPair(/Fuel:\s*(\d+)\/(\d+)/);
  [out.cargoUsed, out.cargoCapacity] = numPair(/Cargo:\s*(\d+)\/(\d+)/);
  [out.cpuUsed, out.cpuCapacity] = numPair(/CPU:\s*(\d+)\/(\d+)/);
  [out.powerUsed, out.powerCapacity] = numPair(/Power:\s*(\d+)\/(\d+)/);

  // "Docked at: <station_id>" appears only when docked (absent in space/transit).
  // This is the authoritative dock signal from the get_status dashboard itself —
  // more reliable than the separate get_location field and avoids that extra call.
  // Guard against a future "Docked at: none/-/null" placeholder being read as a
  // real station id (which would wrongly report docked).
  const dockMatch = text.match(/^Docked at:\s*(\S+)/m);
  if (dockMatch && !/^(none|null|-|n\/a)$/i.test(dockMatch[1])) out.dockedAt = dockMatch[1];

  // Section parser helper: extracts tab-delimited rows from named sections.
  // Stops at the next section header (Word (N): or Word:) or end of text.
  // Skips the header row (first row where cols[0] matches an expected header name).
  const parseSection = (sectionRe: RegExp): string[][] => {
    const m = text.match(sectionRe);
    if (!m) return [];
    const rows: string[][] = [];
    for (const row of m[1].split("\n")) {
      if (!row.includes("\t")) continue;
      const cols = row.split("\t").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cols.length < 2) continue;
      rows.push(cols);
    }
    return rows;
  };

  // Modules: tab-split rows under a "Modules (N):" header. The section ends
  // at the next "Word (...)" section header (Cargo, Skills, Active missions,
  // etc) — relying on `\n\n` was wrong because get_status uses single newlines
  // between sections, which let skill rows leak into out.modules.
  const SECTION_END = /(?:\n\n|\n[A-Za-z][\w ]*(?:\(|:)|$)/;
  const moduleSectionRe = new RegExp(`Modules\\s*(?:\\(\\d+\\))?:\\n([\\s\\S]*?)${SECTION_END.source}`);
  for (const cols of parseSection(moduleSectionRe)) {
    // Skip the header row if it's literally column names.
    if (cols[0].toLowerCase() === "id" || cols[0].toLowerCase() === "module") continue;
    if (cols.length < 4) continue;
    out.modules.push({
      id: cols[0],
      class_id: cols[1],
      slot: cols[2],
      size: cols[3],
      wear: cols[4],
    });
  }

  // Cargo: tab-split rows under "Cargo (N items):" or "Cargo:".
  // Format: "item\tqty\tsize" header, then "Gold Ore\t14\t1" rows.
  const cargoSectionRe = new RegExp(`Cargo\\s*(?:\\([^)]*\\))?:\\n([\\s\\S]*?)${SECTION_END.source}`);
  for (const cols of parseSection(cargoSectionRe)) {
    // Skip header row
    if (cols[0].toLowerCase() === "item" || cols[0].toLowerCase() === "name") continue;
    const name = cols[0];
    const quantity = parseInt(cols[1], 10);
    if (name && !isNaN(quantity) && quantity > 0) {
      out.cargo.push({ name, quantity });
    }
  }

  // Skills: tab-split rows under "Skills (N):" header.
  // Format: "skill\tlevel\txp\tnext_level" header, then "mining\t13\t478\t6885" rows.
  const skillsSectionRe = new RegExp(`Skills\\s*(?:\\([^)]*\\))?:\\n([\\s\\S]*?)${SECTION_END.source}`);
  for (const cols of parseSection(skillsSectionRe)) {
    // Skip header row
    if (cols[0].toLowerCase() === "skill" || cols[0].toLowerCase() === "name") continue;
    const name = cols[0];
    const level = parseInt(cols[1], 10);
    const xp = parseInt(cols[2], 10);
    const xpToNext = parseInt(cols[3], 10);
    if (name && !isNaN(level)) {
      out.skills.push({ name, level, xp: isNaN(xp) ? 0 : xp, xpToNext: isNaN(xpToNext) ? 0 : xpToNext });
    }
  }

  // Empire standings: tab-split rows under "Empire standings:" header (v0.280+).
  // Format: "empire\trep\tbaseline\tbounty" header, then one row per empire.
  // Example: "solarian\t20\t20\t0"
  const standingsSectionRe = new RegExp(`Empire standings:\\n([\\s\\S]*?)${SECTION_END.source}`);
  for (const cols of parseSection(standingsSectionRe)) {
    // Skip header row
    if (cols[0].toLowerCase() === "empire") continue;
    const empire = cols[0].toLowerCase();
    const reputation = parseInt(cols[1], 10);
    const baseline = parseInt(cols[2], 10);
    const bounty = parseInt(cols[3], 10);
    if (empire && !isNaN(reputation)) {
      out.standings[empire] = {
        reputation,
        baseline: isNaN(baseline) ? 0 : baseline,
        bounty: isNaN(bounty) ? 0 : bounty,
      };
    }
  }

  return out;
}
