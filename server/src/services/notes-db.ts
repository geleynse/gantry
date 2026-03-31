import { queryAll, queryOne, queryRun, queryInsert } from "./database.js";

// ── Auto-scoring heuristic ──────────────────────────────────────────────────

/**
 * Auto-score a memory entry based on content signals.
 * Returns 0-5. Explicit importance provided by caller always overrides this.
 */
export function autoScore(text: string): number {
  let score = 0;
  if (/combat|attack|destroyed|killed/i.test(text)) score += 2;
  if (/profit|earned|credits/i.test(text)) score += 1;
  if (/discovered|new system|first/i.test(text)) score += 2;
  if (/error|bug|failed|stuck/i.test(text)) score += 1;
  if (/lesson|learned|never again|important/i.test(text)) score += 3;
  return Math.min(score, 5);
}

// ── Diary ──────────────────────────────────────────────────────

export function addDiaryEntry(agent: string, entry: string, importance?: number): number {
  const score = importance !== undefined ? importance : autoScore(entry);
  return queryInsert(
    `INSERT INTO agent_diary (agent, entry, importance) VALUES (?, ?, ?)`,
    agent, entry, score
  );
}

export function getRecentDiary(agent: string, count = 5): { id: number; entry: string; importance: number; created_at: string }[] {
  // Return newest first (reverse chronological)
  return queryAll<{ id: number; entry: string; importance: number; created_at: string }>(
    `SELECT id, entry, importance, created_at FROM agent_diary WHERE agent = ? ORDER BY id DESC LIMIT ?`,
    agent, count
  );
}

export function decontaminateDiary(agent: string, words: string[]): number {
  // Build a WHERE clause that matches any contamination word (case-insensitive)
  const conditions = words.map(() => `LOWER(entry) LIKE ? ESCAPE '\\'`).join(" OR ");
  const params = words.map((w) => `%${w.toLowerCase().replace(/[%_\\]/g, ch => '\\' + ch)}%`);
  return queryRun(
    `DELETE FROM agent_diary WHERE agent = ? AND (${conditions})`,
    agent, ...params
  );
}

