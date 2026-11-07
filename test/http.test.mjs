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

function makeCtx(home, activity, options = {}) {
  const routes = new Map();
  const detached = [];
  const unarchived = [];
  // Serialize + write atomically, like the real registry's operation queue: the
  // plugin's startup finalize and a route can both rewrite this file.
  let chain = Promise.resolve();
  function rewrite(change) {
    chain = chain.then(async () => {
      const file = path.join(home, 'storages', 'workspace.json');
      const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
      change(doc);
      const temporary = `${file}.${Math.random().toString(16).slice(2)}.tmp`;
      await fsp.writeFile(temporary, JSON.stringify(doc, null, 2));
      await fsp.rename(temporary, file);
    });
    return chain;
  }
  const ctx = {
    sessions: { get: (id) => (id === 'session-alpha' ? { id } : undefined) },
    workspaceRegistry: {
      list: () => [{
        id: 'w1',
        sessionIds: ['session-alpha'],
        detachSession: async (id) => {
          detached.push(id);
          await rewrite((doc) => {
            const record = doc.tables.workspaces.w1;
            if (record) record.sessionIds = record.sessionIds.filter((value) => value !== id);
          });
        },
      }],
      unarchiveSession: async (id) => {
        unarchived.push(id);
        await rewrite((doc) => {
          doc.global.archivedSessionIds = doc.global.archivedSessionIds.filter((value) => value !== id);
        });
      },
    },
    sessionPersistence: options.persistence,
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

async function post(routes, routePath, body) {
  const res = makeRes();
  await routes.get(routePath).handler(makeReq(body), res);
  return { status: res.status, payload: res.body ? JSON.parse(res.body) : undefined };
}

async function callDelete(routes, sessionIds, extra = {}) {
  return post(routes, '/plugins/archived-purge/delete', { sessionIds, ...extra });
}

const digest = (fill) => fill.repeat(64).slice(0, 64).toLowerCase();

function fakePersistence(sessions, home) {
  // A real backend lists only what is still stored, so a deleted log drops out
  // of the listing (and therefore out of the reference scan).
  const stored = async (id) => {
    if (home === undefined) return true;
    try {
      await fsp.access(path.join(home, 'sessions', '--C-tmp-proj--', id));
      return true;
    } catch {
      return false;
    }
  };
  return {
    list: async () => {
      const out = [];
      for (const [id, spec] of Object.entries(sessions)) {
        if (!(await stored(id))) continue;
        out.push({ header: { id, cwd: spec.cwd, createdAt: 1 } });
      }
      return out;
    },
    open: async (id) => {
      const spec = sessions[id];
      if (!spec || !(await stored(id))) throw new Error(`missing ${id}`);
      if (spec.unreadable) throw new Error('corrupt log');
      return { read: async () => ({ eventState: 'detached', events: spec.events }), close: async () => {} };
    },
  };
}

async function writeObject(root, name, bytes) {
  const shard = path.join(root, name.slice(0, 2));
  await fsp.mkdir(shard, { recursive: true });
  const file = path.join(shard, name);
  await fsp.writeFile(file, Buffer.alloc(bytes, 5));
  const past = new Date(Date.now() - 3_600_000);
  await fsp.utimes(file, past, past);
  return file;
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
  assert.deepEqual(payload.deferred, ['session-alpha'], 'the store still holds it, so bookkeeping waits');
  await assert.rejects(fsp.stat(dir));
  await assert.rejects(fsp.stat(path.join(cache, 'session-alpha.json')));
  assert.deepEqual(detached, [], 'the slot stays while the Session is still listed');
  assert.deepEqual(unarchived, []);

  // The page must not offer the finished row again, only say it is pending.
  const stateRes = makeRes();
  const stateReq = new EventEmitter();
  stateReq.method = 'GET';
  stateReq.headers = { host: '127.0.0.1:10094' };
  await routes.get('/plugins/archived-purge/state').handler(stateReq, stateRes);
  const state = JSON.parse(stateRes.body);
  assert.equal(state.items.length, 0);
  assert.equal(state.pendingFinalize, 1);

  // Next start: the Session is out of the store, so the next request heals it.
  ctx.sessions.get = () => undefined;
  const again = await callDelete(routes, ['session-alpha']);
  assert.equal(again.status, 200);
  assert.equal(again.payload.code, 'not-archived');
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

test('leftover scan reports stale index entries and purges them', async () => {
  const { home } = await makeHome();
  process.env.DSH_HOME = home;
  const { ctx, routes } = makeCtx(home, () => []);
  apply(ctx);
  // Let the plugin's own start-up finalize settle before planting the ghosts,
  // otherwise it would clean them up before the test looks at them.
  await new Promise((resolve) => setImmediate(resolve));

  const registryFile = path.join(home, 'storages', 'workspace.json');
  const doc = JSON.parse(await fsp.readFile(registryFile, 'utf8'));
  doc.tables.workspaces.w1.sessionIds.push('session-ghost');
  doc.global.archivedSessionIds.push('session-ghost');
  await fsp.writeFile(registryFile, JSON.stringify(doc, null, 2));
  const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', 'session-ghost.json');
  await fsp.writeFile(cacheFile, JSON.stringify({ record: { rows: {} } }));

  const scan = await post(routes, '/plugins/archived-purge/leftovers', {});
  assert.equal(scan.status, 200);
  assert.equal(scan.payload.caches.length, 1);
  assert.equal(scan.payload.accounting.length, 1);
  assert.equal(scan.payload.archived.length, 1);

  const purged = await post(routes, '/plugins/archived-purge/purge-leftovers', {
    caches: true,
    accounting: true,
    archived: true,
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.payload));
  assert.equal(purged.payload.ok, true);
  await assert.rejects(fsp.stat(cacheFile));
  const after = JSON.parse(await fsp.readFile(registryFile, 'utf8'));
  assert.ok(!after.tables.workspaces.w1.sessionIds.includes('session-ghost'));
  assert.ok(!after.global.archivedSessionIds.includes('session-ghost'));
});

test('scan reports what a delete would free, gc removes only unreferenced objects', async () => {
  const { home } = await makeHome();
  process.env.DSH_HOME = home;
  const objectsRoot = path.join(home, 'attachments', 'v1', 'objects');
  const referenced = digest('a');
  const orphan = digest('b');
  await writeObject(objectsRoot, referenced, 128);
  await writeObject(objectsRoot, orphan, 64);

  const persistence = fakePersistence({
    'session-alpha': {
      cwd: 'C:\\tmp\\proj',
      events: [{ type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${referenced}` } }] } }],
    },
  }, home);
  const { ctx, routes } = makeCtx(home, () => [], { persistence });
  apply(ctx);

  // Deleting alpha leaves both objects unreferenced: the scan says so up front.
  const scan = await post(routes, '/plugins/archived-purge/scan', { sessionIds: ['session-alpha'] });
  assert.equal(scan.status, 200);
  assert.equal(scan.payload.attachments.orphanObjects, 2);
  assert.equal(scan.payload.attachments.orphanBytes, 192);
  assert.equal(scan.payload.attachments.keptObjects, 0);

  // A plain sweep keeps `referenced`, because alpha's log still references it,
  // and drops the already-orphaned object.
  const idle = await post(routes, '/plugins/archived-purge/gc', {});
  assert.equal(idle.payload.dryRun, true);
  assert.equal(idle.payload.orphanObjects, 1, 'only the unreferenced object is collectable');

  const removed = await post(routes, '/plugins/archived-purge/gc', { dryRun: false });
  assert.equal(removed.payload.ok, true);
  assert.equal(removed.payload.removedObjects, 1);
  await fsp.stat(path.join(objectsRoot, referenced.slice(0, 2), referenced));

  // Deleting alpha with the deep clean on removes its now-unreferenced object.
  const del = await callDelete(routes, ['session-alpha'], { attachments: true });
  assert.equal(del.payload.ok, true);
  assert.equal(del.payload.gc.removedObjects, 1);
  assert.equal(del.payload.gc.removedBytes, 128);
  await assert.rejects(fsp.stat(path.join(objectsRoot, referenced.slice(0, 2), referenced)));
});

test('gc fails closed when a Session log cannot be read', async () => {
  const { home } = await makeHome();
  process.env.DSH_HOME = home;
  const objectsRoot = path.join(home, 'attachments', 'v1', 'objects');
  await writeObject(objectsRoot, digest('c'), 32);
  const persistence = fakePersistence({
    'session-alpha': { cwd: 'C:\\tmp\\proj', unreadable: true, events: [] },
  }, home);
  const { ctx, routes } = makeCtx(home, () => [], { persistence });
  apply(ctx);

  const result = await post(routes, '/plugins/archived-purge/gc', { dryRun: false });
  assert.equal(result.payload.ok, false);
  assert.equal(result.payload.code, 'unreadable-session');
  await fsp.stat(path.join(objectsRoot, 'cc', digest('c')));
});

test('deep clean deletes only artifacts the scan offered and clears the image cache', async () => {
  const { home } = await makeHome();
  process.env.DSH_HOME = home;
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'purge-workspace-'));
  await fsp.mkdir(cwd, { recursive: true });
  const produced = path.join(cwd, 'report.md');
  const untouched = path.join(cwd, 'keep.md');
  await fsp.writeFile(produced, 'hello');
  await fsp.writeFile(untouched, 'keep');
  const cacheDir = path.join(home, 'cache', 'attachments', 'request-images', 'ab');
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.writeFile(path.join(cacheDir, digest('d')), Buffer.alloc(40, 1));

  const persistence = fakePersistence({
    'session-alpha': {
      cwd,
      events: [{ type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: produced }) } }],
    },
  }, home);
  const { ctx, routes } = makeCtx(home, () => [], { persistence });
  apply(ctx);

  const scan = await post(routes, '/plugins/archived-purge/scan', { sessionIds: ['session-alpha'] });
  assert.deepEqual(scan.payload.artifacts.map((file) => file.path), [produced]);
  assert.equal(scan.payload.requestImages.files, 1);

  const del = await callDelete(routes, ['session-alpha'], {
    files: [produced, untouched],
    requestImages: true,
  });
  assert.equal(del.payload.ok, true);
  assert.equal(del.payload.artifacts.deleted, 1);
  assert.equal(del.payload.artifacts.results[1].ok, false);
  assert.equal(del.payload.artifacts.results[1].code, 'not-offered');
  assert.equal(del.payload.gc.requestImages.removedFiles, 1);
  await assert.rejects(fsp.stat(produced));
  assert.ok((await fsp.stat(untouched)).isFile(), 'an unticked sibling survives');
});
