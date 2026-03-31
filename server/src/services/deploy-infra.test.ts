/**
 * Tests for #249 (binary build) and #313 (process manager refactor).
 *
 * Binary build tests verify script + config generation without actually
 * invoking `bun build --compile` (which requires a full build environment).
 * Setup script tests run the TS script against a temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, '../../');
const SETUP_SCRIPT = resolve(SERVER_ROOT, 'scripts/gantry-setup.ts');

// ── #249: build:binary script ────────────────────────────────────────────────

describe('#249 binary build', () => {
  it('build.ts exists and exports a --binary flag code path', async () => {
    const buildTs = resolve(SERVER_ROOT, 'build.ts');
    expect(existsSync(buildTs)).toBe(true);
    const content = readFileSync(buildTs, 'utf-8');
    expect(content).toContain('--binary');
    expect(content).toContain('--compile');
  });

  it('package.json includes build:binary script', () => {
    const pkg = JSON.parse(readFileSync(resolve(SERVER_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['build:binary']).toBeDefined();
    expect(pkg.scripts['build:binary']).toContain('--binary');
  });

  it('gantry-setup.ts exists', () => {
    expect(existsSync(SETUP_SCRIPT)).toBe(true);
    const content = readFileSync(SETUP_SCRIPT, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain('gantry-setup');
  });
});

// ── #249: setup script behavior ──────────────────────────────────────────────

describe('gantry-setup.ts', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gantry-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates data/pids and logs directories', () => {
    const result = spawnSync('bun', [SETUP_SCRIPT, tmpDir], { encoding: 'utf-8' });
    expect(result.status).toBe(0);
    expect(existsSync(join(tmpDir, 'data', 'pids'))).toBe(true);
    expect(existsSync(join(tmpDir, 'logs'))).toBe(true);
  });

  it('creates a valid gantry.json with required fields', () => {
    spawnSync('bun', [SETUP_SCRIPT, tmpDir], { encoding: 'utf-8' });
    const configPath = join(tmpDir, 'gantry.json');
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config).toHaveProperty('mcpGameUrl');
    expect(config.mcpGameUrl).toContain('spacemolt.com');
    expect(config).toHaveProperty('agents');
    expect(Array.isArray(config.agents)).toBe(true);
    expect(config.agents.length).toBeGreaterThan(0);
  });

  it('does not overwrite existing gantry.json', () => {
    const configPath = join(tmpDir, 'gantry.json');
    const existing = JSON.stringify({ custom: true });
    writeFileSync(configPath, existing);

    spawnSync('bun', [SETUP_SCRIPT, tmpDir], { encoding: 'utf-8' });

    const after = readFileSync(configPath, 'utf-8');
    expect(JSON.parse(after)).toEqual({ custom: true });
  });
});