export function getDiaryCount(agent: string): number {
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM agent_diary WHERE agent = ?`,
    agent
  );
  return row?.count ?? 0;
}

// ── Notes ──────────────────────────────────────────────────────

const VALID_NOTE_TYPES = new Set(["strategy", "discoveries", "market-intel", "report", "thoughts"]);

function validateNoteType(type: string): void {
  if (!VALID_NOTE_TYPES.has(type)) {
    throw new Error(`Invalid note type: ${type}. Must be one of: ${[...VALID_NOTE_TYPES].join(", ")}`);
  }
}

export function getNote(agent: string, type: string): string | null {
  validateNoteType(type);
  const row = queryOne<{ content: string }>(
    `SELECT content FROM agent_docs WHERE agent = ? AND note_type = ?`,
    agent, type
  );
  return row?.content ?? null;
}

export function getNoteUpdatedAt(agent: string, type: string): string | null {
  validateNoteType(type);
  const row = queryOne<{ updated_at: string }>(
    `SELECT updated_at FROM agent_docs WHERE agent = ? AND note_type = ?`,
    agent, type
  );
  return row?.updated_at ?? null;
}

export function upsertNote(agent: string, type: string, content: string, importance?: number): void {
  validateNoteType(type);
  const score = importance !== undefined ? importance : autoScore(content);
  queryRun(
    `INSERT INTO agent_docs (agent, note_type, content, importance, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(agent, note_type) DO UPDATE SET content = excluded.content, importance = excluded.importance, updated_at = excluded.updated_at`,
    agent, type, content, score
  );
}

export function appendNote(agent: string, type: string, text: string): void {
  validateNoteType(type);
  queryRun(
    `INSERT INTO agent_docs (agent, note_type, content, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(agent, note_type) DO UPDATE SET
       content = CASE WHEN content = '' THEN excluded.content ELSE content || char(10) || excluded.content END,
       updated_at = excluded.updated_at`,
    agent, type, text
  );
}

export function listNotes(agent: string): { note_type: string; size: number; updated_at: string }[] {
  return queryAll<{ note_type: string; size: number; updated_at: string }>(
    `SELECT note_type, LENGTH(content) as size, updated_at FROM agent_docs WHERE agent = ? ORDER BY note_type`,
    agent
  );
}

// ── Importance update ──────────────────────────────────────────────────────

/**
 * Retroactively update the importance score of a diary entry or doc by ID.
 * Returns true if the record was found and updated, false if ID not found.
 */
export function updateImportance(table: "diary" | "docs", id: number, importance: number): boolean {
  const tableName = table === "diary" ? "agent_diary" : "agent_docs";
  return queryRun(`UPDATE ${tableName} SET importance = ? WHERE id = ?`, importance, id) > 0;
}

// ── Search ────────────────────────────────────────────────────

function truncateText(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function sortByImportanceThenDate(a: { importance: number; created_at: string }, b: { importance: number; created_at: string }): number {
  const diff = b.importance - a.importance;
  return diff !== 0 ? diff : b.created_at.localeCompare(a.created_at);
}

function extractDocText(content: string, query: string): string {
  const lines = content.split("\n");
  const lower = query.toLowerCase();
  return lines.filter((l) => l.toLowerCase().includes(lower)).slice(0, 3).join("\n");
}

export interface SearchResult {
  source: string;       // "diary" | "strategy" | "discoveries" | "market-intel" | "report"
  text: string;         // Matching text (truncated to 200 chars)
  created_at: string;
  importance: number;
  id?: number;
}

export function searchAgentMemory(agent: string, query: string, limit = 20): SearchResult[] {
  const escaped = query.replace(/[%_\\]/g, ch => `\\${ch}`);
  const pattern = `%${escaped}%`;
  const results: SearchResult[] = [];

  // Search diary — order by importance DESC first, then recency as tiebreaker
  const diaryRows = queryAll<{ id: number; entry: string; importance: number; created_at: string }>(
    "SELECT id, entry, importance, created_at FROM agent_diary WHERE agent = ? AND entry LIKE ? ESCAPE '\\' ORDER BY importance DESC, id DESC LIMIT ?",
    agent, pattern, limit
  );
  for (const row of diaryRows) {
    results.push({
      source: "diary",
      text: truncateText(row.entry),
      created_at: row.created_at,
      importance: row.importance,
      id: row.id,
    });
  }

  // Search docs — order by importance DESC
  const docRows = queryAll<{ id: number; note_type: string; content: string; importance: number; updated_at: string }>(
    "SELECT id, note_type, content, importance, updated_at FROM agent_docs WHERE agent = ? AND content LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT ?",
    agent, pattern, limit
  );
  for (const row of docRows) {
    results.push({
      source: row.note_type,
      text: truncateText(extractDocText(row.content, query)),
      created_at: row.updated_at,
      importance: row.importance,
      id: row.id,
    });
  }

  results.sort(sortByImportanceThenDate);
  return results.slice(0, limit);
}

export function searchFleetMemory(query: string, limit = 20, targetAgent?: string): (SearchResult & { agent: string })[] {
  const escaped = query.replace(/[%_\\]/g, ch => `\\${ch}`);
  const pattern = `%${escaped}%`;
  const results: (SearchResult & { agent: string })[] = [];

  // Search diary
  const diarySQL = targetAgent
    ? "SELECT agent, id, entry, importance, created_at FROM agent_diary WHERE agent = ? AND entry LIKE ? ESCAPE '\\' ORDER BY importance DESC, id DESC LIMIT ?"
    : "SELECT agent, id, entry, importance, created_at FROM agent_diary WHERE entry LIKE ? ESCAPE '\\' ORDER BY importance DESC, id DESC LIMIT ?";
  const diaryParams = targetAgent ? [targetAgent, pattern, limit] : [pattern, limit];
  const diaryRows = queryAll<{ agent: string; id: number; entry: string; importance: number; created_at: string }>(
    diarySQL, ...diaryParams
  );
  for (const row of diaryRows) {
    results.push({
      agent: row.agent,
      source: "diary",
      text: truncateText(row.entry),
      created_at: row.created_at,
      importance: row.importance,
      id: row.id,
    });
  }

  // Search docs
  const docSQL = targetAgent
    ? "SELECT agent, id, note_type, content, importance, updated_at FROM agent_docs WHERE agent = ? AND content LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT ?"
    : "SELECT agent, id, note_type, content, importance, updated_at FROM agent_docs WHERE content LIKE ? ESCAPE '\\' ORDER BY importance DESC LIMIT ?";
  const docParams = targetAgent ? [targetAgent, pattern, limit] : [pattern, limit];
  const docRows = queryAll<{ agent: string; id: number; note_type: string; content: string; importance: number; updated_at: string }>(
    docSQL, ...docParams
  );
  for (const row of docRows) {
    results.push({
      agent: row.agent,
      source: row.note_type,
      text: truncateText(extractDocText(row.content, query)),
      created_at: row.updated_at,
      importance: row.importance,
      id: row.id,
    });
  }

  results.sort(sortByImportanceThenDate);
  return results.slice(0, limit);
}

export function decontaminateNotes(agent: string, words: string[]): number {
  // Get all notes for this agent, scan content, remove matching lines
  const notes = queryAll<{ id: number; note_type: string; content: string }>(
    `SELECT id, note_type, content FROM agent_docs WHERE agent = ?`,
    agent
  );

  let totalRemoved = 0;
  for (const note of notes) {
    const lines = note.content.split("\n");
    const clean = lines.filter((line) => {
      const lower = line.toLowerCase();
      return !words.some((w) => lower.includes(w));
    });
    const removed = lines.length - clean.length;
    if (removed > 0) {
      totalRemoved += removed;
      queryRun(
        `UPDATE agent_docs SET content = ?, updated_at = datetime('now') WHERE id = ?`,
        clean.join("\n"), note.id
      );
    }
  }
  return totalRemoved;
}
