import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';

/**
 * These tests drive the real route handlers through `apply()`, so they pin the
 * wire contract the Settings page consumes — notably that a refused delete is
 * a readable 200 payload instead of a bare `HTTP 400`.
 */

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'archived-purge-http-'));
  const project = path.join(home, 'sessions', '--C-tmp-proj--');
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions');
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(cache, { recursive: true });
  const dir = path.join(project, 'session-alpha');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(1024, 3));
  await fsp.writeFile(path.join(cache, 'session-alpha.json'), JSON.stringify({
    record: { rows: { title: { val: 'Alpha' } } },
  }));
  await fsp.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: ['session-alpha'], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        w1: { path: 'C:\\tmp\\proj', title: 'demo', sessionIds: ['session-alpha'] },
      },
    },
  }));
  return { home, dir, cache };
}

function makeCtx(home, activity) {
  const routes = new Map();
  const detached = [];
  const unarchived = [];
  const ctx = {
    sessions: { get: (id) => (id === 'session-alpha' ? { id } : undefined) },
    workspaceRegistry: {
      list: () => [{ id: 'w1', sessionIds: ['session-alpha'], detachSession: async (id) => { detached.push(id); } }],
      unarchiveSession: async (id) => { unarchived.push(id); },
    },
    sessionPersistence: undefined,
    waterfall: async (name, payload, next) => {
      assert.equal(name, 'workspace/session-activity');
      return activity(payload.sessionId);
    },
    effect(fn) {
      fn();
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
  return { ctx, routes, detached, unarchived };
}

function makeReq(body, extra = {}) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.headers = {
    'content-type': 'application/json',
    host: '127.0.0.1:10094',
    ...extra,
  };
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}

async function callDelete(routes, sessionIds) {
  const res = makeRes();
  await routes.get('/plugins/archived-purge/delete').handler(makeReq({ sessionIds }), res);
  return { status: res.status, payload: res.body ? JSON.parse(res.body) : undefined };
}

test('idle archived Session deletes with HTTP 200 even while still resident', async () => {
  const { home, dir, cache } = await makeHome();
  process.env.DSH_HOME = home;
  const { ctx, routes, detached, unarchived } = makeCtx(home, () => []);
  apply(ctx);

  const { status, payload } = await callDelete(routes, ['session-alpha']);
  assert.equal(status, 200, 'a successful delete is 200');
  assert.equal(payload.ok, true);
  assert.equal(payload.deleted, 1);
  assert.equal(payload.failed, 0);
  await assert.rejects(fsp.stat(dir));
  await assert.rejects(fsp.stat(path.join(cache, 'session-alpha.json')));
  assert.deepEqual(detached, ['session-alpha']);
  assert.deepEqual(unarchived, ['session-alpha']);
});

test('a running Session is refused with a readable 200 payload, never a bare HTTP 400', async () => {
  const { home, dir } = await makeHome();
  process.env.DSH_HOME = home;
  const { ctx, routes } = makeCtx(home, () => [{ kind: 'turn' }]);
  apply(ctx);

  const { status, payload } = await callDelete(routes, ['session-alpha']);
  assert.equal(status, 200, 'the request was well formed; the refusal is business data');
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'session-active');
  assert.match(payload.message, /仍在运行/);
  assert.deepEqual(payload.active, [{ id: 'session-alpha', kinds: ['turn'] }]);
  assert.ok((await fsp.stat(dir)).isDirectory(), 'nothing is deleted');
});

test('state reports activity instead of store residency', async () => {
  const { home } = await makeHome();
  process.env.DSH_HOME = home;
  const { ctx, routes } = makeCtx(home, () => []);
  apply(ctx);

  const res = makeRes();
  const req = new EventEmitter();
  req.method = 'GET';
  req.headers = { host: '127.0.0.1:10094' };
  await routes.get('/plugins/archived-purge/state').handler(req, res);
  const payload = JSON.parse(res.body);
  const item = payload.items[0];
  assert.equal(item.resident, true);
  assert.equal(item.active, false);
  assert.deepEqual(item.activity, []);
  assert.equal(item.live, undefined, 'the misleading presence-based flag is gone');
});

test('a foreign origin is still rejected before any work happens', async () => {
  const { home } = await makeHome();
  process.env.DSH_HOME = home;
  const { ctx, routes } = makeCtx(home, () => []);
  apply(ctx);
  const res = makeRes();
  await routes.get('/plugins/archived-purge/delete').handler(
    makeReq({ sessionIds: ['session-alpha'] }, { origin: 'https://evil.example' }),
    res,
  );
  assert.equal(res.status, 403);
});

test('malformed JSON stays a 400 while a rejected id travels as data', async () => {
  const { home } = await makeHome();
  process.env.DSH_HOME = home;
  const { ctx, routes } = makeCtx(home, () => []);
  apply(ctx);

  const broken = new EventEmitter();
  broken.method = 'POST';
  broken.headers = { 'content-type': 'application/json', host: '127.0.0.1:10094' };
  process.nextTick(() => {
    broken.emit('data', Buffer.from('{not json'));
    broken.emit('end');
  });
  const brokenRes = makeRes();
  await routes.get('/plugins/archived-purge/delete').handler(broken, brokenRes);
  assert.equal(brokenRes.status, 400);
  assert.equal(JSON.parse(brokenRes.body).code, 'invalid-json');

  const bad = await callDelete(routes, ['../../etc']);
  assert.equal(bad.status, 200);
  assert.equal(bad.payload.ok, false);
  assert.equal(bad.payload.code, 'invalid-request');
});
