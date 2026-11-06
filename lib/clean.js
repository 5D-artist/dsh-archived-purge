/**
 * Reference-aware cleanup helpers.
 *
 * DSH keeps two different kinds of storage behind a session:
 *
 *   - session-private: the log directory, the projection-cache row, the
 *     workspace accounting slot and the archive marker (index.js owns these);
 *   - shared: `attachments/v1/objects/<sha256>` blobs plus the derived
 *     `cache/attachments/request-images/...` downscales. Objects are
 *     content-addressed and immutable, so a resumed or forked Session can
 *     reference the same bytes; `dsh-attachment` deliberately has no
 *     per-session deletion, only a deferred reference-aware GC.
 *
 * This module supplies that missing half: it reads every stored Session log,
 * collects the digests those logs reference, and treats anything else as an
 * orphan. Two safety rules keep it from eating live data:
 *
 *   1. fail closed — an unreadable Session aborts the sweep instead of
 *      shrinking the keep-set;
 *   2. grace period — objects younger than `minAgeMs` are never orphans, which
 *      covers the window between publishing an object and appending the event
 *      that references it.
 *
 * The same scan also reports the workspace files a Session explicitly wrote or
 * presented (`write` / `edit` / `present`), so a deep clean can offer them
 * one-by-one instead of guessing from timestamps.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Attachment object names and `sha256:` references are lowered hex digests. */
const DIGEST_RE = /(?:sha256:)?\b([0-9a-f]{64})\b/g;

/** Directories that never contain disposable artifacts. */
const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules', '.svn', '.hg']);

/**
 * This plugin's own package directory. A Session that edited the plugin (or the
 * workspace around it) lists those sources as "written files"; deleting the
 * running code is never what a cleanup asks for.
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Tools whose call arguments name a file the Session produced or handed over. */
const ARTIFACT_TOOLS = new Map([
  ['write', (args) => [args?.file_path]],
  ['edit', (args) => [args?.file_path]],
  ['str_replace_editor', (args) => [args?.path]],
  ['dsh_im_return_file', (args) => [args?.path]],
  ['present', (args) => (Array.isArray(args?.files) ? args.files.map((entry) => entry?.path) : [])],
]);

/** Whether `target` is a strict descendant of `root` (both resolved). */
function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Collect every digest mentioned anywhere in one event's JSON text. */
export function collectDigests(value, into) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  for (const match of text.matchAll(DIGEST_RE)) into.add(match[1]);
}

/** Resolve whether a path may be treated as a disposable artifact. */
function hasProtectedSegment(target) {
  return path.resolve(target).split(path.sep).some((segment) => PROTECTED_SEGMENTS.has(segment));
}

/** One flat listing of regular files below `root`, with size and mtime. */
export async function walkFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.stat(full);
        found.push({ name: entry.name, file: full, bytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        /* an unreadable object simply stays out of the sweep */
      }
    }
  }
  return found;
}

/**
 * Read every stored Session except `skipIds` and collect the digests their logs
 * mention.
 * @returns {Promise<{keep: Set<string>, scanned: string[], failures: {id: string, message: string}[], unavailable: boolean}>}
 *   `failures` must be treated as fatal by the caller: a Session it could not
 *   read may be the only owner of an object.
 */
export async function collectAttachmentReferences({ sessionPersistence, skipIds }) {
  const keep = new Set();
  const scanned = [];
  const failures = [];
  if (!sessionPersistence || typeof sessionPersistence.open !== 'function' || typeof sessionPersistence.list !== 'function') {
    return { keep, scanned, failures, unavailable: true };
  }
  const snapshots = await sessionPersistence.list();
  for (const snapshot of snapshots) {
    const id = snapshot?.header?.id;
    if (typeof id !== 'string' || skipIds.has(id)) continue;
    let handle;
    try {
      handle = await sessionPersistence.open(id, 'read');
      const { events } = await handle.read();
      for (const event of events) collectDigests(event, keep);
      scanned.push(id);
    } catch (error) {
      failures.push({ id, message: error instanceof Error ? error.message : String(error) });
    } finally {
      try {
        await handle?.close?.();
      } catch {
        /* the handle is already released */
      }
    }
  }
  return { keep, scanned, failures, unavailable: false };
}

/**
 * Objects no log references, excluding anything younger than `minAgeMs`.
 * @returns {{orphans: object[], bytes: number, kept: number}} orphan entries and totals.
 */
export function pickOrphans(objects, keep, now, minAgeMs) {
  const orphans = [];
  let bytes = 0;
  let kept = 0;
  for (const object of objects) {
    if (keep.has(object.name) || now - object.mtimeMs < minAgeMs) {
      kept += 1;
      continue;
    }
    orphans.push(object);
    bytes += object.bytes;
  }
  return { orphans, bytes, kept };
}

