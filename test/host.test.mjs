import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandlers, readArchivedState, scanSessionDirs } from '../index.js';

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'archived-purge-test-'));
  const project = path.join(home, 'sessions', '--C-tmp-proj--');
  const cache = path.join(home, 'storages', 'session_projcache', 'sessions');
  await fsp.mkdir(project, { recursive: true });
  await fsp.mkdir(cache, { recursive: true });
  return { home, project, cache };
}

async function makeSession(project, id, bytes = 512) {
  const dir = path.join(project, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(bytes, 7));
  return dir;
}

async function makeCache(cache, id, title) {
  await fsp.writeFile(path.join(cache, `${id}.json`), JSON.stringify({
    version: 7,
    record: { identity: { formatVersion: 4 }, rows: { title: { ver: 1, seq: 3, val: title } } },
  }));
}

async function writeRegistry(home, archived, sessionIds) {
  await fsp.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: archived, pinnedSessionIds: [] },
    tables: {
      workspaces: {
        w1: {
          path: 'C:\\tmp\\proj',
          title: 'demo-workspace',
          sessionIds,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      },
    },
  }, null, 2));
}

/**
 * A registry stub that persists like the real one: `detachSession` drops the
 * slot from `tables.workspaces.w1.sessionIds`, `unarchiveSession` drops the id
 * from `global.archivedSessionIds`, both written back to workspace.json. Tests
 * can therefore assert the durable end state rather than only the calls.
 */
function makeRegistry(home, sessionIds) {
  const detached = [];
  const unarchived = [];
  async function rewrite(change) {
    const file = path.join(home, 'storages', 'workspace.json');
    const doc = JSON.parse(await fsp.readFile(file, 'utf8'));
    change(doc);
    await fsp.writeFile(file, JSON.stringify(doc, null, 2));
  }
  return {
    detached,
    unarchived,
    registry: {
      list: () => [{
        id: 'w1',
        title: 'demo-workspace',
        sessionIds: [...sessionIds],
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
  };
}

test('reads archived ids and groups sessions by workspace', async () => {
  const { home, project, cache } = await makeHome();
  await makeSession(project, 'session-alpha', 2048);
  await makeSession(project, 'session-beta', 1024);
  await makeCache(cache, 'session-alpha', 'Alpha title');
  await makeCache(cache, 'session-beta', 'Beta title');
  await writeRegistry(home, ['session-alpha', 'session-beta'], ['session-alpha', 'session-beta']);

  const state = await readArchivedState(home);
  assert.deepEqual(state.archived, ['session-alpha', 'session-beta']);

  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    agents: undefined,
    workspaceRegistry: makeRegistry(home, ['session-alpha', 'session-beta']).registry,
    sessionPersistence: undefined,
  });
  const data = await handlers.state();
  assert.equal(data.archivedCount, 2);
  assert.equal(data.items.length, 2);
  const alpha = data.items.find((item) => item.id === 'session-alpha');
  assert.equal(alpha.title, 'Alpha title');
  assert.equal(alpha.workspaceTitle, 'demo-workspace');
  assert.equal(alpha.exists, true);
  assert.ok(alpha.sizeBytes >= 2048);
  assert.ok(data.totalBytes >= 3072);
});

test('delete removes log, cache, accounting and archive marker', async () => {
  const { home, project, cache } = await makeHome();
  const alphaDir = await makeSession(project, 'session-alpha', 4096);
  const betaDir = await makeSession(project, 'session-beta', 512);
  await makeCache(cache, 'session-alpha', 'Alpha');
  await makeCache(cache, 'session-beta', 'Beta');
  await writeRegistry(home, ['session-alpha', 'session-beta'], ['session-alpha', 'session-beta']);

  const { registry, detached, unarchived } = makeRegistry(home, ['session-alpha', 'session-beta']);
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    workspaceRegistry: registry,
    sessionPersistence: undefined,
  });
  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.ok(result.removedBytes >= 4096);

  await assert.rejects(fsp.stat(alphaDir));
  await assert.rejects(fsp.stat(path.join(cache, 'session-alpha.json')));
  assert.ok((await fsp.stat(betaDir)).isDirectory());
  assert.ok((await fsp.stat(path.join(cache, 'session-beta.json'))).isFile());
  assert.deepEqual(detached, ['session-alpha']);
  assert.deepEqual(unarchived, ['session-alpha']);

  const after = await readArchivedState(home);
  assert.deepEqual(after.archived, ['session-beta'], 'the archive marker moves only through the registry API');
  assert.deepEqual(after.workspaces.w1.sessionIds, ['session-beta'], 'the accounting slot moves only through the entity API');
});

test('refuses a Session that still reports work and leaves its files alone', async () => {
  const { home, project, cache } = await makeHome();
  const alphaDir = await makeSession(project, 'session-alpha', 256);
  await makeCache(cache, 'session-alpha', 'Alpha');
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);

  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async (id) => (id === 'session-alpha' ? [{ kind: 'turn' }] : []),
    workspaceRegistry: makeRegistry(home, ['session-alpha']).registry,
    sessionPersistence: undefined,
  });
  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-active');
  assert.equal(result.deleted, 0, 'nothing is attempted when the batch is refused');
  assert.deepEqual(result.active, [{ id: 'session-alpha', kinds: ['turn'] }]);
  assert.ok((await fsp.stat(alphaDir)).isDirectory());
  assert.ok((await fsp.stat(path.join(cache, 'session-alpha.json'))).isFile());
});

