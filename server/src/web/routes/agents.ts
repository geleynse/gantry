import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import type { AgentStatus, AgentStatusWithShutdown } from '../../shared/types.js';
import type { BattleState } from '../../proxy/server.js';
import type { AgentConfig, GantryConfig } from '../../config.js';
import { resolveConfigPath, saveConfig, getAgentLabel } from '../config.js';
import { composePrompt } from '../../lib/prompt-composer.js';
import * as proc from '../../services/process-manager.js';
import { parseAgentLog, formatAge } from '../../services/log-parser.js';
import { getHealthScore } from '../../services/health-scorer.js';
import { hasSignal, createSignal } from '../../services/signals-db.js';
import { getSessionShutdownManager } from '../../proxy/session-shutdown.js';
import { hasActiveProxySession, getLastActivityAt } from '../../services/agent-queries.js';
import {
  startAgent, stopAgent, restartAgent, startAll, stopAll,
  forceStopAgent, forceRestartAgent, softStopAgent, softRestartAgent, forceStopAll,
} from '../../services/agent-manager.js';
import { disableFleet, enableFleet, enableFleetState, getFleetDisabledState } from '../../services/fleet-control.js';
import { getCredentialHealth } from '../../services/credential-health.js';
import type { BreakerRegistry } from '../../proxy/circuit-breaker.js';

