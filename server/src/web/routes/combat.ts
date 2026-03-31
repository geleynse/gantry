import { Router } from 'express';
import { queryAll, queryOne } from '../../services/database.js';
import { extractQueryAgent } from '../middleware/query-agent.js';
import { queryString, queryInt } from '../middleware/query-helpers.js';

const router: Router = Router();

/**
 * GET /api/combat/summary?hours=N
 * Per-agent combat stats: encounters, deaths, damage taken, insurance payouts.
 * Optional hours param to filter to recent events.
 */
router.get('/summary', (req, res) => {
  const hours = queryInt(req, 'hours');
  const timeClause = hours && hours > 0
    ? `WHERE datetime(created_at) >= datetime('now', '-${hours} hours')`
    : '';

  const rows = queryAll<{
    agent: string;
    total_hits: number;
    total_encounters: number;
    total_damage: number;
    total_deaths: number;
    total_insurance: number;
  }>(`
    SELECT
      agent,
      COUNT(CASE WHEN event_type = 'pirate_combat' THEN 1 END) AS total_hits,
      COUNT(DISTINCT CASE WHEN event_type IN ('pirate_combat', 'pirate_warning') THEN
        (agent || '_' || COALESCE(pirate_name, '') || '_' || DATE(created_at))
      END) AS total_encounters,
      SUM(CASE WHEN event_type = 'pirate_combat' THEN COALESCE(damage, 0) ELSE 0 END) AS total_damage,
      COUNT(CASE WHEN event_type = 'player_died' THEN 1 END) AS total_deaths,
      SUM(CASE WHEN event_type = 'player_died' THEN COALESCE(insurance_payout, 0) ELSE 0 END) AS total_insurance
    FROM combat_events
    ${timeClause}
    GROUP BY agent
    ORDER BY total_encounters DESC
  `);

  res.json({ summary: rows });
});

/**
 * GET /api/combat/log
 * Paginated combat event log.
 */
router.get('/log', (req, res) => {
  const agentFilter = extractQueryAgent(req);

  const limit = Math.min(queryInt(req, 'limit') ?? 50, 200);
  const offset = queryInt(req, 'offset') ?? 0;

  let where = '';
  const params: (string | number)[] = [];

  if (agentFilter) {
    where = 'WHERE agent = ?';
    params.push(agentFilter);
  }

  const countRow = queryOne<{ total: number }>(
    `SELECT COUNT(*) as total FROM combat_events ${where}`,
    ...params
  );

  const rows = queryAll<CombatEventRow>(
    `SELECT
      id, agent, event_type, pirate_name, pirate_tier, damage,
      hull_after, max_hull, died, insurance_payout, system, created_at
    FROM combat_events
    ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?`,
    ...params, limit, offset
  );

  res.json({
    events: rows,
    total: countRow?.total ?? 0,
    limit,
    offset,
  });
});

/**
 * GET /api/combat/systems?hours=N
 * Top systems by pirate encounter count.
 * Optional hours param to filter to recent events.
 */
router.get('/systems', (req, res) => {
  const hours = queryInt(req, 'hours');
  const timeClause = hours && hours > 0
    ? `AND datetime(created_at) >= datetime('now', '-${hours} hours')`
    : '';

  const rows = queryAll<{
    system: string;
    encounter_count: number;
    death_count: number;
    total_damage: number;
  }>(`
    SELECT
      system,
      COUNT(*) AS encounter_count,
      COUNT(CASE WHEN event_type = 'player_died' THEN 1 END) AS death_count,
      SUM(CASE WHEN event_type = 'pirate_combat' THEN COALESCE(damage, 0) ELSE 0 END) AS total_damage
    FROM combat_events
    WHERE system IS NOT NULL AND system != ''
      AND event_type IN ('pirate_combat', 'pirate_warning')
      ${timeClause}
    GROUP BY system
    ORDER BY encounter_count DESC
    LIMIT 10
  `);

  res.json({ systems: rows });
});

// ---------------------------------------------------------------------------
// Encounter grouping helpers
// ---------------------------------------------------------------------------

interface CombatEventRow {
  id: number;
  agent: string;
  event_type: string;
  pirate_name: string | null;
  pirate_tier: string | null;
  damage: number | null;
  hull_after: number | null;
  max_hull: number | null;
  died: number;
  insurance_payout: number | null;
  system: string | null;
  created_at: string;
}