test('deletes an archived Session that is resident but idle (regression)', async () => {
  // Archiving hides a Session without disposing it, so every recently used
  // archived Session is still in the store. Presence used to be read as
  // liveness, which refused every delete with HTTP 400.
  const { home, project, cache } = await makeHome();
  const alphaDir = await makeSession(project, 'session-alpha', 2048);
  await makeCache(cache, 'session-alpha', 'Alpha');
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);

  const { registry, detached, unarchived } = makeRegistry(home, ['session-alpha']);
  const sessions = { get: (id) => (id === 'session-alpha' ? { id } : undefined) };
  const handlers = createHandlers({
    home,
    sessions,
    activity: async () => [],
    workspaceRegistry: registry,
    sessionPersistence: undefined,
  });

  const state = await handlers.state();
  assert.equal(state.items[0].resident, true);
  assert.equal(state.items[0].active, false);

  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.deferred, ['session-alpha'], 'bookkeeping waits for the Session to leave the store');
  await assert.rejects(fsp.stat(alphaDir));
  await assert.rejects(fsp.stat(path.join(cache, 'session-alpha.json')));
  // The slot and the archive marker stay: dropping them here would list the
  // still-listed Session under the sidebar's ungrouped bucket.
  assert.deepEqual(detached, []);
  assert.deepEqual(unarchived, []);
  assert.deepEqual((await readArchivedState(home)).archived, ['session-alpha']);
  const after = await handlers.state();
  assert.equal(after.items.length, 0, 'a finished row is not listed again');
  assert.equal(after.pendingFinalize, 1);

  // Restart: nothing holds the Session any more, so loading finishes the job.
  sessions.get = () => undefined;
  const finalized = await handlers.finalizePending();
  assert.deepEqual(finalized, ['session-alpha']);
  assert.deepEqual(detached, ['session-alpha']);
  assert.deepEqual(unarchived, ['session-alpha']);
  assert.deepEqual((await readArchivedState(home)).archived, []);
});

test('refuses the whole batch when one Session still reports work', async () => {
  const { home, project, cache } = await makeHome();
  const alphaDir = await makeSession(project, 'session-alpha', 128);
  const betaDir = await makeSession(project, 'session-beta', 128);
  await makeCache(cache, 'session-alpha', 'Alpha');
  await makeCache(cache, 'session-beta', 'Beta');
  await writeRegistry(home, ['session-alpha', 'session-beta'], ['session-alpha', 'session-beta']);

  const { registry, detached, unarchived } = makeRegistry(home, ['session-alpha', 'session-beta']);
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async (id) => (id === 'session-beta' ? ['job', 'schedule'] : []),
    workspaceRegistry: registry,
    sessionPersistence: undefined,
  });

  const result = await handlers.remove(['session-alpha', 'session-beta']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'session-active');
  assert.deepEqual(result.active, [{ id: 'session-beta', kinds: ['job', 'schedule'] }]);
  assert.ok((await fsp.stat(alphaDir)).isDirectory(), 'an idle sibling must not be deleted either');
  assert.ok((await fsp.stat(betaDir)).isDirectory());
  assert.ok((await fsp.stat(path.join(cache, 'session-alpha.json'))).isFile());
  assert.deepEqual(detached, []);
  assert.deepEqual(unarchived, []);
});

test('refuses the batch when the activity probe itself fails', async () => {
  const { home, project } = await makeHome();
  await makeSession(project, 'session-alpha', 64);
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => { throw new Error('waterfall exploded'); },
    workspaceRegistry: makeRegistry(home, ['session-alpha']).registry,
    sessionPersistence: undefined,
  });
  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'activity-unknown');
  assert.match(result.message, /waterfall exploded/);
});

test('marks an unknown activity state in the listing instead of calling it running', async () => {
  const { home, project } = await makeHome();
  await makeSession(project, 'session-alpha', 64);
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);
  const handlers = createHandlers({
    home,
    sessions: { get: () => ({ id: 'session-alpha' }) },
    activity: async () => { throw new Error('no probe'); },
    workspaceRegistry: makeRegistry(home, ['session-alpha']).registry,
    sessionPersistence: undefined,
  });
  const state = await handlers.state();
  assert.equal(state.items[0].active, false);
  assert.equal(state.items[0].activityUnknown, true);
  assert.equal(state.items[0].resident, true);
});

test('rejects malformed ids and non-archived ids', async () => {
  const { home, project } = await makeHome();
  await makeSession(project, 'session-alpha', 32);
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    workspaceRegistry: makeRegistry(home, ['session-alpha']).registry,
    sessionPersistence: undefined,
  });

  for (const bad of ['..', '../../etc', 'a/b', 'C:\\x', '', 'session.alpha']) {
    const result = await handlers.remove([bad]);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid-request', `id ${JSON.stringify(bad)} must be rejected`);
  }

  const notArchived = await handlers.remove(['session-missing']);
  assert.equal(notArchived.ok, false);
  assert.equal(notArchived.code, 'not-archived');
});

