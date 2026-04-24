import { join } from 'node:path';
import { AGENTS, FLEET_DIR, TURN_SLEEP_MS, SOFT_STOP_TIMEOUT, SOFT_STOP_POLL_INTERVAL, getAgentLabel, validateAgentName, getConfig, DEFAULT_STAGGER_DELAY } from '../config.js';
import * as proc from './process-manager.js';
import { createSignal, clearSignal } from './signals-db.js';
import { createLogger } from '../lib/logger.js';
import type { AgentConfig } from '../config.js';
import { getCredentialStartBlock } from './credential-health.js';
import { disableFleet, enableFleet, getFleetDisabledState } from './fleet-control.js';

const log = createLogger('agent-manager');

// Lifecycle hooks — wired by index.ts to connect health monitor without circular imports
type LifecycleHook = (agentName: string) => void;
type StopKind = 'soft' | 'force' | 'timeout';
type StoppedHook = (agentName: string, kind: StopKind) => void;
const onStartedHooks: LifecycleHook[] = [];
const onStoppedHooks: StoppedHook[] = [];

/** Replace all lifecycle hooks (backward compat — clears existing hooks first). */
export function setLifecycleHooks(hooks: { onStarted?: LifecycleHook; onStopped?: StoppedHook }): void {
  onStartedHooks.length = 0;
  onStoppedHooks.length = 0;
  if (hooks.onStarted) onStartedHooks.push(hooks.onStarted);
  if (hooks.onStopped) onStoppedHooks.push(hooks.onStopped);
}

