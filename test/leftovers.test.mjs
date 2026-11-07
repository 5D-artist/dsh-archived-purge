import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandlers } from '../index.js';
import { manifestPath, readManifest, recordDeletions } from '../lib/clean.js';

async function makeHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'purge-leftovers-'));
  await fsp.mkdir(path.join(home, 'sessions', '--C-proj--'), { recursive: true });
  await fsp.mkdir(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  return home;
}

async function writeRegistry(home, { archived = [], sessionIds = [] } = {}) {
  await fsp.writeFile(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: archived, pinnedSessionIds: [] },
    tables: { workspaces: { w1: { path: 'C:\\proj', title: 'demo', sessionIds, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } },
  }, null, 2));
}

function makePersistence(sessions) {
  return {
    list: async () => Object.entries(sessions).map(([id, spec]) => ({ header: { id, cwd: spec.cwd, createdAt: 1 } })),
    open: async (id) => {
      const spec = sessions[id];
      if (!spec) throw new Error(`missing ${id}`);
      return { read: async () => ({ eventState: 'detached', events: spec.events }), close: async () => {} };
    },
  };
}

function makeRegistry() {
  const detached = [];
  const unarchived = [];
  return {
    detached,
    unarchived,
    registry: {
      list: () => [{ id: 'w1', sessionIds: [], detachSession: async (id) => { detached.push(id); } }],
      unarchiveSession: async (id) => { unarchived.push(id); },
    },
  };
}

/** A registry stub whose writes land in workspace.json, like the real one. */
function makePersistingRegistry(home, sessionIds) {
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

test('a delete records the files it left behind, and the leftover scan finds them', async () => {
  const home = await makeHome();
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'purge-ws-'));
  const produced = path.join(workspaceDir, 'report.md');
  await fsp.writeFile(produced, 'hello');
  await fsp.mkdir(path.join(home, 'sessions', '--C-proj--', 'session-alpha'), { recursive: true });
  await writeRegistry(home, { archived: ['session-alpha'], sessionIds: ['session-alpha'] });

  const persistence = makePersistence({
    'session-alpha': {
      cwd: workspaceDir,
      events: [{ type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: produced }) } }],
    },
  });
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => [],
    workspaceRegistry: {
      list: () => [{ id: 'w1', sessionIds: ['session-alpha'], detachSession: async () => {} }],
      unarchiveSession: async () => {},
    },
    sessionPersistence: persistence,
  });

  const removed = await handlers.remove(['session-alpha'], {});
  assert.equal(removed.ok, true);
  const manifest = await readManifest(home);
  assert.equal(manifest.deleted.length, 1);
  assert.equal(manifest.deleted[0].files.length, 1);
  assert.equal(manifest.deleted[0].files[0].path, produced);

  const scan = await handlers.leftoverScan();
  assert.equal(scan.files.length, 1);
  assert.equal(scan.files[0].path, produced);
  assert.equal(scan.files[0].changed, false);
  assert.equal(scan.files[0].sessionId, 'session-alpha');

  const purged = await handlers.purgeLeftovers({ files: [produced] });
  assert.equal(purged.ok, true);
  assert.equal(purged.files.deleted, 1);
  assert.equal(purged.bytes, 5);
  await assert.rejects(fsp.stat(produced));
  assert.deepEqual((await readManifest(home)).deleted[0].files, [], 'the manifest forgets what is gone');
  assert.equal((await handlers.leftoverScan()).files.length, 0);
});

test('the scan reports stale cache rows, workspace slots and archive markers', async () => {
  const home = await makeHome();
  const cacheFile = path.join(home, 'storages', 'session_projcache', 'sessions', 'session-ghost.json');
  await fsp.writeFile(cacheFile, JSON.stringify({ record: { rows: {} } }));
  await writeRegistry(home, { archived: ['session-ghost'], sessionIds: ['session-ghost'] });

  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => [],
    workspaceRegistry: makePersistingRegistry(home, ['session-ghost']).registry,
    sessionPersistence: makePersistence({}),
  });

  const scan = await handlers.leftoverScan();
  assert.equal(scan.caches.length, 1);
  assert.equal(scan.accounting.length, 1);
  assert.deepEqual(scan.accounting[0], { workspaceId: 'w1', sessionId: 'session-ghost' });
  assert.equal(scan.archived.length, 1);

  const purged = await handlers.purgeLeftovers({ caches: true, accounting: true, archived: true });
  assert.equal(purged.ok, true);
  await assert.rejects(fsp.stat(cacheFile));
  const after = await handlers.leftoverScan();
  assert.equal(after.caches.length, 0);
  assert.equal(after.accounting.length, 0);
  assert.equal(after.archived.length, 0);
});

test('a file replaced after the delete is flagged and never removed', async () => {
  const home = await makeHome();
  const workspaceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'purge-ws-'));
  const produced = path.join(workspaceDir, 'report.md');
  await fsp.writeFile(produced, 'original');
  const stat = await fsp.stat(produced);
  await recordDeletions(home, [{
    id: 'session-gone',
    title: 'Gone',
    at: Date.now(),
    root: workspaceDir,
    files: [{ path: produced, bytes: stat.size, mtime: stat.mtimeMs, root: workspaceDir }],
  }]);
  await fsp.writeFile(produced, 'the user rewrote this file with new content');

  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => [],
    workspaceRegistry: { list: () => [], unarchiveSession: async () => {} },
    sessionPersistence: makePersistence({}),
  });

  const scan = await handlers.leftoverScan();
  assert.equal(scan.files.length, 1);
  assert.equal(scan.files[0].changed, true);

  const purged = await handlers.purgeLeftovers({ files: [produced] });
  assert.equal(purged.files.deleted, 0);
  assert.equal(purged.files.results[0].code, 'not-offered');
  assert.ok((await fsp.stat(produced)).isFile());
});

test('a leftover log directory of a deleted Session is reported and removed', async () => {
  const home = await makeHome();
  const dir = path.join(home, 'sessions', '--C-proj--', 'session-gone');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.alloc(64, 1));
  await writeRegistry(home, { archived: [], sessionIds: [] });
  await recordDeletions(home, [{ id: 'session-gone', title: 'Gone', at: Date.now(), root: null, files: [] }]);

  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    activity: async () => [],
    workspaceRegistry: { list: () => [], unarchiveSession: async () => {} },
    sessionPersistence: makePersistence({}),
  });

  const scan = await handlers.leftoverScan();
  assert.equal(scan.logs.length, 1);
  assert.equal(scan.logs[0].sessionId, 'session-gone');
  assert.ok(scan.logs[0].bytes >= 64);

  const purged = await handlers.purgeLeftovers({ logs: true });
  assert.deepEqual(purged.logs, [dir]);
  await assert.rejects(fsp.stat(dir));
});

test('the manifest keeps one record per Session and survives a corrupt file', async () => {
  const home = await makeHome();
  await recordDeletions(home, [{ id: 'a', title: 'A', at: 1, files: [] }]);
  await recordDeletions(home, [{ id: 'a', title: 'A2', at: 2, files: [] }, { id: 'b', title: 'B', at: 3, files: [] }]);
  const manifest = await readManifest(home);
  assert.deepEqual(manifest.deleted.map((record) => record.title), ['A2', 'B']);

  await fsp.writeFile(manifestPath(home), '{not json');
  assert.deepEqual((await readManifest(home)).deleted, []);
});