test('uses the durable accounting slot even when the projection dropped the id', async () => {
  const { home, project, cache } = await makeHome();
  await makeSession(project, 'session-alpha', 64);
  await makeCache(cache, 'session-alpha', 'Alpha');
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);

  const { registry, detached, unarchived } = makeRegistry(home, []);
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    workspaceRegistry: registry,
    sessionPersistence: undefined,
  });

  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, true);
  assert.deepEqual(detached, ['session-alpha']);
  assert.deepEqual(unarchived, ['session-alpha']);
});

test('cascades archived parents into subagent-origin descendants only', async () => {
  const { home, project, cache } = await makeHome();
  const parentDir = await makeSession(project, 'session-parent', 128);
  const childDir = await makeSession(project, 'session-child', 64);
  const forkDir = await makeSession(project, 'session-fork', 64);
  await makeCache(cache, 'session-parent', 'Parent');
  await writeRegistry(home, ['session-parent'], ['session-parent']);

  const snapshots = [
    { header: { id: 'session-parent', isSeeded: false } },
    { header: { id: 'session-child', isSeeded: false, origin: 'subagent', parentSession: 'session-parent' } },
    { header: { id: 'session-fork', isSeeded: false, parentSession: 'session-parent' } },
  ];
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    workspaceRegistry: makeRegistry(home, ['session-parent']).registry,
    sessionPersistence: { list: async () => snapshots },
  });

  const result = await handlers.remove(['session-parent']);
  assert.equal(result.ok, true);
  await assert.rejects(fsp.stat(parentDir));
  await assert.rejects(fsp.stat(childDir), 'subagent child must be removed with the parent');
  assert.ok((await fsp.stat(forkDir)).isDirectory(), 'ordinary fork must survive');
});

test('a deep clean removes produced files and the tasks aimed at the Sessions', async () => {
  const { home, project, cache } = await makeHome();
  await makeSession(project, 'session-alpha', 128);
  await makeCache(cache, 'session-alpha', 'Alpha');
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'purge-artifacts-'));
  const produced = path.join(cwd, 'report.md');
  await fsp.writeFile(produced, 'hello');

  const persistence = {
    list: async () => [{ header: { id: 'session-alpha', cwd } }],
    open: async () => ({
      read: async () => ({
        events: [{ type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: produced }) } }],
      }),
      close: async () => {},
    }),
  };
  const deletedTasks = [];
  const closedTasks = new Set();
  const schedule = {
    catalog: async () => [
      { id: 'schedule-alive', title: 'Aimed elsewhere', status: 'active', target: { kind: 'session', sessionId: 'session-other' } },
      { id: 'schedule-dead', title: 'Aimed here', status: 'active', target: { kind: 'session', sessionId: 'session-alpha' } },
      { id: 'schedule-fresh', title: 'New session', status: 'active', target: { kind: 'new' } },
    ],
    edit: async (request) => {
      if (closedTasks.has(request.id)) throw new Error('already gone');
      closedTasks.add(request.id);
      deletedTasks.push(request);
      return { id: request.id, deleted: true };
    },
  };

  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    workspaceRegistry: makeRegistry(home, ['session-alpha']).registry,
    sessionPersistence: persistence,
    getSchedule: () => schedule,
  });

  const listing = await handlers.state();
  assert.equal(listing.items[0].scheduleCount, 1, 'the row advertises the dead task');

  const scan = await handlers.scanAll(['session-alpha']);
  assert.deepEqual(scan.artifacts.map((file) => file.path), [produced]);
  assert.equal(scan.schedules.count, 1);

  const result = await handlers.remove(['session-alpha'], { everything: true });
  assert.equal(result.ok, true);
  assert.equal(result.artifacts.deleted, 1);
  await assert.rejects(fsp.stat(produced), 'the produced file is gone');
  assert.deepEqual(deletedTasks.map((task) => task.id), ['schedule-dead']);
  assert.equal(result.schedules.deleted, 1);
  assert.equal(result.schedules.failed, 0);

  // A Host without the Schedule service must still purge Sessions.
  const bare = createHandlers({
    home,
    sessions: { get: () => undefined },
    workspaceRegistry: makeRegistry(home, []).registry,
    sessionPersistence: undefined,
  });
  assert.equal((await bare.state()).items.length, 0);
});

test('scanSessionDirs indexes every project directory', async () => {
  const { home } = await makeHome();
  const second = path.join(home, 'sessions', '--C-other--');
  await fsp.mkdir(second, { recursive: true });
  await makeSession(path.join(home, 'sessions', '--C-tmp-proj--'), 'session-a');
  await makeSession(second, 'session-a');
  const map = await scanSessionDirs(path.join(home, 'sessions'));
  assert.equal(map.get('session-a').length, 2);
});
