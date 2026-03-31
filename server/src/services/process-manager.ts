import * as childProcess from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { validateAgentName, FLEET_DIR } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('process-manager');

/**
 * Async exec wrapper. All command strings in this module are fixed literals
 * with no user-supplied input interpolated, so exec is appropriate.
 */
function execAsync(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    childProcess.exec(cmd, { timeout: 5000 }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

const SYSTEM_SESSIONS = new Set(['gantry-server']);

export interface SessionLaunchSpec {
  executable: string;
  args: string[];
  cwd?: string;
  stdoutFile?: string;
  stderrFile?: string;
  env?: NodeJS.ProcessEnv;
}

/** In-memory map of tracked child processes. Authoritative for status checks. */
const trackedProcesses = new Map<string, childProcess.ChildProcess>();

function assertValidName(name: string): void {
  if (!validateAgentName(name) && !SYSTEM_SESSIONS.has(name)) {
    throw new Error(`Invalid process name: ${name}`);
  }
}

function getPidFile(name: string): string {
  return join(FLEET_DIR, 'data', 'pids', `${name}.pid`);
}

function getLogFile(name: string): string {
  return join(FLEET_DIR, 'logs', `${name}.log`);
}

/**
 * Write PID file as a secondary record for external tooling.
 * NOT used for status checks — in-memory ChildProcess ref is authoritative.
 */
function writePidFile(name: string, pid: number): void {
  try {
    mkdirSync(join(FLEET_DIR, 'data', 'pids'), { recursive: true });
    writeFileSync(getPidFile(name), String(pid), 'utf-8');
  } catch {
    // Non-fatal: data dir may not be configured for this host
  }
}

function removePidFile(name: string): void {
  try {
    unlinkSync(getPidFile(name));
  } catch {
    // Ignore missing file
  }
}

/**
 * Check if a tracked ChildProcess is still alive.
 * exitCode is null while running, non-null after termination.
 */
function isProcessAlive(child: childProcess.ChildProcess): boolean {
  return child.exitCode === null && !child.killed && child.pid !== undefined;
}

export async function hasSession(name: string): Promise<boolean> {
  assertValidName(name);

  // Check in-memory tracked process first (authoritative for server-spawned processes)
  const child = trackedProcesses.get(name);
  if (child) {
    if (isProcessAlive(child)) return true;
    // Dead ref — clean up
    trackedProcesses.delete(name);
    removePidFile(name);
    return false;
  }

  // Fallback: check PID file for externally-spawned processes (e.g. fleet CLI improve loop)
  return isPidFileAlive(name);
}

/**
 * Check if a PID file exists and the process is still running.
 * Used as fallback for processes not spawned by this server instance.
 */
function isPidFileAlive(name: string): boolean {
  const pidFile = getPidFile(name);
  if (!existsSync(pidFile)) return false;

  try {
    const pidStr = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid) || pid <= 0) return false;

    // signal 0 tests if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist or PID file is unreadable — clean up stale file
    removePidFile(name);
    return false;
  }
}

