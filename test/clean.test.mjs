import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  collectAttachmentReferences,
  deleteArtifactFiles,
  pickOrphans,
  pruneEmptyDirs,
  removeFiles,
  scanSessionArtifacts,
  walkFiles,
} from '../lib/clean.js';

const hex = (fill) => fill.repeat(64).slice(0, 64).toLowerCase();

function fakePersistence(sessions) {
  return {
    list: async () => Object.entries(sessions).map(([id, spec]) => ({ header: { id, cwd: spec.cwd, createdAt: 1 } })),
    open: async (id) => {
      const spec = sessions[id];
      if (!spec) throw new Error(`missing ${id}`);
      if (spec.unreadable) throw new Error('corrupt log');
      return {
        read: async () => ({ eventState: 'detached', events: spec.events }),
        close: async () => {},
      };
    },
  };
}

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'purge-clean-'));
}

test('collects attachment digests from events and honours the skip list', async () => {
  const persistence = fakePersistence({
    'session-a': {
      cwd: 'C:\\work',
      events: [
        { type: 'user/message', data: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${hex('a')}` } }] } },
        { type: 'request/header', data: { text: `object path ${hex('b')}` } },
      ],
    },
    'session-b': { cwd: 'C:\\work', events: [{ data: { attachmentId: `sha256:${hex('c')}` } }] },
  });
  const all = await collectAttachmentReferences({ sessionPersistence: persistence, skipIds: new Set() });
  assert.deepEqual([...all.keep].sort(), [hex('a'), hex('b'), hex('c')].sort());
  assert.deepEqual(all.failures, []);
  assert.equal(all.scanned.length, 2);

  const skipped = await collectAttachmentReferences({ sessionPersistence: persistence, skipIds: new Set(['session-b']) });
  assert.deepEqual([...skipped.keep].sort(), [hex('a'), hex('b')].sort());
  assert.deepEqual(skipped.scanned, ['session-a']);
});

test('fails closed by reporting an unreadable Session', async () => {
  const persistence = fakePersistence({
    'session-a': { cwd: 'C:\\work', events: [] },
    'session-b': { cwd: 'C:\\work', unreadable: true, events: [] },
  });
  const refs = await collectAttachmentReferences({ sessionPersistence: persistence, skipIds: new Set() });
  assert.equal(refs.failures.length, 1);
  assert.equal(refs.failures[0].id, 'session-b');
});

test('reports the store as unavailable without a persistence backend', async () => {
  const refs = await collectAttachmentReferences({ sessionPersistence: undefined, skipIds: new Set() });
  assert.equal(refs.unavailable, true);
});

test('orphans exclude referenced objects and anything younger than the grace period', () => {
  const now = 10_000_000;
  const objects = [
    { name: hex('a'), bytes: 100, mtimeMs: now - 1_000_000 },
    { name: hex('b'), bytes: 200, mtimeMs: now - 1_000_000 },
    { name: hex('c'), bytes: 300, mtimeMs: now - 1000 },
  ];
  const picked = pickOrphans(objects, new Set([hex('a')]), now, 60_000);
  assert.deepEqual(picked.orphans.map((o) => o.name), [hex('b')]);
  assert.equal(picked.bytes, 200);
  assert.equal(picked.kept, 2);
});

test('walkFiles sees nested objects; removeFiles clears the read-only bit', async () => {
  const root = await tempDir();
  const shard = path.join(root, 'ab');
  await fsp.mkdir(shard, { recursive: true });
  const file = path.join(shard, hex('a'));
  await fsp.writeFile(file, Buffer.alloc(64, 1));
  await fsp.chmod(file, 0o444);
  const found = await walkFiles(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].bytes, 64);
  const removal = await removeFiles(found);
  assert.equal(removal.removed, 1);
  assert.equal(removal.bytes, 64);
  await assert.rejects(fsp.stat(file));
  await pruneEmptyDirs(root);
  await assert.rejects(fsp.stat(shard));
  assert.ok((await fsp.stat(root)).isDirectory(), 'the root itself stays');
});

test('scanSessionArtifacts keeps written and presented files inside the session cwd', async () => {
  const cwd = await tempDir();
  const home = await tempDir();
  const written = path.join(cwd, 'report.md');
  const presented = path.join(cwd, 'cover.png');
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
  const inGit = path.join(cwd, '.git', 'config');
  await fsp.writeFile(written, 'hello');
  await fsp.writeFile(presented, Buffer.alloc(32, 2));
  await fsp.writeFile(outside, 'nope');
  await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fsp.writeFile(inGit, 'x');

  const persistence = fakePersistence({
    'session-a': {
      cwd,
      events: [
        { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: written }) } },
        { type: 'tool/call', data: { name: 'present', arguments: JSON.stringify({ files: [{ path: presented }] }) } },
        { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: outside }) } },
        { type: 'tool/call', data: { name: 'edit', arguments: JSON.stringify({ file_path: inGit }) } },
        { type: 'tool/call', data: { name: 'read', arguments: JSON.stringify({ file_path: written }) } },
      ],
    },
  });
  const { files, unreadable } = await scanSessionArtifacts({
    sessionPersistence: persistence,
    sessionIds: ['session-a'],
    home,
    workspacesBySession: new Map([['session-a', cwd]]),
  });
  assert.deepEqual(unreadable, []);
  assert.deepEqual(files.map((f) => f.path).sort(), [presented, written].sort());
  const report = files.find((f) => f.path === written);
  assert.deepEqual(report.tools, ['write']);
  assert.deepEqual(report.sessions, ['session-a']);
});

test('deleteArtifactFiles only accepts paths the scan offered', async () => {
  const cwd = await tempDir();
  const home = await tempDir();
  const offered = path.join(cwd, 'a.txt');
  const sneaky = path.join(cwd, 'b.txt');
  await fsp.writeFile(offered, 'a');
  await fsp.writeFile(sneaky, 'b');
  const files = [{ path: offered, bytes: 1, mtime: 0, root: cwd, tools: ['write'], sessions: ['session-a'] }];

  const result = await deleteArtifactFiles({
    files,
    requested: [offered, sneaky, path.join(home, 'x'), 'relative.txt'],
    home,
  });
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.results.map((r) => r.ok), [true, false, false, false]);
  assert.equal(result.results[1].code, 'not-offered');
  await assert.rejects(fsp.stat(offered));
  assert.ok((await fsp.stat(sneaky)).isFile(), 'an unoffered path is never touched');
});
