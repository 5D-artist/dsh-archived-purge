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

function makeRegistry(sessionIds) {
  const detached = [];
  const unarchived = [];
  return {
    detached,
    unarchived,
    registry: {
      list: () => [{ id: 'w1', title: 'demo-workspace', sessionIds: [...sessionIds], detachSession: async (id) => { detached.push(id); } }],
      unarchiveSession: async (id) => { unarchived.push(id); },
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
    workspaceRegistry: makeRegistry(['session-alpha', 'session-beta']).registry,
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

  const { registry, detached, unarchived } = makeRegistry(['session-alpha', 'session-beta']);
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
  assert.deepEqual(after.archived, ['session-alpha', 'session-beta'], 'host never rewrites workspace.json directly');
});

test('refuses a live session and leaves its files alone', async () => {
  const { home, project, cache } = await makeHome();
  const alphaDir = await makeSession(project, 'session-alpha', 256);
  await makeCache(cache, 'session-alpha', 'Alpha');
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);

  const handlers = createHandlers({
    home,
    sessions: { get: (id) => (id === 'session-alpha' ? { id } : undefined) },
    workspaceRegistry: makeRegistry(['session-alpha']).registry,
    sessionPersistence: undefined,
  });
  const result = await handlers.remove(['session-alpha']);
  assert.equal(result.ok, false);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].code, 'session-active');
  assert.ok((await fsp.stat(alphaDir)).isDirectory());
});

test('rejects malformed ids and non-archived ids', async () => {
  const { home, project } = await makeHome();
  await makeSession(project, 'session-alpha', 32);
  await writeRegistry(home, ['session-alpha'], ['session-alpha']);
  const handlers = createHandlers({
    home,
    sessions: { get: () => undefined },
    workspaceRegistry: makeRegistry(['session-alpha']).registry,
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

  const { registry, detached, unarchived } = makeRegistry([]);
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
    workspaceRegistry: makeRegistry(['session-parent']).registry,
    sessionPersistence: { list: async () => snapshots },
  });

  const result = await handlers.remove(['session-parent']);
  assert.equal(result.ok, true);
  await assert.rejects(fsp.stat(parentDir));
  await assert.rejects(fsp.stat(childDir), 'subagent child must be removed with the parent');
  assert.ok((await fsp.stat(forkDir)).isDirectory(), 'ordinary fork must survive');
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
