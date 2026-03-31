import { join } from 'node:path';
import { AGENTS, FLEET_DIR, TURN_SLEEP_MS, SOFT_STOP_TIMEOUT, SOFT_STOP_POLL_INTERVAL, getAgentLabel, validateAgentName } from '../config.js';
import * as proc from './process-manager.js';
import { createSignal, clearSignal } from './signals-db.js';
import { createLogger } from '../lib/logger.js';
import type { AgentConfig } from '../config.js';

const log = createLogger('agent-manager');

// Lifecycle hooks — wired by index.ts to connect health monitor without circular imports
type LifecycleHook = (agentName: string) => void;
const onStartedHooks: LifecycleHook[] = [];
const onStoppedHooks: LifecycleHook[] = [];

/** Replace all lifecycle hooks (backward compat — clears existing hooks first). */
export function setLifecycleHooks(hooks: { onStarted?: LifecycleHook; onStopped?: LifecycleHook }): void {
  onStartedHooks.length = 0;
  onStoppedHooks.length = 0;
  if (hooks.onStarted) onStartedHooks.push(hooks.onStarted);
  if (hooks.onStopped) onStoppedHooks.push(hooks.onStopped);
}

/** Append additional lifecycle hooks without replacing existing ones. */
export function addLifecycleHook(hooks: { onStarted?: LifecycleHook; onStopped?: LifecycleHook }): void {
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
  const model = agent.model ?? (backend === 'gemini' ? 'gemini-2.0-flash-exp' : 'haiku');
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

export async function startAgent(name: string): Promise<{ ok: boolean; message: string }> {
  if (!validateAgentName(name)) return { ok: false, message: `Unknown agent: ${name}` };

  log.info(`Starting agent via API: ${name}`);
  const running = await proc.hasSession(name);
  if (running) {
    log.warn(`Agent ${name} is already running`);
    return { ok: false, message: `${name} already running` };
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

export async function forceStopAgent(name: string): Promise<{ ok: boolean; message: string }> {
  if (!validateAgentName(name)) return { ok: false, message: `Unknown agent: ${name}` };

  const running = await proc.hasSession(name);
  if (!running) return { ok: false, message: `${name} not running` };

  await proc.killSession(name);
  for (const hook of onStoppedHooks) hook(name);
  return { ok: true, message: `${name} force-stopped` };
}

export async function softStopAgent(name: string): Promise<{ ok: boolean; message: string }> {
  if (!validateAgentName(name)) return { ok: false, message: `Unknown agent: ${name}` };

  const running = await proc.hasSession(name);
  if (!running) return { ok: false, message: `${name} not running` };

  // Inject shutdown instruction and write flag
  createSignal(name, 'inject', SHUTDOWN_MESSAGE);
  createSignal(name, 'shutdown');

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
      for (const hook of onStoppedHooks) hook(name);
      return { ok: true, message: `${name} stopped gracefully (${Math.floor(elapsed / 1000)}s)` };
    }
  }

  // Timeout — hard kill (not graceful)
  await proc.killSession(name);
  clearSignal(name, 'shutdown');
  for (const hook of onStoppedHooks) hook(name);
  return { ok: true, message: `${name} force-stopped after timeout (${Math.floor(SOFT_STOP_TIMEOUT / 1000)}s)` };
}

// Keep stopAgent as alias for soft stop (backward compat)
export async function stopAgent(name: string): Promise<{ ok: boolean; message: string }> {
  return softStopAgent(name);
}

export async function forceRestartAgent(name: string): Promise<{ ok: boolean; message: string }> {
  await forceStopAgent(name);
  await sleep(2000);
  return startAgent(name);
}

export async function softRestartAgent(name: string): Promise<{ ok: boolean; message: string }> {
  await softStopAgent(name);
  await sleep(2000);
  return startAgent(name);
}

export async function restartAgent(name: string): Promise<{ ok: boolean; message: string }> {
  return softRestartAgent(name);
}

export async function startAll(): Promise<string[]> {
  const messages: string[] = [];
  for (let i = 0; i < AGENTS.length; i++) {
    const agent = AGENTS[i];
    if (i > 0) await sleep(20000);
    const result = await startAgent(agent.name);
    messages.push(result.message);
  }
  return messages;
}

export async function stopAll(): Promise<string[]> {
  const results = await Promise.all(
    AGENTS.map(agent => softStopAgent(agent.name))
  );
  return results.map(r => r.message);
}

export async function forceStopAll(): Promise<string[]> {
  const results = await Promise.all(
    AGENTS.map(agent => forceStopAgent(agent.name))
  );
  return results.map(r => r.message);
}