interface Encounter {
  id: number;
  agent: string;
  pirate_name: string;
  pirate_tier: string;
  system: string;
  started_at: string;
  ended_at: string;
  events_count: number;
  total_damage: number;
  outcome: 'survived' | 'died' | 'fled';
  hull_start: number;
  hull_end: number;
}

const ENCOUNTER_GAP_MS = 5 * 60 * 1000; // 5 minutes

function groupIntoEncounters(events: CombatEventRow[]): Encounter[] {
  const encounters: Encounter[] = [];
  if (events.length === 0) return encounters;

  let currentGroup: CombatEventRow[] = [];

  const finalizeGroup = () => {
    if (currentGroup.length === 0) return;

    const first = currentGroup[0];
    const last = currentGroup[currentGroup.length - 1];

    const totalDamage = currentGroup.reduce((sum, e) => sum + (e.damage ?? 0), 0);
    const hasDied = currentGroup.some((e) => e.died === 1);
    const lastHullAfter = last.hull_after ?? 0;

    let outcome: 'survived' | 'died' | 'fled';
    if (hasDied) {
      outcome = 'died';
    } else if (lastHullAfter > 0) {
      outcome = 'fled';
    } else {
      outcome = 'survived';
    }

    // hull_start: hull_after + damage from first pirate_combat event
    const firstCombatEvent = currentGroup.find((e) => e.event_type === 'pirate_combat');
    let hullStart = 0;
    if (firstCombatEvent) {
      hullStart = (firstCombatEvent.hull_after ?? 0) + (firstCombatEvent.damage ?? 0);
    } else if (first.max_hull != null) {
      hullStart = first.max_hull;
    }

    encounters.push({
      id: first.id,
      agent: first.agent,
      pirate_name: first.pirate_name ?? '',
      pirate_tier: first.pirate_tier ?? '',
      system: first.system ?? '',
      started_at: first.created_at,
      ended_at: last.created_at,
      events_count: currentGroup.length,
      total_damage: totalDamage,
      outcome,
      hull_start: hullStart,
      hull_end: lastHullAfter,
    });

    currentGroup = [];
  };

  // The pirate_name that started the current encounter (null-safe: death events have null pirate_name)
  let currentPirateName: string | null = null;

  for (const event of events) {
    if (currentGroup.length === 0) {
      currentPirateName = event.pirate_name;
      currentGroup.push(event);
      continue;
    }

    const prev = currentGroup[currentGroup.length - 1];
    const prevTime = new Date(prev.created_at).getTime();
    const currTime = new Date(event.created_at).getTime();
    const gapMs = currTime - prevTime;

    const agentChanged = event.agent !== prev.agent;
    // Only treat as a new pirate if the event actually names a different pirate (ignore null — e.g. player_died)
    const pirateChanged =
      event.pirate_name !== null && event.pirate_name !== currentPirateName;
    const gapTooLarge = gapMs > ENCOUNTER_GAP_MS;

    if (agentChanged || pirateChanged || gapTooLarge) {
      finalizeGroup();
      currentPirateName = event.pirate_name;
    }

    currentGroup.push(event);
  }

  finalizeGroup();
  return encounters;
}

/**
 * GET /api/combat/encounters
 * Groups combat_events into logical encounters and returns filtered/paginated results.
 */
