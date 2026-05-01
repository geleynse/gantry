/**
 * Facilities scan request endpoint — operator-triggered nudge to populate the
 * facilities cache.
 *
 * POST /api/facilities-scan
 * Body: { agent?: string, tab?: "station"|"owned"|"build"|"faction" }
 *   - agent: omit / null for fleet-wide
 *   - tab:   omit / null to fire all four scan actions
 *
 * Drops a high-priority directive into the fleet_orders queue (same channel as
 * /api/fleet/broadcast and the comms /orders endpoint). The targeted agent(s)
 * pick the order up via getPendingOrders on their next turn and call the
 * appropriate `spacemolt_facility(action=...)` actions, which populate the
 * status cache the Facilities page reads from.
 *
 * The four real spacemolt_facility actions used here are:
 *   - faction_list   — facilities owned by the player's faction
 *   - types          — buildable facility types catalog
 *   - personal_build — personally-buildable facility slots
 *   - faction_build  — faction-buildable facility slots
 *
 * This is the closest thing the proxy has to "inject a tool call" — orders
 * are the established directive channel; we don't try to dispatch out-of-band.
 */
import { Router } from 'express';
import { createOrder } from '../../services/comms-db.js';
import { validateAgentName } from '../../config.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('facilities-scan');

type Tab = 'station' | 'owned' | 'build' | 'faction';
const VALID_TABS: ReadonlySet<Tab> = new Set(['station', 'owned', 'build', 'faction']);

/**
 * Per-tab action lists. Each entry maps to a real spacemolt_facility action.
 *
 * - station: faction_list shows the player's faction footprint, which is the
 *   closest signal to "what's at this station" without a dedicated action.
 *   personal_build covers the player's own slots at the dock.
 * - owned: faction_list (player can see what's theirs in the faction roster)
 *   plus personal_build (their personal slots).
 * - build: types (catalog of buildable types) plus personal_build/faction_build
 *   so the Build tab has both player and faction options.
 * - faction: faction_list (existing) plus faction_build (slots).
 */
const TAB_ACTIONS: Record<Tab, string[]> = {
  station: ['faction_list', 'personal_build'],
  owned: ['faction_list', 'personal_build'],
  build: ['types', 'personal_build', 'faction_build'],
  faction: ['faction_list', 'faction_build'],
};

const ALL_ACTIONS = ['faction_list', 'types', 'personal_build', 'faction_build'];

function buildScanMessage(actions: string[]): string {
  const calls = actions
    .map((a) => `spacemolt_facility(action="${a}")`)
    .join(' and ');
  return (
    `Operator-requested facility scan. Call ${calls} on your next turn so ` +
    `the dashboard can populate the Facilities view.`
  );
}

const router: Router = Router();

router.post('/', (req, res) => {
  const body = (req.body ?? {}) as { agent?: unknown; tab?: unknown };
  let target: string | undefined;
  let tab: Tab | undefined;

  if (body.agent !== undefined && body.agent !== null && body.agent !== '') {
    if (typeof body.agent !== 'string' || !body.agent.trim()) {
      res.status(400).json({ error: 'agent must be a string or omitted for fleet-wide' });
      return;
    }
    const trimmed = body.agent.trim();
    if (!validateAgentName(trimmed)) {
      res.status(404).json({ error: `Unknown agent: ${trimmed}` });
      return;
    }
    target = trimmed;
  }

  if (body.tab !== undefined && body.tab !== null && body.tab !== '') {
    if (typeof body.tab !== 'string' || !VALID_TABS.has(body.tab as Tab)) {
      res.status(400).json({
        error: 'tab must be one of "station", "owned", "build", "faction" (or omitted for all)',
      });
      return;
    }
    tab = body.tab as Tab;
  }

  const actions = tab ? TAB_ACTIONS[tab] : ALL_ACTIONS;
  const message = buildScanMessage(actions);

  // 30-minute expiry — if the agent isn't online to pick it up by then,
  // the operator will likely have moved on.
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  try {
    const orderId = createOrder({
      message,
      target_agent: target,
      priority: 'high',
      expires_at: expiresAt,
    });
    log.info('queued facility scan order', {
      orderId,
      target: target ?? '(fleet-wide)',
      tab: tab ?? '(all)',
      actions,
    });
    res.json({
      ok: true,
      orderId,
      target: target ?? null,
      tab: tab ?? null,
      actions,
    });
  } catch (err) {
    log.error('failed to queue facility scan order', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Failed to queue scan request' });
  }
});

export default router;