export function createAgentRouter(
  battleCache: Map<string, BattleState | null>,
  breakerRegistry: BreakerRegistry,
  fleetDir: string,
  config: GantryConfig,
): Router {
  const router = Router();

  const agents = config.agents;
  const agentNames = new Set(agents.map((a) => a.name));

  function isValidAgent(name: string): boolean {
    return agentNames.has(name);
  }

  function findAgent(name: string): AgentConfig | undefined {
    return agents.find((a) => a.name === name);
  }

  /**
   * Build shutdown and battle state information for an agent.
   */
  async function buildAgentShutdownStatus(agentName: string): Promise<AgentStatusWithShutdown> {
    const shutdownManager = getSessionShutdownManager();
    const inBattle = battleCache.has(agentName) && battleCache.get(agentName) !== null;
    const llmRunning = await proc.hasSession(agentName);

    return {
      inBattle,
      shutdownState: shutdownManager.getShutdownState(agentName),
      llmRunning,
      proxySessionActive: hasActiveProxySession(agentName),
      lastActivityAt: getLastActivityAt(agentName),
    };
  }

  async function buildAgentStatus(agent: AgentConfig): Promise<AgentStatus> {
    const running = await proc.hasSession(agent.name);
    const shutdownPending = hasSignal(agent.name, 'shutdown');
    const health = await getHealthScore(agent.name, breakerRegistry);

    const base = {
      name: agent.name,
      backend: getAgentLabel(agent),
      model: agent.model || agent.backend,
      role: agent.role,
      roleType: agent.roleType,
      skillModules: agent.skillModules,
      operatingZone: agent.operatingZone,
      factionNote: agent.factionNote,
      shutdownPending,
      healthScore: health.score,
      healthIssues: health.issues,
    };

    if (!running) {
      const stoppedGracefully = hasSignal(agent.name, 'stopped_gracefully') || hasSignal(agent.name, 'shutdown');
      return {
        ...base,
        llmRunning: false,
        state: stoppedGracefully ? 'stopped' : 'dead',
        turnCount: 0,
        quotaHits: 0,
        authHits: 0,
        lastGameOutput: [],
      };
    }

    const agentLog = await parseAgentLog(agent.name);

    return {
      ...base,
      model: agent.model,
      llmRunning: true,
      state: agentLog?.state ?? 'unreachable',
      turnCount: agentLog?.turnCount ?? 0,
      lastTurnAge: agentLog?.lastTurnAgeSeconds != null ? formatAge(agentLog.lastTurnAgeSeconds) : undefined,
      lastTurnAgeSeconds: agentLog?.lastTurnAgeSeconds ?? undefined,
      quotaHits: agentLog?.quotaHits ?? 0,
      authHits: agentLog?.authHits ?? 0,
      lastGameOutput: agentLog?.lastGameOutput ?? [],
    };
  }

  function buildCredentialHealth(agentName: string): { status: 'ok' | 'auth_failed' | 'unknown'; lastFailureAt?: number; reason?: string } {
    const entry = getCredentialHealth(agentName);
    if (!entry) return { status: 'unknown' };
    if (entry.status === 'auth_failed') {
      return { status: 'auth_failed', lastFailureAt: entry.checkedAt, reason: `credentials for "${entry.username}" failed authentication` };
    }
    return { status: 'ok', lastFailureAt: entry.checkedAt };
  }

  // List all agents with shutdown and battle state
  router.get('/', async (req, res) => {
    const agentStatuses = await Promise.all(
      agents.map(async (agent) => ({
        name: agent.name,
        backend: getAgentLabel(agent),
        model: agent.model || agent.backend,
        credentialHealth: buildCredentialHealth(agent.name),
        ...(await buildAgentShutdownStatus(agent.name)),
      }))
    );
    res.json({ agents: agentStatuses });
  });

  // Fleet-wide actions (must be before :name routes)
  router.get('/fleet-state', (_req, res) => {
    res.json(getFleetDisabledState());
  });

  router.post('/fleet-state/enable', (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'manual enable';
    res.json(enableFleetState(reason));
  });

  router.post('/fleet-state/disable', (req, res) => {
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim()
      : 'manual disable';
    res.json(disableFleet(reason));
  });

  router.post('/start-all', async (req, res) => {
    const messages = await startAll();
    res.json({ ok: true, messages });
  });

  router.post('/stop-all', async (req, res) => {
    const force = req.query.force === 'true';
    const messages = force ? await forceStopAll('API stop-all') : await stopAll('API stop-all');
    res.json({ ok: true, messages });
  });

  async function readPromptFile(filename: string): Promise<string | null> {
    try {
      return await readFile(join(fleetDir, filename), 'utf-8');
    } catch {
      return null;
    }
  }

  // Agent prompt files
  router.get('/:name/prompts', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const [main, personality, commonRules, personalityRules] = await Promise.all([
      readPromptFile(`${name}.txt`),
      readPromptFile(`${name}-values.txt`),
      readPromptFile('common-rules.txt'),
      readPromptFile('personality-rules.txt'),
    ]);

    res.json({ main, personality, commonRules, personalityRules });
  });

  // Composed prompt (layered prompt-composer output)
  router.get('/:name/composed-prompt', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const agent = findAgent(name);
    if (!agent) {
      res.status(404).json({ error: `Agent ${name} not found in config` });
      return;
    }

    const composed = composePrompt({
      fleetDir,
      agentName: name,
      roleType: agent.roleType,
      role: agent.role,
      faction: agent.faction,
    });

    res.json({
      agentName: name,
      layered: composed.layered,
      layers: composed.layers,
      prompt: composed.prompt,
      promptLength: composed.prompt.length,
    });
  });

  // Single agent detail
  router.get('/:name', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const agent = findAgent(name)!;
    const status = await buildAgentStatus(agent);
    const logLines = await proc.capturePane(name, 50);

    let personality: string | null = null;
    try {
      personality = await readFile(join(fleetDir, `${name}-values.txt`), 'utf-8');
    } catch {
      // No values file
    }

    res.json({ ...status, logLines, personality });
  });

  // Update agent configuration (backend/model)
  router.patch('/:name/config', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    // Safety check: don't change config while running
    const running = await proc.hasSession(name);
    if (running) {
      res.status(400).json({ error: `Agent ${name} is currently running. Stop it before changing configuration.` });
      return;
    }

    const { backend, model } = req.body as { backend?: string; model?: string };
    if (!backend && !model) {
      res.status(400).json({ error: 'Provide at least backend or model to update' });
      return;
    }

    try {
      const configPath = resolveConfigPath(fleetDir);
      const raw = JSON.parse(await readFile(configPath, 'utf-8'));

      const agent = raw.agents.find((a: any) => a.name === name);
      if (!agent) {
        res.status(404).json({ error: `Agent ${name} not found in config file` });
        return;
      }

      let changed = false;
      if (backend) {
        const b = backend.toLowerCase();
        if (['claude', 'codex', 'gemini'].includes(b)) {
          if (agent.backend !== b) {
            agent.backend = b;
            changed = true;
          }
        } else {
          res.status(400).json({ error: `Invalid backend "${backend}". Use: claude, codex, gemini` });
          return;
        }
      }

      if (model) {
        if (agent.model !== model) {
          agent.model = model;
          changed = true;
        }
      }

      if (changed) {
        saveConfig(raw);
        res.json({ ok: true, message: `Updated configuration for ${name}`, agent: { backend: agent.backend, model: agent.model } });
      } else {
        res.json({ ok: true, message: 'No changes needed', agent: { backend: agent.backend, model: agent.model } });
      }
    } catch (err) {
      res.status(500).json({ error: `Failed to update config: ${(err as Error).message}` });
    }
  });

  // Single agent actions
  router.post('/:name/start', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }
    enableFleet(`start ${name}`);
    const result = await startAgent(name);
    res.json(result);
  });

  router.post('/:name/stop', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }
    const force = req.query.force === 'true';
    const result = force ? await forceStopAgent(name, 'API stop') : await softStopAgent(name, 'API stop');
    res.json(result);
  });

  router.post('/:name/restart', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }
    const force = req.query.force === 'true';
    enableFleet(`restart ${name}`);
    const result = force ? await forceRestartAgent(name, 'API restart') : await softRestartAgent(name, 'API restart');
    res.json(result);
  });

  // Request stop-after-turn for an agent
  router.post('/:name/stop-after-turn', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    const running = await proc.hasSession(name);
    if (!running) {
      res.status(400).json({ error: `${name} is not currently running` });
      return;
    }

    const { reason } = req.body as { reason?: string };
    const shutdownManager = getSessionShutdownManager();
    const shutdownState = shutdownManager.requestStopAfterTurn(name, reason || 'API request');

    res.json({
      ok: true,
      message: `${name} will stop after its current turn completes`,
      state: shutdownState,
    });
  });

  // Initiate graceful agent shutdown
  router.post('/:name/shutdown', async (req, res) => {
    const name = req.params.name;
    if (!isValidAgent(name)) {
      res.status(404).json({ error: `Unknown agent: ${name}` });
      return;
    }

    // Check if agent is running
    const running = await proc.hasSession(name);
    if (!running) {
      res.status(400).json({ error: `${name} is not currently running` });
      return;
    }

    // Extract optional reason from request body
    const { reason } = req.body as { reason?: string };

    // Check if agent is in battle
    const inBattle = battleCache.has(name) && battleCache.get(name) !== null;

    // Request shutdown via SessionShutdownManager
    const shutdownManager = getSessionShutdownManager();
    const shutdownState = shutdownManager.requestShutdown(name, inBattle, reason || 'API request');

    // Also create a shutdown signal so the pipeline guardrails detect it on next tool call.
    // Without this, the shutdown state only restricts tools but never tells the agent to stop.
    createSignal(name, 'shutdown', reason || 'API request');

    res.json({
      ok: true,
      message: `${name} shutdown initiated`,
      state: shutdownState,
      inBattle,
    });
  });

  return router;
}

export default createAgentRouter;