export async function newSession(name: string, spec: SessionLaunchSpec): Promise<void> {
  assertValidName(name);

  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  let stderrSharesStdout = false;

  try {
    if (spec.stdoutFile) {
      stdoutFd = openSync(spec.stdoutFile, 'a');
    }
    if (spec.stderrFile) {
      if (spec.stdoutFile && spec.stderrFile === spec.stdoutFile && stdoutFd !== undefined) {
        stderrFd = stdoutFd;
        stderrSharesStdout = true;
      } else {
        stderrFd = openSync(spec.stderrFile, 'a');
      }
    }

    const stdio: childProcess.StdioOptions = [
      'ignore',
      stdoutFd ?? 'ignore',
      stderrFd ?? 'ignore',
    ];

    const spawnOptions: childProcess.SpawnOptions = {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      detached: true,
      stdio,
    };

    // If running as root and spec.env.USER is set to a non-root user,
    // drop privileges so Claude/Codex CLI doesn't reject --dangerously-skip-permissions.
    if (process.getuid?.() === 0 && spec.env?.USER && spec.env.USER !== 'root') {
      try {
        const uid = parseInt(childProcess.execFileSync('id', ['-u', spec.env.USER], { encoding: 'utf-8' }).trim(), 10);
        const gid = parseInt(childProcess.execFileSync('id', ['-g', spec.env.USER], { encoding: 'utf-8' }).trim(), 10);
        if (!isNaN(uid) && !isNaN(gid)) {
          spawnOptions.uid = uid;
          spawnOptions.gid = gid;
        }
      } catch (err) {
        log.warn(`Could not resolve uid/gid for user ${spec.env.USER} — spawning as current user: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const child = childProcess.spawn(spec.executable, spec.args, spawnOptions);

    // Register in-memory ref — authoritative source of truth for status
    trackedProcesses.set(name, child);

    // Auto-clean on exit
    child.on('exit', () => {
      const current = trackedProcesses.get(name);
      if (current === child) {
        trackedProcesses.delete(name);
        removePidFile(name);
      }
    });

    // Write PID file as secondary record for external tooling
    if (child.pid !== undefined) {
      writePidFile(name, child.pid);
    }

    child.unref();
  } finally {
    if (stdoutFd !== undefined) {
      closeSync(stdoutFd);
    }
    if (stderrFd !== undefined && !stderrSharesStdout) {
      closeSync(stderrFd);
    }
  }
}

/** Send SIGTERM to a pid with a SIGKILL fallback after 2s. */
function killWithFallback(killFn: (sig: NodeJS.Signals) => void): void {
  killFn('SIGTERM');
  setTimeout(() => {
    try { killFn('SIGKILL'); } catch { /* already dead */ }
  }, 2000);
}

export async function killSession(name: string): Promise<void> {
  assertValidName(name);

  const child = trackedProcesses.get(name);
  if (child && isProcessAlive(child)) {
    killWithFallback((sig) => child.kill(sig));
    return;
  }

  if (child) {
    // Dead ref — clean up
    trackedProcesses.delete(name);
    removePidFile(name);
    return;
  }

  // Fallback: kill externally-spawned process via PID file
  const pidFile = getPidFile(name);
  if (existsSync(pidFile)) {
    try {
      const pidStr = readFileSync(pidFile, 'utf-8').trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid) && pid > 0) {
        killWithFallback((sig) => process.kill(pid, sig));
      }
    } catch (err) {
      log.warn(`killSession: failed to kill ${name} via PID file: ${err instanceof Error ? err.message : String(err)}`);
    }
    removePidFile(name);
  }
}

export async function capturePane(name: string, lines = 40): Promise<string> {
  assertValidName(name);
  const logFile = getLogFile(name);
  if (!existsSync(logFile)) return '';

  try {
    // Use spawn with argument array — avoids shell interpolation entirely
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = childProcess.spawn('tail', ['-n', String(lines), logFile]);
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk; });
      child.on('close', (code: number | null) =>
        code === 0 ? resolve(output) : reject(new Error(`tail exited ${code}`))
      );
      child.on('error', reject);
    });
    return stdout;
  } catch (err) {
    log.warn(`capturePane failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/**
 * Scan for orphaned processes not tracked by this server instance.
 *
 * Primary: reads PID files from $FLEET_DIR/data/pids/ and checks liveness.
 * Fallback: `ps aux` filtered for gantry/fleet-agents commands.
 *
 * Returns PIDs + command lines for operator review. Does NOT kill anything —
 * caller decides. Intended for post-restart recovery flows.
 */
export async function scanOrphanedProcesses(): Promise<Array<{ pid: number; cmd: string }>> {
  const trackedPids = new Set<number>();
  for (const child of trackedProcesses.values()) {
    if (child.pid !== undefined) trackedPids.add(child.pid);
  }

  const seen = new Set<number>();
  const orphans: Array<{ pid: number; cmd: string }> = [];

  // Primary: check PID files (authoritative for server-spawned processes)
  try {
    const pidDir = join(FLEET_DIR, 'data', 'pids');
    if (existsSync(pidDir)) {
      const files = readdirSync(pidDir).filter(f => f.endsWith('.pid'));
      for (const file of files) {
        try {
          const pidStr = readFileSync(join(pidDir, file), 'utf-8').trim();
          const pid = parseInt(pidStr, 10);
          if (isNaN(pid) || pid <= 0 || trackedPids.has(pid) || seen.has(pid)) continue;
          process.kill(pid, 0); // throws if dead
          seen.add(pid);
          orphans.push({ pid, cmd: `pid-file:${file.replace('.pid', '')}` });
        } catch {
          // dead process or unreadable — skip
        }
      }
    }
  } catch (err) {
    log.warn(`scanOrphanedProcesses PID file scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fallback: ps-based scan for processes not covered by PID files
  try {
    const { stdout } = await execAsync(
      "ps aux | grep -E 'gantry|fleet-agents' | grep -v grep | awk '{print $2, $11, $12, $13}'"
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      const cmd = parts.slice(1).join(' ');
      if (!isNaN(pid) && !trackedPids.has(pid) && !seen.has(pid)) {
        seen.add(pid);
        orphans.push({ pid, cmd });
      }
    }
  } catch (err) {
    log.warn(`scanOrphanedProcesses ps fallback failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return orphans;
}

/** Exposed for testing: get the current tracked process map. */
export function _getTrackedProcesses(): Map<string, childProcess.ChildProcess> {
  return trackedProcesses;
}
