/**
 * Standalone web-API Express app (no proxy/MCP).
 * Used by routes.test.ts and other tests that need the web API routes
 * without spinning up the full unified server.
 */
import express, { type Express } from 'express';
import { createServerStatusRouter } from './routes/server-status.js';
import { BreakerRegistry } from '../proxy/circuit-breaker.js';
import { MetricsWindow } from '../proxy/instability-metrics.js';
import { createLogsRouter } from './routes/logs.js';
import { getConfig, FLEET_DIR } from '../config.js';
import commsRoutes from './routes/comms.js';
import notesRoutes from './routes/notes.js';
import { createCaptainsLogsRouter } from './routes/captains-logs.js';
import injectRoutes from './routes/inject.js';
import analyticsRoutes from './routes/analytics.js';
import usageRoutes from './routes/usage.js';
import analyticsDbRoutes from './routes/analytics-db.js';
import turnsRoutes from './routes/turns.js';
import { createActionProxyRouter, type KickableSessionHandle } from './routes/action-proxy.js';
import mapRoutes from './routes/map.js';
import toolCallsRoutes from './routes/tool-calls.js';
import { createServerLogsRouter } from './routes/server-logs.js';
import combatRoutes from './routes/combat.js';
import knowledgeRoutes from './routes/knowledge.js';
import directivesRoutes from './routes/directives.js';
import { agentFleetControlRouter, routinesRouter } from './routes/fleet-control.js';
import diagnosticsRoutes from './routes/diagnostics.js';
import broadcastRoutes from './routes/broadcast.js';
import loreRoutes from './routes/lore.js';
import intelRoutes from './routes/intel.js';
import { createFacilitiesRouter } from './routes/facilities.js';
import { createCatalogRouter } from './routes/catalog.js';

const app: Express = express();

// strict: false allows bare JSON null (used for clearing battle state via PUT /api/action-proxy/battle-state/:agent)
app.use(express.json({ strict: false }));

// Prevent caching on API responses
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// API routes
app.get('/api/ping', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// /api/agents sub-routers
app.use('/api/agents', createLogsRouter(FLEET_DIR, getConfig()));
app.use('/api/agents', injectRoutes);
app.use('/api/agents', directivesRoutes);
app.use('/api/agents', agentFleetControlRouter);
app.use('/api/routines', routinesRouter);

// Simple routes
app.use('/api/comms', commsRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/analytics-db', analyticsDbRoutes);
app.use('/api/turns', turnsRoutes);
// Test-only stub sessions (no real game clients needed for web API tests)
const stubSessions: KickableSessionHandle = {
  listActive: () => [],
  resolveAgentName: (u: string) => u,
  getClient: () => undefined,
  removeClient: () => {},
};
app.use('/api/action-proxy', createActionProxyRouter(stubSessions, 0));
app.use('/api/map', mapRoutes);
app.use('/api/tool-calls', toolCallsRoutes);
app.use('/api/server/logs', createServerLogsRouter(FLEET_DIR));
app.use('/api/combat', combatRoutes);
app.use('/api/captains-logs', createCaptainsLogsRouter());
app.use('/api/knowledge', knowledgeRoutes);

// Diagnostics routes
app.use('/api/diagnostics', diagnosticsRoutes);

// Fleet broadcast
app.use('/api/fleet/broadcast', broadcastRoutes);

// POI Lore routes
app.use('/api/lore', loreRoutes);

// Intel routes (forum)
app.use('/api/intel', intelRoutes);

// Facilities + Catalog (use empty status cache for test app — no agents)
const emptyStatusCache = new Map();
app.use('/api/facilities', createFacilitiesRouter(emptyStatusCache));
app.use('/api/catalog', createCatalogRouter(emptyStatusCache));

// Test-specific server status route (simplified deps)
app.use('/api/server-status', createServerStatusRouter({ current: null }, new BreakerRegistry(), new MetricsWindow()));

export default app;
