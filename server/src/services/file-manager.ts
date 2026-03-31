import { readFile, writeFile, appendFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FLEET_DIR, validateAgentName } from '../config.js';
import type { CommsData } from '../shared/types.js';

// ── Comms ──

export async function readComms(): Promise<CommsData> {
  const commsDir = join(FLEET_DIR, 'comms');

  const orders = await safeReadFile(join(commsDir, 'orders.txt'));
  const bulletin = await safeReadFile(join(commsDir, 'bulletin.txt'));

  const reports: Record<string, string> = {};
  const reportsDir = join(commsDir, 'reports');
  try {
    const files = await readdir(reportsDir);
    const txtFiles = files.filter(f => f.endsWith('.txt'));
    const entries = await Promise.all(
      txtFiles.map(async (f) => {
        const agentName = f.replace('.txt', '');
        return [agentName, await safeReadFile(join(reportsDir, f))] as const;
      }),
    );
    for (const [name, content] of entries) {
      reports[name] = content;
    }
  } catch {
    // reports dir may not exist
  }

  return { orders, bulletin, reports };
}

function formatLogTimestamp(): string {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

async function appendCommsFile(filename: string, message: string): Promise<void> {
  const commsDir = join(FLEET_DIR, 'comms');
  await mkdir(commsDir, { recursive: true });
  await appendFile(join(commsDir, filename), `[${formatLogTimestamp()}] ${message}\n`, 'utf-8');
}

export async function appendOrder(message: string): Promise<void> {
  await appendCommsFile('orders.txt', message);
}

export async function appendBulletin(message: string): Promise<void> {
  await appendCommsFile('bulletin.txt', message);
}

export async function readReport(agentName: string): Promise<string> {
  if (!validateAgentName(agentName)) throw new Error(`Invalid agent: ${agentName}`);
  return safeReadFile(join(FLEET_DIR, 'comms', 'reports', `${agentName}.txt`));
}

export async function clearComms(): Promise<void> {
  const commsDir = join(FLEET_DIR, 'comms');
  await safeWriteFile(join(commsDir, 'orders.txt'), '');
  await safeWriteFile(join(commsDir, 'bulletin.txt'), '');
  try {
    const reportsDir = join(commsDir, 'reports');
    const files = await readdir(reportsDir);
    await Promise.all(
      files.filter(f => f.endsWith('.txt')).map(f => unlink(join(reportsDir, f))),
    );
  } catch {
    // ignore
  }
}

// ── Helpers ────────────────────────────────────────────────────

export async function safeReadFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function safeWriteFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, 'utf-8');
  } catch {
    // ignore
  }
}

