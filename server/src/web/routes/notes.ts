import { Router } from 'express';
import { validateAgentName } from '../config.js';
import { createLogger } from '../../lib/logger.js';
import { queryString } from '../middleware/query-helpers.js';

import {
  addDiaryEntry,
  getRecentDiary,
  getDiaryCount,
  getNote,
  upsertNote,
  appendNote,
  listNotes,
  searchAgentMemory,
  searchFleetMemory,
} from '../../services/notes-db.js';
import { parseReport } from '../../services/report-parser.js';
import { createOrder } from '../../services/comms-db.js';

const log = createLogger('notes');

function parseLimit(raw: unknown, fallback = 20, max = 100): number {
  const n = parseInt(raw as string || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

const router: Router = Router();

// List all notes for an agent
// Returns NoteFile[] shape for client compat: {name, size, updated_at}
router.get('/:name', (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const noteList = listNotes(name);
  const diaryCount = getDiaryCount(name);
  const files = noteList.map((n) => ({ name: n.note_type, size: n.size, updated_at: n.updated_at }));
  // Include diary count as metadata
  res.setHeader('X-Diary-Entries', String(diaryCount));
  res.json(files);
});

// ── Diary routes ──────────────────────────────────────────────

router.get('/:name/diary', (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const count = Number(req.query.count ?? 10);
  const entries = getRecentDiary(name, count);
  res.json({ entries });
});

router.post('/:name/diary', async (req, res) => {
  const name = req.params.name;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const { entry } = req.body;
  if (!entry || typeof entry !== 'string') {
    res.status(400).json({ error: 'entry is required' });
    return;
  }
  const id = addDiaryEntry(name, entry);
  res.json({ ok: true, id });
});

// ── Fleet-wide search (before :name routes) ──────────────────

router.get('/fleet/search', (req, res) => {
  const q = queryString(req, 'q');
  if (!q) {
    res.status(400).json({ error: 'q parameter required' });
    return;
  }
  const limit = parseLimit(req.query.limit);
  const agent = queryString(req, 'agent');
  if (agent && !validateAgentName(agent)) {
    res.status(404).json({ error: `Unknown agent: ${agent}` });
    return;
  }
  try {
    const results = searchFleetMemory(q, limit, agent || undefined);
    res.json({ results, query: q, agent: agent || 'all' });
  } catch (err) {
    log.error('Fleet search failed', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Search failed due to a server error' });
  }
});

// ── Search route (must be before :type catch-all) ─────────────

router.get('/:name/search', (req, res) => {
  const agent = req.params.name;
  if (!validateAgentName(agent)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const q = queryString(req, 'q');
  if (!q) {
    res.status(400).json({ error: 'q parameter required' });
    return;
  }
  const limit = parseLimit(req.query.limit);
  const results = searchAgentMemory(agent, q, limit);
  res.json({ results, query: q });
});

// ── Note routes (strategy, discoveries, market-intel, report) ──

router.get('/:name/:type', (req, res) => {
  const name = req.params.name;
  const type = req.params.type;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  try {
    const content = getNote(name, type);
    res.json({ content: content ?? '' });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.put('/:name/:type', async (req, res) => {
  const name = req.params.name;
  const type = req.params.type;
  if (!validateAgentName(name)) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  const { content, mode } = req.body;
  if (typeof content !== 'string') {
    res.status(400).json({ error: 'content is required' });
    return;
  }
  try {
    if (mode === 'append') {
      appendNote(name, type, content);
    } else {
      upsertNote(name, type, content);
    }
    // Auto-generate fleet orders from report content
    if (type === 'report') {
      const parsed = parseReport(name, content);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      for (const order of parsed) {
        createOrder({
          message: order.message,
          target_agent: order.target_agent ?? undefined,
          priority: order.priority,
          expires_at: expiresAt,
        });
        log.info(`[report-pipeline] Auto-created ${order.priority} order from ${name}: ${order.type}`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