/** Append additional lifecycle hooks without replacing existing ones. */
export function addLifecycleHook(hooks: { onStarted?: LifecycleHook; onStopped?: StoppedHook }): void {
  if (hooks.onStarted) onStartedHooks.push(hooks.onStarted);
  if (hooks.onStopped) onStoppedHooks.push(hooks.onStopped);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildStartSpec(agent: AgentConfig): proc.SessionLaunchSpec {
  const runnerExecutable = join(FLEET_DIR, 'gantry-runner');
  const name = agent.name;
  const backend = agent.backend || 'claude';
  const model = agent.model
    ?? (backend === 'gemini' ? 'gemini-2.0-flash-exp'
      : backend === 'codex' ? 'gpt-5.3-codex'
        : 'haiku');
  const extraTools = agent.extraTools ?? 'none';
  const interval = (agent as AgentConfig & { turnSleepMs?: number; turnInterval?: number }).turnSleepMs
    ?? (agent as AgentConfig & { turnSleepMs?: number; turnInterval?: number }).turnInterval
    ?? TURN_SLEEP_MS;
  
  // v2 agents use a different tool allowlist
  const mcpVersion = agent.mcpVersion ?? 'v2';
  const mcpAllow = 'mcp__gantry__*';
  const mcpConfig = mcpVersion === 'overseer' ? 'mcp-overseer.json'
    : mcpVersion === 'v2' ? 'mcp-v2.json' : 'mcp.json';

  const args: string[] = [
    '--agent', name,
    '--agentDir', FLEET_DIR,
    '--backend', backend,
    '--model', model,
    '--interval', String(interval),
    '--extraTools', extraTools,
    '--mcpAllow', mcpAllow,
    '--mcpConfig', mcpConfig,
  ];

  if (agent.systemPrompt) {
    args.push('--systemPrompt', agent.systemPrompt);
  }

  // Compaction model support — pass a cheaper model for context compaction when configured.
  // compactionEnabled defaults to true; only skip when explicitly set to false.
  const compactionEnabled = agent.compactionEnabled !== false;
  if (compactionEnabled && agent.compactionModel) {
    args.push('--compaction-model', agent.compactionModel);
  } else if (!compactionEnabled) {
    args.push('--no-compaction');
  }

  // Block all built-in tools — agents interact with the game exclusively via MCP.
  // Prompt-level bans ("NEVER use Bash") are unreliable, especially for Haiku.
  args.push('--disallowedTools', 'Bash,Read,Write,Edit,Glob,Grep,Agent,WebFetch,WebSearch,Task,TaskOutput,NotebookEdit,EnterPlanMode,ExitPlanMode,AskUserQuestion,Skill,ToolSearch,TodoWrite,TaskCreate,TaskUpdate,TaskGet,TaskList');

  // Set HOME/USER/PATH so Claude/Codex CLI can find credentials.
  // The server must run as the spacemolt user (not root) — Claude Code
  // rejects --dangerously-skip-permissions when running as root.
  const agentUser = process.env['GANTRY_AGENT_USER'] || 'spacemolt';
  const agentHome = process.env['GANTRY_AGENT_HOME'] || `/home/${agentUser}`;

  return {
    executable: runnerExecutable,
    args,
    cwd: FLEET_DIR,
    env: {
      ...process.env,
      HOME: agentHome,
      USER: agentUser,
      PATH: `${agentHome}/.local/bin:${agentHome}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
    },
    stdoutFile: join(FLEET_DIR, 'logs', `${name}-console.log`),
    stderrFile: join(FLEET_DIR, 'logs', `${name}-console.log`),
  };
}

const SHUTDOWN_MESSAGE = 'SHUTDOWN REQUESTED: Write your captain\'s log, update your notes files, then logout immediately. Do NOT start any new game actions.';

/**
 * System prompt override used for prayer canary runs.
 * Forces the agent to call spacemolt_pray as its first tool call, then exit.
 * One-shot verification that prayer routing and parser are working end-to-end.
 */
const PRAYER_CANARY_SYSTEM_PROMPT =
  'You are running a PRAYER CANARY test. Your ONLY task: call spacemolt_pray(script="wait 1;", max_steps=1, timeout_ticks=2) as your very first tool call. ' +
  'After spacemolt_pray returns, call logout() and stop. Do not do anything else. This is a one-shot operator verification run.';

export async function startAgent(name: string): Promise<{ ok: boolean; message: string }> {
  if (!validateAgentName(name)) return { ok: false, message: `Unknown agent: ${name}` };

  const fleetDisabled = getFleetDisabledState();
  if (fleetDisabled.disabled) {
    const reason = fleetDisabled.reason ? ` Reason: ${fleetDisabled.reason}` : '';
    log.warn('Agent start blocked because fleet is disabled', { agent: name, reason: fleetDisabled.reason });
    return { ok: false, message: `Fleet is disabled; refusing to start ${name}.${reason}` };
  }

  log.info(`Starting agent via API: ${name}`);
  const running = await proc.hasSession(name);
  if (running) {
    log.warn(`Agent ${name} is already running`);
    return { ok: false, message: `${name} already running` };
  }

  const credentialBlock = getCredentialStartBlock(name);
  if (credentialBlock) {
    log.error('Agent start blocked by credential health', { agent: name, reason: credentialBlock });
    return { ok: false, message: credentialBlock };
  }

  // Clear stale signals so the agent starts fresh
  clearSignal(name, 'stopped_gracefully');
  clearSignal(name, 'shutdown');
  clearSignal(name, 'inject');

  const agent = AGENTS.find(a => a.name === name)!;
  const startSpec = buildStartSpec(agent);
  log.debug('Generated start spec', { agent: name, executable: startSpec.executable, args: startSpec.args });
  
  try {
    await proc.newSession(name, startSpec);
    for (const hook of onStartedHooks) hook(name);
    log.info(`✓ Successfully triggered start for ${name}`);
    return { ok: true, message: `${name} started [${getAgentLabel(agent)}]` };
  } catch (err) {
    log.error(`Failed to start agent ${name}: ${err}`);
    return { ok: false, message: `System error starting agent: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Start an agent in prayer canary mode.
 *
 * Overrides the system prompt with a minimal directive that instructs the agent
 * to call spacemolt_pray as its first action, then exit. This lets the operator
 * verify prayer behavior without waiting for a natural prayer-eligible moment.
 *
 * Canary sessions are short (1 turn) and bypass the fleet-disabled guard so the
 * operator can test even when the fleet is paused.
 */
export async function startAgentCanary(name: string): Promise<{ ok: boolean; message: string }> {
  if (!validateAgentName(name)) return { ok: false, message: `Unknown agent: ${name}` };

  log.info(`Starting prayer canary for agent: ${name}`);
  const running = await proc.hasSession(name);
  if (running) {
    return { ok: false, message: `${name} is already running — stop it before running a canary` };
  }

  const credentialBlock = getCredentialStartBlock(name);
  if (credentialBlock) {
    log.error('Canary start blocked by credential health', { agent: name, reason: credentialBlock });
    return { ok: false, message: credentialBlock };
  }

  clearSignal(name, 'stopped_gracefully');
  clearSignal(name, 'shutdown');
  clearSignal(name, 'inject');

  const agent = AGENTS.find(a => a.name === name)!;
  const startSpec = buildStartSpec({ ...agent, systemPrompt: PRAYER_CANARY_SYSTEM_PROMPT });
  log.debug('Generated canary start spec', { agent: name });

  try {
    await proc.newSession(name, startSpec);
    for (const hook of onStartedHooks) hook(name);
    log.info(`✓ Prayer canary started for ${name}`);
    return { ok: true, message: `Prayer canary started for ${name} — watch logs for spacemolt_pray call` };
  } catch (err) {
    log.error(`Failed to start canary for ${name}: ${err}`);
    return { ok: false, message: `System error starting canary: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function forceStopAgent(name: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  if (!validateAgentName(name)) return { ok: false, message: `Unknown agent: ${name}` };

  const running = await proc.hasSession(name);
  if (!running) {
    for (const hook of onStoppedHooks) hook(name, 'force');
    return { ok: false, message: `${name} not running` };
  }

  log.info('Force-stopping agent', { agent: name, reason: reason ?? 'unspecified' });
  await proc.killSession(name);
  for (const hook of onStoppedHooks) hook(name, 'force');
  return { ok: true, message: `${name} force-stopped` };
}

export async function softStopAgent(name: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  if (!validateAgentName(name)) return { ok: false, message: `Unknown agent: ${name}` };

  const running = await proc.hasSession(name);
  if (!running) return { ok: false, message: `${name} not running` };

  // Log the source so mysterious shutdowns can be traced. Every caller
  // (overseer, fleet-health, API, stop-all) should pass a reason string.
  log.info('Soft-stopping agent', { agent: name, reason: reason ?? 'unspecified' });

  // Inject shutdown instruction and write flag. Attach the reason to the
  // shutdown signal so the runner log records who initiated the stop.
  createSignal(name, 'inject', SHUTDOWN_MESSAGE);
  createSignal(name, 'shutdown', reason ?? 'unspecified');

  // Poll for session end
  let elapsed = 0;
  while (elapsed < SOFT_STOP_TIMEOUT) {
    await sleep(SOFT_STOP_POLL_INTERVAL);
    elapsed += SOFT_STOP_POLL_INTERVAL;
    const stillRunning = await proc.hasSession(name);
    if (!stillRunning) {
      clearSignal(name, 'shutdown');
      // Mark as gracefully stopped so status can distinguish from a crash
      createSignal(name, 'stopped_gracefully');
      for (const hook of onStoppedHooks) hook(name, 'soft');
      return { ok: true, message: `${name} stopped gracefully (${Math.floor(elapsed / 1000)}s)` };
    }
  }

  // Timeout — hard kill (not graceful)
  await proc.killSession(name);
  clearSignal(name, 'shutdown');
  for (const hook of onStoppedHooks) hook(name, 'timeout');
  return { ok: true, message: `${name} force-stopped after timeout (${Math.floor(SOFT_STOP_TIMEOUT / 1000)}s)` };
}

// Keep stopAgent as alias for soft stop (backward compat)
export async function stopAgent(name: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  return softStopAgent(name, reason);
}

export async function forceRestartAgent(name: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  enableFleet(`restart ${name}`);
  await forceStopAgent(name, reason ?? `restart ${name}`);
  await sleep(2000);
  return startAgent(name);
}

export async function softRestartAgent(name: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  enableFleet(`restart ${name}`);
  await softStopAgent(name, reason ?? `restart ${name}`);
  await sleep(2000);
  return startAgent(name);
}

export async function restartAgent(name: string, reason?: string): Promise<{ ok: boolean; message: string }> {
  return softRestartAgent(name, reason);
}

/**
 * Models we consider "heavy-token" — agents using these need a larger
 * stagger between launches so their simultaneous warm-up prompts don't
 * race each other into the weekly token quota wall. Observed: rust-vane
 * and sable-thorn starting together burned 8 min on failed turns.
 */
const HEAVY_TOKEN_MODELS = new Set(['sonnet', 'opus']);

function isHeavyTokenAgent(agent: { model?: string }): boolean {
  const model = (agent.model ?? '').toLowerCase();
  for (const heavy of HEAVY_TOKEN_MODELS) {
    if (model.includes(heavy)) return true;
  }
  return false;
}

/**
 * Resolve the inter-agent startup stagger in milliseconds.
 * Reads fleet-config.staggerDelay (seconds); falls back to DEFAULT_STAGGER_DELAY
 * if getConfig is unavailable (e.g. during boot before config loads).
 */
function getStaggerMs(): number {
  try {
    const cfg = getConfig();
    return (cfg.staggerDelay ?? DEFAULT_STAGGER_DELAY) * 1000;
  } catch {
    return DEFAULT_STAGGER_DELAY * 1000;
  }
}

export async function startAll(): Promise<string[]> {
  enableFleet('start-all');
  const messages: string[] = [];
  const baseStaggerMs = getStaggerMs();
  // Between two heavy-token (Sonnet/Opus) agents, double the stagger so
  // their large system prompts don't pile into the account quota at once.
  // Example: rust-vane (sonnet) → sable-thorn (sonnet) now waits 2x.
  const heavyPairStaggerMs = baseStaggerMs * 2;

  for (let i = 0; i < AGENTS.length; i++) {
    const agent = AGENTS[i];
    if (i > 0) {
      const prev = AGENTS[i - 1];
      const bothHeavy = isHeavyTokenAgent(prev) && isHeavyTokenAgent(agent);
      const delay = bothHeavy ? heavyPairStaggerMs : baseStaggerMs;
      log.info('startAll: staggering before next agent', {
        prev: prev.name,
        next: agent.name,
        delayMs: delay,
        bothHeavy,
      });
      await sleep(delay);
    }
    const result = await startAgent(agent.name);
    messages.push(result.message);
  }
  return messages;
}

export async function stopAll(reason?: string): Promise<string[]> {
  disableFleet('stop-all');
  const stopReason = reason ?? 'stop-all';
  const results = await Promise.all(
    AGENTS.map(agent => softStopAgent(agent.name, stopReason))
  );
  return results.map(r => r.message);
}

export async function forceStopAll(reason?: string): Promise<string[]> {
  disableFleet('force stop-all');
  const stopReason = reason ?? 'force stop-all';
  const results = await Promise.all(
    AGENTS.map(agent => forceStopAgent(agent.name, stopReason))
  );
  return results.map(r => r.message);
}