router.get('/encounters', (req, res) => {
  const agentFilter = extractQueryAgent(req);
  const systemFilter = queryString(req, 'system');
  const outcomeFilter = queryString(req, 'outcome');
  const tierFilter = queryString(req, 'pirate_tier');
  const fromFilter = queryString(req, 'from');
  const toFilter = queryString(req, 'to');

  const limit = Math.min(queryInt(req, 'limit') ?? 50, 200);
  const offset = queryInt(req, 'offset') ?? 0;

  // Push agent/date filters into SQL to avoid full table scan
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (agentFilter) {
    conditions.push('agent = ?');
    params.push(agentFilter);
  }
  if (fromFilter) {
    conditions.push('created_at >= ?');
    params.push(fromFilter);
  }
  if (toFilter) {
    conditions.push('created_at <= ?');
    params.push(toFilter);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const allEvents = queryAll<CombatEventRow>(
    `SELECT
      id, agent, event_type, pirate_name, pirate_tier, damage,
      hull_after, max_hull, died, insurance_payout, system, created_at
    FROM combat_events
    ${where}
    ORDER BY agent, created_at`,
    ...params
  );

  let encounters = groupIntoEncounters(allEvents);

  // Apply post-grouping filters (these require encounter-level fields)
  if (systemFilter) {
    encounters = encounters.filter((e) => e.system === systemFilter);
  }
  if (outcomeFilter) {
    encounters = encounters.filter((e) => e.outcome === outcomeFilter);
  }
  if (tierFilter) {
    encounters = encounters.filter((e) => e.pirate_tier === tierFilter);
  }

  const total = encounters.length;
  const paginated = encounters.slice(offset, offset + limit);

  res.json({ encounters: paginated, total, limit, offset });
});

/**
 * GET /api/combat/encounters/:id
 * Returns a single encounter (by first-event id) with all its raw events.
 */
router.get('/encounters/:id', (req, res) => {
  const startId = parseInt(req.params.id, 10);

  if (isNaN(startId)) {
    res.status(400).json({ error: 'Invalid encounter id' });
    return;
  }

  // Find the starting event
  const startEvent = queryOne<CombatEventRow>(
    `SELECT id, agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, insurance_payout, system, created_at
    FROM combat_events
    WHERE id = ?`,
    startId
  );

  if (!startEvent) {
    res.status(404).json({ error: 'Encounter not found' });
    return;
  }

  // Fetch events for this agent+pirate_name starting from the start event
  const candidateEvents = queryAll<CombatEventRow>(
    `SELECT id, agent, event_type, pirate_name, pirate_tier, damage, hull_after, max_hull, died, insurance_payout, system, created_at
    FROM combat_events
    WHERE agent = ?
      AND (pirate_name = ? OR (pirate_name IS NULL AND ? IS NULL))
      AND id >= ?
    ORDER BY created_at, id`,
    startEvent.agent, startEvent.pirate_name, startEvent.pirate_name, startId
  );

  // Walk through candidate events, collecting only those within the 5-minute grouping window
  const encounterEvents: CombatEventRow[] = [];
  for (const event of candidateEvents) {
    if (encounterEvents.length === 0) {
      encounterEvents.push(event);
      continue;
    }
    const prev = encounterEvents[encounterEvents.length - 1];
    const gap = new Date(event.created_at).getTime() - new Date(prev.created_at).getTime();
    if (gap > ENCOUNTER_GAP_MS) break;
    encounterEvents.push(event);
  }

  const encounters = groupIntoEncounters(encounterEvents);
  if (encounters.length === 0) {
    res.status(404).json({ error: 'Encounter not found' });
    return;
  }

  res.json({ encounter: encounters[0], events: encounterEvents });
});

/**
 * GET /api/combat/death-heatmap
 * Deaths per system grouped by agent, with time bucketing (daily).
 * Optional ?hours=168 param (default 7 days = 168 hours).
 */
router.get('/death-heatmap', (req, res) => {
  const hours = Math.max(1, queryInt(req, 'hours') ?? 168);

  const rows = queryAll<{
    system: string;
    agent: string;
    date: string;
    deaths: number;
    encounters: number;
    damage: number;
  }>(`
    SELECT
      system,
      agent,
      DATE(created_at) AS date,
      COUNT(CASE WHEN event_type = 'player_died' THEN 1 END) AS deaths,
      COUNT(CASE WHEN event_type IN ('pirate_combat', 'pirate_warning') THEN 1 END) AS encounters,
      SUM(CASE WHEN event_type = 'pirate_combat' THEN COALESCE(damage, 0) ELSE 0 END) AS damage
    FROM combat_events
    WHERE created_at >= datetime('now', ? || ' hours')
    GROUP BY system, agent, DATE(created_at)
    HAVING deaths > 0 OR encounters > 0
    ORDER BY system, agent, date DESC
  `, `-${hours}`);

  res.json({ heatmap: rows });
});

/**
 * GET /api/combat/timeline
 * Daily combat summary per agent.
 */
router.get('/timeline', (req, res) => {
  const hours = queryInt(req, 'hours') ?? 720; // default 30 days
  const rows = queryAll<{
    agent: string;
    date: string;
    encounters: number;
    deaths: number;
    damage: number;
  }>(`
    SELECT
      agent,
      DATE(created_at) AS date,
      COUNT(*) AS encounters,
      SUM(died) AS deaths,
      SUM(CASE WHEN event_type = 'pirate_combat' THEN COALESCE(damage, 0) ELSE 0 END) AS damage
    FROM combat_events
    WHERE created_at >= datetime('now', '-' || ? || ' hours')
    GROUP BY agent, DATE(created_at)
    ORDER BY date DESC, agent
  `, hours);

  res.json({ timeline: rows });
});

export default router;