/** Delete files, clearing the read-only bit content-addressed objects carry. */
export async function removeFiles(entries) {
  let bytes = 0;
  const failures = [];
  for (const entry of entries) {
    try {
      try {
        await fsp.rm(entry.file, { force: true });
      } catch (error) {
        if (!error || (error.code !== 'EPERM' && error.code !== 'EACCES')) throw error;
        await fsp.chmod(entry.file, 0o666);
        await fsp.rm(entry.file, { force: true });
      }
      bytes += entry.bytes ?? 0;
    } catch (error) {
      failures.push({ path: entry.file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed: entries.length - failures.length, bytes, failures };
}

/** Remove directories left empty below `root` (never `root` itself). */
export async function pruneEmptyDirs(root) {
  const resolvedRoot = path.resolve(root);
  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let empty = true;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const childEmpty = await walk(path.join(dir, entry.name));
        if (!childEmpty) empty = false;
      } else {
        empty = false;
      }
    }
    if (empty && path.resolve(dir) !== resolvedRoot) {
      try {
        await fsp.rmdir(dir);
      } catch {
        return false;
      }
    }
    return empty;
  }
  await walk(resolvedRoot);
}

/**
 * Files one or more Sessions explicitly produced: the target of a `write`,
 * `edit`, `str_replace_editor` or `dsh_im_return_file` call, or a `present`
 * deliverable. Reads, shell commands and patches are deliberately excluded —
 * they cannot prove who owns the resulting bytes.
 * @returns {Promise<{files: object[], unreadable: string[]}>} deduplicated files with their producers.
 */
export async function scanSessionArtifacts({ sessionPersistence, sessionIds, home, workspacesBySession }) {
  const files = new Map();
  const unreadable = [];
  if (!sessionPersistence || typeof sessionPersistence.open !== 'function') return { files: [], unreadable };
  for (const id of sessionIds) {
    const cwd = workspacesBySession.get(id);
    let handle;
    try {
      handle = await sessionPersistence.open(id, 'read');
      const { events } = await handle.read();
      for (const event of events) {
        if (event?.type !== 'tool/call') continue;
        const name = event.data?.name;
        const extract = ARTIFACT_TOOLS.get(name);
        if (!extract) continue;
        let args;
        try {
          args = JSON.parse(event.data?.arguments ?? 'null');
        } catch {
          continue;
        }
        for (const candidate of extract(args)) {
          if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
          if (isInside(home, candidate) || isInside(PLUGIN_ROOT, candidate) || hasProtectedSegment(candidate)) continue;
          if (cwd !== undefined && !isInside(cwd, candidate)) continue;
          let stat;
          try {
            stat = await fsp.lstat(candidate);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const resolved = path.resolve(candidate);
          const entry = files.get(resolved) ?? {
            path: resolved,
            bytes: stat.size,
            mtime: stat.mtimeMs,
            root: cwd ?? path.dirname(resolved),
            tools: [],
            sessions: [],
          };
          if (!entry.tools.includes(name)) entry.tools.push(name);
          if (!entry.sessions.includes(id)) entry.sessions.push(id);
          files.set(resolved, entry);
        }
      }
    } catch (error) {
      unreadable.push(id);
    } finally {
      try {
        await handle?.close?.();
      } catch {
        /* already released */
      }
    }
  }
  return { files: [...files.values()].sort((left, right) => right.mtime - left.mtime), unreadable };
}

/**
 * Delete a caller-listed subset of a server-derived artifact set. A path that
 * this server did not offer for these Sessions is refused, so the route can
 * never be turned into an arbitrary file deleter.
 * @returns {Promise<{deleted: number, bytes: number, results: object[]}>} per-path outcomes.
 */
export async function deleteArtifactFiles({ files, requested, home }) {
  const offered = new Map(files.map((entry) => [entry.path, entry]));
  const results = [];
  let deleted = 0;
  let bytes = 0;
  for (const wanted of requested) {
    if (typeof wanted !== 'string' || !path.isAbsolute(wanted)) {
      results.push({ path: String(wanted), ok: false, code: 'invalid-path' });
      continue;
    }
    const resolved = path.resolve(wanted);
    const entry = offered.get(resolved);
    if (!entry) {
      results.push({ path: resolved, ok: false, code: 'not-offered' });
      continue;
    }
    if (isInside(home, resolved) || isInside(PLUGIN_ROOT, resolved) || hasProtectedSegment(resolved) || (entry.root && !isInside(entry.root, resolved))) {
      results.push({ path: resolved, ok: false, code: 'outside-session-root' });
      continue;
    }
    let stat;
    try {
      stat = await fsp.lstat(resolved);
    } catch {
      results.push({ path: resolved, ok: false, code: 'missing' });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      results.push({ path: resolved, ok: false, code: 'not-a-file' });
      continue;
    }
    try {
      await fsp.rm(resolved, { force: true });
      deleted += 1;
      bytes += stat.size;
      results.push({ path: resolved, ok: true, bytes: stat.size });
    } catch (error) {
      results.push({ path: resolved, ok: false, code: 'delete-failed', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { deleted, bytes, results };
}
