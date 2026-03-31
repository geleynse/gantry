import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import request from 'supertest';
import { createDatabase, closeDb } from '../../services/database.js';
import { createActionProxyRouter, type KickableSessionHandle } from './action-proxy.js';

// Mock session handle — cache persistence routes don't need real sessions
const mockSessions: KickableSessionHandle = {
  listActive: () => [],
  resolveAgentName: (u: string) => u,
  getClient: () => undefined,
  removeClient: () => {},
};

// Minimal app with just action-proxy routes.
// strict: false is needed so Express accepts bare JSON null (used for clearing battle state).
const app = express();
app.use(express.json({ strict: false }));
app.use('/api/action-proxy', createActionProxyRouter(mockSessions, 0));

describe('proxy cache persistence', () => {
  beforeEach(() => {
    createDatabase(':memory:');
  });

  afterEach(() => {
    closeDb();
  });

  it('PUT + GET /game-state round-trips', async () => {
    const state = { data: { player: { credits: 500 }, ship: { fuel: 80 } }, fetchedAt: 1000 };
    const put = await request(app)
      .put('/api/action-proxy/game-state/drifter-gale')
      .send(state);
    expect(put.status).toBe(200);

    const get = await request(app).get('/api/action-proxy/game-state');
    expect(get.status).toBe(200);
    const body = get.body as Record<string, any>;
    expect(body['drifter-gale'].data.player.credits).toBe(500);
    expect(body['drifter-gale'].fetchedAt).toBe(1000);
  });

  it('game-state upserts on repeated PUT', async () => {
    await request(app)
      .put('/api/action-proxy/game-state/agent-a')
      .send({ data: { player: { credits: 100 } }, fetchedAt: 1 });
    await request(app)
      .put('/api/action-proxy/game-state/agent-a')
      .send({ data: { player: { credits: 999 } }, fetchedAt: 2 });
    const get = await request(app).get('/api/action-proxy/game-state');
    const body = get.body as Record<string, any>;
    expect(body['agent-a'].data.player.credits).toBe(999);
  });

  it('PUT + GET /battle-state round-trips', async () => {
    const battle = { battle_id: 'abc', zone: 'outer', stance: 'aggressive', hull: 80, shields: 50, target: {}, status: 'active', updatedAt: 1000 };
    await request(app)
      .put('/api/action-proxy/battle-state/sable-thorn')
      .send(battle);
    const get = await request(app).get('/api/action-proxy/battle-state');
    const body = get.body as Record<string, any>;
    expect(body['sable-thorn'].battle_id).toBe('abc');
    expect(body['sable-thorn'].hull).toBe(80);
  });

  it('PUT null stores null battle state', async () => {
    await request(app)
      .put('/api/action-proxy/battle-state/sable-thorn')
      .send({ battle_id: 'x', zone: 'mid', stance: 'flee', hull: 10, shields: 0, target: {}, status: 'active', updatedAt: 1 });
    await request(app)
      .put('/api/action-proxy/battle-state/sable-thorn')
      .set('Content-Type', 'application/json')
      .send('null');
    const get = await request(app).get('/api/action-proxy/battle-state');
    const body = get.body as Record<string, any>;
    expect(body['sable-thorn']).toBeNull();
  });

  it('PUT + GET /call-trackers round-trips with calledTools array', async () => {
    const tracker = { counts: { mine: 5, sell: 2 }, lastCallSig: 'mine:5', calledTools: ['scan', 'analyze_market'] };
    await request(app)
      .put('/api/action-proxy/call-trackers/rust-vane')
      .send(tracker);
    const get = await request(app).get('/api/action-proxy/call-trackers');
    const body = get.body as Record<string, any>;
    expect(body['rust-vane'].counts.mine).toBe(5);
    expect(body['rust-vane'].calledTools).toContain('analyze_market');
    expect(body['rust-vane'].lastCallSig).toBe('mine:5');
  });

  it('DELETE /caches/:agent clears all caches for agent', async () => {
    await request(app)
      .put('/api/action-proxy/game-state/test-agent')
      .send({ data: {}, fetchedAt: 0 });
    await request(app)
      .put('/api/action-proxy/battle-state/test-agent')
      .send({ battle_id: 'b', zone: 'outer', stance: 'aggressive', hull: 50, shields: 0, target: {}, status: 'active', updatedAt: 0 });
    await request(app)
      .put('/api/action-proxy/call-trackers/test-agent')
      .send({ counts: {}, lastCallSig: null, calledTools: [] });

    const del = await request(app).delete('/api/action-proxy/caches/test-agent');
    expect(del.status).toBe(200);

    const gs = await request(app).get('/api/action-proxy/game-state');
    expect((gs.body as Record<string, any>)['test-agent']).toBeUndefined();
    const bs = await request(app).get('/api/action-proxy/battle-state');
    expect((bs.body as Record<string, any>)['test-agent']).toBeUndefined();
    const ct = await request(app).get('/api/action-proxy/call-trackers');
    expect((ct.body as Record<string, any>)['test-agent']).toBeUndefined();
  });

  it('PUT null battle state as first insert (no prior row)', async () => {
    const put = await request(app)
      .put('/api/action-proxy/battle-state/new-agent')
      .set('Content-Type', 'application/json')
      .send('null');
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/action-proxy/battle-state');
    const body = get.body as Record<string, any>;
    expect(body['new-agent']).toBeNull();
  });

  it('rejects invalid agent name on PUT', async () => {
    const put = await request(app)
      .put('/api/action-proxy/game-state/bad%20agent!')
      .send({ data: {}, fetchedAt: 0 });
    expect(put.status).toBe(400);
  });

  it('DELETE uses transaction (all-or-nothing)', async () => {
    await request(app)
      .put('/api/action-proxy/game-state/tx-agent')
      .send({ data: {}, fetchedAt: 0 });
    await request(app)
      .put('/api/action-proxy/call-trackers/tx-agent')
      .send({ counts: {}, lastCallSig: null, calledTools: [] });
    const del = await request(app).delete('/api/action-proxy/caches/tx-agent');
    expect(del.status).toBe(200);
    const gs = await request(app).get('/api/action-proxy/game-state');
    expect((gs.body as Record<string, any>)['tx-agent']).toBeUndefined();
    const ct = await request(app).get('/api/action-proxy/call-trackers');
    expect((ct.body as Record<string, any>)['tx-agent']).toBeUndefined();
  });

  it('GET returns empty objects when no data', async () => {
    const gs = await request(app).get('/api/action-proxy/game-state');
    expect(gs.body).toEqual({});
    const bs = await request(app).get('/api/action-proxy/battle-state');
    expect(bs.body).toEqual({});
    const ct = await request(app).get('/api/action-proxy/call-trackers');
    expect(ct.body).toEqual({});
  });
});
