/**
 * Tests for the logs route: SSE stream, history, and search endpoints.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import express from 'express';
import supertest from 'supertest';
import { createLogsRouter } from './logs.js';
import { canBindLocalhost, startTestServer, type StartedTestServer } from '../../test/http-test-server.js';

// ---------------------------------------------------------------------------
// Test fleet directory setup
// ---------------------------------------------------------------------------

const TEST_FLEET_DIR = join(tmpdir(), `logs-route-test-${Date.now()}`);
const LOGS_DIR = join(TEST_FLEET_DIR, 'logs');

const TEST_CONFIG = {
  agents: [
    { name: 'test-alpha', model: 'haiku', role: 'Trader' },
    { name: 'test-bravo', model: 'haiku', role: 'Miner' },
  ],
  gameUrl: 'http://localhost/mcp',
  gameApiUrl: 'http://localhost/api/v1',
  agentDeniedTools: {},
  callLimits: {},
  turnSleepMs: 90000,
  staggerDelay: 5000,
  maxIterationsPerSession: 200,
  maxTurnDurationMs: 300000,
  idleTimeoutMs: 120000,
} as any;

function makeApp() {
  const app = express();
  app.use(express.json());
  // Inject minimal auth so middleware doesn't block
  app.use((req: any, _res: any, next: any) => {
    req.auth = { role: 'admin', identity: 'test' };
    next();
  });
  app.use('/', createLogsRouter(TEST_FLEET_DIR, TEST_CONFIG));
  return app;
}

beforeAll(() => {
  mkdirSync(LOGS_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_FLEET_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Supertest — non-streaming endpoints
// ---------------------------------------------------------------------------

describe('GET /:name/logs/history', () => {
  let logFile: string;

  beforeEach(() => {
    logFile = join(LOGS_DIR, 'test-alpha.log');
    writeFileSync(logFile, Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n');
  });

  afterEach(() => {
    rmSync(logFile, { force: true });
  });

  it('returns 404 for unknown agent', async () => {
    const res = await supertest(makeApp()).get('/unknown-agent/logs/history');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/unknown agent/i);
  });

  it('returns first 10 lines with offset=0 and limit=10', async () => {
    const res = await supertest(makeApp()).get('/test-alpha/logs/history?offset=0&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(10);
    expect(res.body.lines[0]).toBe('line0');
  });

  it('returns empty lines when offset is beyond file end', async () => {
    const res = await supertest(makeApp()).get('/test-alpha/logs/history?offset=999999&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(0);
  });
});

describe('GET /:name/logs/search', () => {
  let logFile: string;

  beforeEach(() => {
    logFile = join(LOGS_DIR, 'test-alpha.log');
    writeFileSync(logFile, 'line with foo\nnormal line\nanother foo line\n');
  });

  afterEach(() => {
    rmSync(logFile, { force: true });
  });

  it('returns 404 for unknown agent', async () => {
    const res = await supertest(makeApp()).get('/unknown-agent/logs/search?q=foo');
    expect(res.status).toBe(404);
  });

  it('returns empty results for missing query', async () => {
    const res = await supertest(makeApp()).get('/test-alpha/logs/search');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });

  it('returns matching lines', async () => {
    const res = await supertest(makeApp()).get('/test-alpha/logs/search?q=foo');
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].line).toBe('line with foo');
    expect(res.body.results[1].line).toBe('another foo line');
  });
});

describe('GET /:name/logfile', () => {
  let logFile: string;

  beforeEach(() => {
    logFile = join(LOGS_DIR, 'test-alpha.log');
    writeFileSync(logFile, 'line1\nline2\nline3\n');
  });

  afterEach(() => {
    rmSync(logFile, { force: true });
  });

  it('returns 404 for unknown agent', async () => {
    const res = await supertest(makeApp()).get('/unknown-agent/logfile');
    expect(res.status).toBe(404);
  });

  it('returns the tail of the log file', async () => {
    const res = await supertest(makeApp()).get('/test-alpha/logfile');
    expect(res.status).toBe(200);
    expect(res.body.lines).toContain('line1');
    expect(res.body.lines).toContain('line3');
  });
});

// ---------------------------------------------------------------------------
// Integration — SSE stream (requires real HTTP server)
// ---------------------------------------------------------------------------

describe('GET /:name/logs/stream (SSE)', () => {
  let server: StartedTestServer;
  let canBind: boolean;

  beforeAll(async () => {
    canBind = await canBindLocalhost();
    if (!canBind) return;
    server = await startTestServer(makeApp(), { host: '127.0.0.1' });
  });

  afterAll(() => {
    server?.server.closeAllConnections();
  });

  /**
   * Opens an SSE connection, collects data for `collectMs`, then closes.
   * Returns the concatenated response body.
   */
  function collectSSE(path: string, collectMs = 300): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!server?.baseUrl) return reject(new Error('server not started'));
      const parsed = new URL(`${server.baseUrl}${path}`);
      const chunks: string[] = [];
      let settled = false;

      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + parsed.search,
          method: 'GET',
        },
        (res) => {
          res.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf-8')));
          res.on('error', () => {});
        },
      );

      req.on('error', (err) => {
        if (!settled) { settled = true; reject(err); }
      });

      req.end();

      setTimeout(() => {
        if (!settled) {
          settled = true;
          req.destroy();
          resolve(chunks.join(''));
        }
      }, collectMs);
    });
  }

  it('returns 404 for unknown agent', async () => {
    if (!canBind) return;

    const body = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const parsed = new URL(`${server.baseUrl}/unknown-agent/logs/stream`);
      const chunks: string[] = [];
      const req = httpRequest(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'GET' },
        (res) => {
          res.on('data', (c: Buffer) => chunks.push(c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: chunks.join('') }));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(body.status).toBe(404);
  });

  it('sends SSE headers for a valid agent (no log file)', async () => {
    if (!canBind) return;

    await new Promise<void>((resolve, reject) => {
      const parsed = new URL(`${server.baseUrl}/test-alpha/logs/stream`);
      const req = httpRequest(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'GET' },
        (res) => {
          expect(res.headers['content-type']).toContain('text/event-stream');
          expect(res.statusCode).toBe(200);
          req.destroy();
          resolve();
        },
      );
      req.on('error', reject);
      req.end();
    });
  });

  it('sends status event when log file is missing', async () => {
    if (!canBind) return;

    // Ensure no log file exists
    rmSync(join(LOGS_DIR, 'test-alpha.log'), { force: true });

    const body = await collectSSE('/test-alpha/logs/stream', 300);

    expect(body).toContain('event: status');
    expect(body).toContain('No log file found');
  });

  it('sends log event with file content on connect', async () => {
    if (!canBind) return;

    const logFile = join(LOGS_DIR, 'test-bravo.log');
    writeFileSync(logFile, '[2026-03-21 10:00:00] Starting turn 1\ngame output here\n');

    try {
      const body = await collectSSE('/test-bravo/logs/stream', 300);

      expect(body).toContain('event: log');
      expect(body).toContain('Starting turn 1');
      expect(body).toContain('game output here');
    } finally {
      rmSync(logFile, { force: true });
    }
  });

  it('sends meta event after initial log delivery', async () => {
    if (!canBind) return;

    const logFile = join(LOGS_DIR, 'test-alpha.log');
    writeFileSync(logFile, 'line1\nline2\n');

    try {
      const body = await collectSSE('/test-alpha/logs/stream', 300);
      expect(body).toContain('event: meta');
    } finally {
      rmSync(logFile, { force: true });
    }
  });
});
