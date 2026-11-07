/**
 * Host half of dsh-archived-purge.
 *
 * Lists every archived Session of the current DSH home and permanently removes
 * a selection: the session log directory, the projection-cache row, the
 * workspace accounting slot, and the id in the global archive set.
 *
 * The store layout is the shipped one (dsh-base cordis.patch.yml):
 *   <DSH_HOME>/sessions/--<normalized-cwd>--/<session-id>/session.vN.jsonl*
 *   <DSH_HOME>/storages/workspace.json
 *   <DSH_HOME>/storages/session_projcache/sessions/<session-id>.json
 *
 * Deletion is guarded: ids are shape-checked, every path must stay inside the
 * two storage roots, a Session that is still doing work is refused, and
 * workspace accounting is cleared through the public registry API rather than
 * a raw registry rewrite.
 *
 * A "remove the materials too" delete (`everything: true`) derives the whole
 * disposable set on the Host, never from the request: the workspace files the
 * logs prove the Session wrote, the attachment objects nothing else references,
 * and the scheduled tasks aimed at Sessions that no longer exist. Keeping the
 * derivation server-side is what makes one click safe: the browser can only
 * narrow the set, never widen it.
 *
 * Liveness is NOT `ctx.sessions.get(id)`. Archiving only hides a Session from
 * the grouping surfaces; it never disposes it, so every archived Session that
 * has been used in this process stays resident in the store. A resident
 * Session is idle, not running — judging by presence alone refused every
 * archived Session that was still warm and made "delete selected" always fail
 * with a bare HTTP 400. The faithful signal is the
 * `workspace/session-activity` waterfall, answered by the Agent registry
 * (`turn`), the job registry, the subagent runtime and the scheduler; it is
 * the same admission check `archiveSession` uses.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  collectAttachmentReferences,
  deleteArtifactFiles,
  fileStampMatches,
  pickOrphans,
  pruneEmptyDirs,
  readManifest,
  recordDeletions,
  removeFiles,
  scanSessionArtifacts,
  walkFiles,
  writeManifest,
} from './lib/clean.js';

export const name = 'archived-purge';
export const inject = ['webServer', 'workspaceRegistry', 'sessions', 'sessionPersistence'];

/** Innermost `next` of the activity waterfall: no listener means no work. */
const NO_ACTIVITY = () => Promise.resolve([]);

const ROUTE = '/plugins/archived-purge';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_IDS = 500;
const MAX_BODY = 64 * 1024;
const MAX_CASCADE_DEPTH = 8;
/**
 * Objects younger than this are never collected: an attachment is published
 * before the event that references it is appended, and a live Session's log may
 * lag its in-memory state by one checkpoint.
 */
const GC_MIN_AGE_MS = 10 * 60 * 1000;

function resolveHome() {
  const env = process.env.DSH_HOME;
  if (env && path.isAbsolute(env)) return env;
  const profileDir = process.env.DSH_PROFILE_DIR;
  if (profileDir && path.isAbsolute(profileDir)) return path.resolve(profileDir, '..', '..');
  return path.join(os.homedir(), '.dsh');
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function readJson(file) {
  const text = await fsp.readFile(file, 'utf8');
  return JSON.parse(text);
}

export async function readArchivedState(home) {
  const workspaceFile = path.join(home, 'storages', 'workspace.json');
  let doc;
  try {
    doc = await readJson(workspaceFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { archived: [], workspaces: {}, workspaceFile, missing: true };
    }
    throw error;
  }
  const archived = Array.isArray(doc?.global?.archivedSessionIds)
    ? doc.global.archivedSessionIds.filter((id) => typeof id === 'string')
    : [];
  const workspaces = doc?.tables?.workspaces && typeof doc.tables.workspaces === 'object'
    ? doc.tables.workspaces
    : {};
  return { archived, workspaces, workspaceFile, missing: false };
}

export async function scanSessionDirs(root) {
  /** @type {Map<string, string[]>} */
  const map = new Map();
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('--')) continue;
    const projectDir = path.join(root, entry.name);
    let children;
    try {
      children = await fsp.readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      const dir = path.join(projectDir, child.name);
      const list = map.get(child.name);
      if (list) list.push(dir);
      else map.set(child.name, [dir]);
    }
  }
  return map;
}

export async function dirStats(dir) {
  let bytes = 0;
  let newest = 0;
  let files = 0;
  const stack = [dir];
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
        bytes += stat.size;
        files += 1;
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      } catch {
        /* an unreadable file does not make the row fail */
      }
    }
  }
  return { bytes, newest, files };
}

async function removeTree(dir) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 80 });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
  }
  throw lastError;
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function workspaceIndex(workspaces) {
  const byId = new Map();
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (!record || typeof record !== 'object') continue;
    byId.set(workspaceId, record);
  }
  return byId;
}

function workspaceOf(workspaces, sessionId) {
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    if (!record || !Array.isArray(record.sessionIds)) continue;
    if (record.sessionIds.includes(sessionId)) return { workspaceId, record };
  }
  return undefined;
}

function titleOfCache(doc) {
  const value = doc?.record?.rows?.title?.val;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

async function readCacheDoc(cacheDir, sessionId) {
  try {
    const doc = await readJson(path.join(cacheDir, `${sessionId}.json`));
    return doc;
  } catch {
    return undefined;
  }
}

export function createHandlers(deps) {
  const { home, sessions, workspaceRegistry, sessionPersistence, activity, getSchedule } = deps;
  const sessionsRoot = path.join(home, 'sessions');
  const cacheRoot = path.join(home, 'storages', 'session_projcache', 'sessions');
  const attachmentsRoot = path.join(home, 'attachments', 'v1', 'objects');
  const requestImagesRoot = path.join(home, 'cache', 'attachments', 'request-images');

  /**
   * The work families a Session still reports, e.g. `['turn']`. An absent
   * probe yields no activity; a throwing probe propagates so the caller can
   * refuse instead of deleting a Session whose state is unknown.
   * @param {string} id - session id.
   * @returns {Promise<string[]>} distinct non-empty activity kinds.
   */
  async function activityKinds(id) {
    if (typeof activity !== 'function') return [];
    const reported = await activity(id);
    if (!Array.isArray(reported)) return [];
    const kinds = [];
    for (const entry of reported) {
      const kind = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? entry.kind : undefined;
      if (typeof kind === 'string' && kind.length > 0 && !kinds.includes(kind)) kinds.push(kind);
    }
    return kinds;
  }

  /** Whether the store still holds the Session in memory (informational only). */
  function isResident(id) {
    try {
      return Boolean(sessions && typeof sessions.get === 'function' && sessions.get(id));
    } catch {
      return false;
    }
  }

  /** Session id → the directory that Session could write into. */
  async function cwdBySession() {
    const map = new Map();
    if (sessionPersistence && typeof sessionPersistence.list === 'function') {
      try {
        for (const snapshot of await sessionPersistence.list()) {
          const id = snapshot?.header?.id;
          const cwd = snapshot?.header?.cwd;
          if (typeof id === 'string' && typeof cwd === 'string') map.set(id, cwd);
        }
      } catch {
        /* fall back to the workspace records below */
      }
    }
    const { workspaces } = await readArchivedState(home);
    for (const record of Object.values(workspaces)) {
      if (!record || !Array.isArray(record.sessionIds) || typeof record.path !== 'string') continue;
      for (const id of record.sessionIds) if (!map.has(id)) map.set(id, record.path);
    }
    return map;
  }

  /**
   * Reference-aware view of the attachment store for a hypothetical state where
   * `skipIds` no longer exist: what the logs still reference, and what would
   * become garbage.
   * @param {Set<string>} skipIds - Sessions assumed to be gone.
   * @returns {Promise<object>} totals plus the orphan entries a purge would remove.
   */
  async function attachmentPlan(skipIds) {
    const objects = await walkFiles(attachmentsRoot);
    const totalBytes = objects.reduce((sum, object) => sum + object.bytes, 0);
    let refs;
    try {
      refs = await collectAttachmentReferences({ sessionPersistence, skipIds });
    } catch (error) {
      return { objects, totalBytes, blocked: 'reference-scan-failed', message: formatError(error) };
    }
    if (refs.unavailable) return { objects, totalBytes, blocked: 'persistence-unavailable', scanned: 0 };
    if (refs.failures.length > 0) {
      // Fail closed: an unreadable log may be the only owner of an object.
      return {
        objects,
        totalBytes,
        blocked: 'unreadable-session',
        scanned: refs.scanned.length,
        failures: refs.failures,
      };
    }
    const picked = pickOrphans(objects, refs.keep, Date.now(), GC_MIN_AGE_MS);
    return {
      objects,
      totalBytes,
      scanned: refs.scanned.length,
      keptObjects: picked.kept,
      orphans: picked.orphans,
      orphanObjects: picked.orphans.length,
      orphanBytes: picked.bytes,
    };
  }

  /**
   * The optional Schedule service, resolved lazily: a Host without the
   * Schedule plugin has no `schedule` service and simply has no tasks.
   * @returns {object|undefined} the service or undefined.
   */
  function scheduleService() {
    try {
      return typeof getSchedule === 'function' ? getSchedule() : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Scheduled tasks whose delivery target is one of `ids`. A task aimed at a
   * removed Session can never fire again, so it is disposable with that
   * Session — unlike a task that merely lists it as involved.
   * @param {string[]} ids - Sessions that are about to disappear.
   * @returns {Promise<{available: boolean, tasks: object[], message?: string}>}
   */
  async function scheduleTasksOf(ids) {
    const service = scheduleService();
    if (!service || typeof service.catalog !== 'function') return { available: false, tasks: [] };
    let all;
    try {
      all = await service.catalog();
    } catch (error) {
      return { available: false, tasks: [], message: formatError(error) };
    }
    const wanted = new Set(ids);
    const tasks = [];
    for (const task of Array.isArray(all) ? all : []) {
      const target = task?.target;
      if (!target || target.kind === 'new') continue;
      if (typeof target.sessionId !== 'string' || !wanted.has(target.sessionId)) continue;
      tasks.push({
        id: String(task.id),
        title: typeof task.title === 'string' ? task.title : '',
        status: typeof task.status === 'string' ? task.status : '',
        targetSessionId: target.sessionId,
      });
    }
    return { available: true, tasks };
  }

  /** Delete dead scheduled tasks one by one, reporting what refused. */
  async function removeSchedules(tasks) {
    const service = scheduleService();
    const removed = [];
    const failures = [];
    for (const task of tasks) {
      if (!service || typeof service.edit !== 'function') {
        failures.push({ id: task.id, message: 'schedule service unavailable' });
        continue;
      }
      try {
        await service.edit({ id: task.id, action: 'delete' });
        removed.push(task.id);
      } catch (error) {
        failures.push({ id: task.id, message: formatError(error) });
      }
    }
    return { removed, failures };
  }

  /** The derived downscale cache: regenerable, so a deep clean may clear it. */
  async function requestImagesPlan() {
    const entries = await walkFiles(requestImagesRoot);
    return { files: entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
  }

  /** Workspace files the given Sessions explicitly wrote or presented. */
  async function artifactScan(ids) {
    const cwds = await cwdBySession();
    const scanned = await scanSessionArtifacts({
      sessionPersistence,
      sessionIds: ids,
      home,
      workspacesBySession: cwds,
    });
    return { ...scanned, cwds };
  }

  async function state() {
    const { archived, workspaces } = await readArchivedState(home);
    const dirs = await scanSessionDirs(sessionsRoot);
    // One catalog read tells every row whether deleting it would also retire a
    // scheduled task; the map keeps the per-row cost at a lookup.
    const scheduled = await scheduleTasksOf(archived);
    const scheduleCounts = new Map();
    for (const task of scheduled.tasks) {
      scheduleCounts.set(task.targetSessionId, (scheduleCounts.get(task.targetSessionId) ?? 0) + 1);
    }
    const items = [];
    let pendingFinalize = 0;
    for (const id of archived) {
      if (!ID_RE.test(id)) continue;
      const sessionDirs = dirs.get(id) ?? [];
      if (sessionDirs.length === 0) {
        // No log left: the entry is only bookkeeping, either from a delete that
        // ran while the Session was resident or from a log removed by hand.
        // finalizePending() clears it; listing it would show a 0-byte ghost.
        pendingFinalize += 1;
        continue;
      }
      const cacheDoc = await readCacheDoc(cacheRoot, id);
      let bytes = 0;
      let lastActivity = 0;
      for (const dir of sessionDirs) {
        const stats = await dirStats(dir);
        bytes += stats.bytes;
        if (stats.newest > lastActivity) lastActivity = stats.newest;
      }
      let cacheBytes = 0;
      try {
        const cacheStat = await fsp.stat(path.join(cacheRoot, `${id}.json`));
        cacheBytes = cacheStat.size;
        if (cacheStat.mtimeMs > lastActivity) lastActivity = cacheStat.mtimeMs;
      } catch {
        /* no cache row */
      }
      if (cacheDoc) bytes += cacheBytes;
      const owner = workspaceOf(workspaces, id);
      const title = titleOfCache(cacheDoc);
      let kinds = [];
      let activityUnknown = false;
      try {
        kinds = await activityKinds(id);
      } catch {
        activityUnknown = true;
      }
      items.push({
        id,
        title,
        workspaceId: owner?.workspaceId ?? null,
        workspaceTitle: typeof owner?.record?.title === 'string' ? owner.record.title : '',
        workspacePath: typeof owner?.record?.path === 'string' ? owner.record.path : '',
        sizeBytes: bytes,
        cacheBytes,
        lastActivity: lastActivity || null,
        exists: sessionDirs.length > 0,
        cacheExists: Boolean(cacheDoc),
        active: kinds.length > 0,
        activity: kinds,
        activityUnknown,
        resident: isResident(id),
        scheduleCount: scheduleCounts.get(id) ?? 0,
      });
    }
    items.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
    return {
      items,
      archivedCount: items.length,
      pendingFinalize,
      totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
      generatedAt: Date.now(),
    };
  }

  async function descendantsOf(roots, skip) {
    if (!sessionPersistence || typeof sessionPersistence.list !== 'function') return [];
    let snapshots;
    try {
      snapshots = await sessionPersistence.list();
    } catch {
      return [];
    }
    const children = new Map();
    for (const snapshot of snapshots) {
      const header = snapshot?.header;
      if (!header || header.origin !== 'subagent') continue;
      const parent = header.parentSession;
      if (!parent) continue;
      const list = children.get(parent);
      if (list) list.push(header.id);
      else children.set(parent, [header.id]);
    }
    const found = [];
    let frontier = [...roots];
    for (let depth = 0; depth < MAX_CASCADE_DEPTH && frontier.length > 0; depth += 1) {
      const next = [];
      for (const parent of frontier) {
        for (const child of children.get(parent) ?? []) {
          if (skip.has(child) || found.includes(child)) continue;
          found.push(child);
          next.push(child);
        }
      }
      frontier = next;
    }
    return found;
  }

  async function removeOne(id, dirs, options, workspaces) {
    // Re-checked per item: work can start between the batch pre-flight and the
    // moment this file system call runs.
    let kinds;
    try {
      kinds = await activityKinds(id);
    } catch (error) {
      return { id, ok: false, code: 'activity-unknown', message: formatError(error) };
    }
    if (kinds.length > 0) {
      return { id, ok: false, code: 'session-active', message: '会话仍在运行，已跳过', activity: kinds };
    }
    let removedBytes = 0;
    const failures = [];
    for (const dir of dirs) {
      if (!isInside(sessionsRoot, dir)) {
        failures.push('path-outside-sessions-root');
        continue;
      }
      try {
        const stats = await dirStats(dir);
        await removeTree(dir);
        removedBytes += stats.bytes;
      } catch (error) {
        failures.push(formatError(error));
      }
    }
    const cacheFile = path.join(cacheRoot, `${id}.json`);
    if (isInside(cacheRoot, cacheFile)) {
      try {
        const stat = await fsp.stat(cacheFile);
        await fsp.rm(cacheFile, { force: true });
        removedBytes += stat.size;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') failures.push(formatError(error));
      }
    }
    if (failures.length > 0) {
      return { id, ok: false, code: 'delete-failed', message: failures.join('; '), removedBytes };
    }
    if (!options?.cascade) {
      // A plugin cannot evict a resident Session from `ctx.sessions`: archiving
      // never disposes it, and the AgentHandle disposer belongs to its creator.
      // Dropping the workspace slot while the Session is still listed would
      // surface it under the sidebar's "未分组" bucket until the process exits,
      // so the slot and the archive marker are kept and `finalizePending()`
      // completes them once the Session is no longer resident (next start).
      if (isResident(id)) return { id, ok: true, removedBytes, deferred: true };
      const workspaceId = rawOwner(workspaces, id);
      if (workspaceId) {
        const owner = wsEntity(workspaceId);
        if (owner) {
          try {
            await owner.detachSession(id);
          } catch (error) {
            return { id, ok: false, code: 'registry-failed', message: formatError(error), removedBytes };
          }
        }
      }
      try {
        await workspaceRegistry.unarchiveSession(id);
      } catch (error) {
        return { id, ok: false, code: 'unarchive-failed', message: formatError(error), removedBytes };
      }
    }
    return { id, ok: true, removedBytes, cascade: Boolean(options?.cascade) };
  }

  function rawOwner(workspaces, id) {
    for (const [workspaceId, record] of Object.entries(workspaces)) {
      if (record && Array.isArray(record.sessionIds) && record.sessionIds.includes(id)) return workspaceId;
    }
    return undefined;
  }

  function wsEntity(workspaceId) {
    if (!workspaceRegistry) return undefined;
    try {
      if (typeof workspaceRegistry.get === 'function') {
        const entity = workspaceRegistry.get(workspaceId);
        if (entity && typeof entity.detachSession === 'function') return entity;
      }
      if (typeof workspaceRegistry.list === 'function') {
        const entity = workspaceRegistry.list().find((workspace) => workspace.id === workspaceId);
        if (entity && typeof entity.detachSession === 'function') return entity;
      }
    } catch {
      /* an unavailable registry leaves the accounting slot for a later repair */
    }
    return undefined;
  }

  /**
   * Clear the bookkeeping a delete had to leave behind because the Session was
   * still resident: its workspace slot and its archive marker. Runs when the
   * plugin loads and before every batch, so a deferred delete finishes as soon
   * as the Session is out of the store (i.e. on the next start) instead of
   * leaving a ghost in the sidebar or in this list.
   * @returns {Promise<string[]>} the ids that were finalized.
   */
  async function finalizePending() {
    const { archived, workspaces } = await readArchivedState(home);
    if (archived.length === 0) return [];
    const dirs = await scanSessionDirs(sessionsRoot);
    const done = [];
    for (const id of archived) {
      if (!ID_RE.test(id)) continue;
      if ((dirs.get(id) ?? []).length > 0) continue;
      if (isResident(id)) continue;
      const workspaceId = rawOwner(workspaces, id);
      if (workspaceId) {
        const owner = wsEntity(workspaceId);
        if (owner) {
          try {
            await owner.detachSession(id);
          } catch {
            continue;
          }
        }
      }
      try {
        await workspaceRegistry.unarchiveSession(id);
        done.push(id);
      } catch {
        /* retried on the next load */
      }
      try {
        await fsp.rm(path.join(cacheRoot, `${id}.json`), { force: true });
      } catch {
        /* a leftover cache row is disposable */
      }
    }
    return done;
  }

  async function remove(requested, options = {}) {
    if (!Array.isArray(requested) || requested.length === 0) {
      return { ok: false, code: 'invalid-request', message: 'sessionIds 不能为空' };
    }
    if (requested.length > MAX_IDS) {
      return { ok: false, code: 'invalid-request', message: `一次最多删除 ${MAX_IDS} 个会话` };
    }
    const ids = [];
    for (const value of requested) {
      if (typeof value !== 'string' || !ID_RE.test(value)) {
        return { ok: false, code: 'invalid-request', message: '会话 ID 不合法' };
      }
      if (!ids.includes(value)) ids.push(value);
    }
    // Heal markers left by an earlier delete whose target was still resident.
    const finalized = await finalizePending();
    const { archived, workspaces } = await readArchivedState(home);
    const archivedSet = new Set(archived);
    const notArchived = ids.filter((id) => !archivedSet.has(id));
    if (notArchived.length > 0) {
      return {
        ok: false,
        code: 'not-archived',
        message: `有 ${notArchived.length} 个会话不在归档集合中，请刷新后重试`,
        notArchived,
      };
    }
    const dirs = await scanSessionDirs(sessionsRoot);
    const skip = new Set(ids);
    const childIds = await descendantsOf(ids, skip);

    // Pre-flight the whole batch before touching any file: a single Session
    // that is still working refuses the request and deletes nothing, so the
    // list never ends up half-cleaned with an orphaned running log.
    const active = [];
    for (const id of [...ids, ...childIds]) {
      let kinds;
      try {
        kinds = await activityKinds(id);
      } catch (error) {
        return {
          ok: false,
          code: 'activity-unknown',
          message: `无法确认会话是否仍在运行，已取消本次删除：${formatError(error)}`,
          deleted: 0,
          failed: 0,
          results: [],
        };
      }
      if (kinds.length > 0) active.push({ id, kinds });
    }
    if (active.length > 0) {
      return {
        ok: false,
        code: 'session-active',
        message: `有 ${active.length} 个会话仍在运行，已取消本次删除`,
        active,
        deleted: 0,
        failed: 0,
        results: [],
      };
    }

    // The artifact list is needed for two things: the files the caller ticked,
    // and the manifest a later leftover scan reads once the log is gone. Both
    // must be derived here, while the log is still readable; the request never
    // decides what is allowed.
    const scannedArtifacts = await artifactScan([...ids, ...childIds]);
    const schedulePlan = await scheduleTasksOf([...ids, ...childIds]);
    const artifactFiles = scannedArtifacts.files;
    const artifactCwd = scannedArtifacts.cwds ?? new Map();
    const titles = new Map();
    for (const id of ids) {
      const cacheDoc = await readCacheDoc(cacheRoot, id);
      if (cacheDoc) titles.set(id, titleOfCache(cacheDoc));
    }

    const results = [];
    for (const id of ids) {
      const result = await removeOne(id, dirs.get(id) ?? [], { cascade: false }, workspaces);
      results.push(result);
    }
    for (const id of childIds) {
      const result = await removeOne(id, dirs.get(id) ?? [], { cascade: true }, workspaces);
      results.push({ ...result, child: true });
    }

    // Only files owned by Sessions that really went away stay on the table.
    const gone = new Set(results.filter((item) => item.ok).map((item) => item.id));
    const owned = artifactFiles.filter((file) => file.sessions.some((id) => gone.has(id)));
    const wantedFiles = options?.everything === true
      ? owned.map((file) => file.path)
      : (Array.isArray(options?.files) ? options.files : []);
    let artifacts;
    if (owned.length > 0 && wantedFiles.length > 0) {
      artifacts = await deleteArtifactFiles({ files: owned, requested: wantedFiles, home });
    }

    // A task targeting a removed Session is dead weight: retire it so the
    // schedule list does not accumulate rows that can never be delivered.
    let schedules;
    if (options?.schedules !== false) {
      const targets = schedulePlan.tasks.filter((task) => gone.has(task.targetSessionId));
      if (targets.length > 0) {
        const removal = await removeSchedules(targets);
        schedules = {
          deleted: removal.removed.length,
          failed: removal.failures.length,
          failures: removal.failures,
          tasks: targets.length,
        };
      }
    }

    // Record what the removed Sessions had produced, so a later scan can still
    // find those files once their logs (and their attribution) are gone.
    try {
      const records = [...gone].map((id) => ({
        id,
        title: titles.get(id) ?? '',
        at: Date.now(),
        root: artifactCwd.get(id) ?? null,
        files: artifactFiles
          .filter((file) => file.sessions.includes(id))
          .map((file) => ({ path: file.path, bytes: file.bytes, mtime: file.mtime, root: file.root })),
      }));
      await recordDeletions(home, records);
    } catch {
      /* the manifest only feeds the leftover report; a failure must not fail the delete */
    }

    let gc;
    if (options?.everything === true || options?.attachments === true) {
      const plan = await attachmentPlan(new Set());
      if (plan.blocked) {
        gc = { blocked: plan.blocked, message: plan.message, failures: plan.failures };
      } else {
        const removal = await removeFiles(plan.orphans);
        await pruneEmptyDirs(attachmentsRoot);
        gc = { removedObjects: removal.removed, removedBytes: removal.bytes, failures: removal.failures };
      }
    }
    if (options?.requestImages === true) {
      const images = await requestImagesPlan();
      const cleared = await removeFiles(images.files);
      await pruneEmptyDirs(requestImagesRoot);
      gc = { ...(gc ?? {}), requestImages: { removedFiles: cleared.removed, bytes: cleared.bytes, failures: cleared.failures } };
    }

    const deleted = results.filter((item) => item.ok);
    const failed = results.filter((item) => !item.ok);
    const deferred = results.filter((item) => item.ok && item.deferred).map((item) => item.id);
    const ok = failed.length === 0;
    const deferredNote = deferred.length > 0 ? `（其中 ${deferred.length} 个的记账待重启后回收）` : '';
    return {
      ok,
      code: ok ? undefined : 'delete-failed',
      message: ok
        ? `已删除 ${deleted.length} 个会话${deferredNote}`
        : `${failed.length} 个会话删除失败：${failed[0].message ?? failed[0].code ?? '未知错误'}`,
      deleted: deleted.length,
      failed: failed.length,
      deferred,
      finalized,
      artifacts,
      schedules,
      gc,
      removedBytes: results.reduce((sum, item) => sum + (item.removedBytes ?? 0), 0),
      results,
      archivedCount: archived.length,
      workspaceCount: Object.keys(workspaces).length,
    };
  }

  /**
   * Dry-run or execute the reference-aware attachment sweep, independent of any
   * Session deletion.
   * @param {{dryRun?: boolean, requestImages?: boolean}} [options] - whether to only report.
   * @returns {Promise<object>} totals, removals, and the failures worth showing.
   */
  async function collectGarbage(options = {}) {
    const plan = await attachmentPlan(new Set());
    const images = await requestImagesPlan();
    if (plan.blocked) {
      return {
        ok: false,
        code: plan.blocked,
        message: plan.message ?? '无法确认附件引用关系，已取消清理',
        failures: plan.failures,
        requestImages: { files: images.files.length, bytes: images.bytes },
      };
    }
    if (options.dryRun !== false) {
      return {
        ok: true,
        dryRun: true,
        orphanObjects: plan.orphanObjects,
        orphanBytes: plan.orphanBytes,
        totalObjects: plan.objects.length,
        totalBytes: plan.totalBytes,
        scannedSessions: plan.scanned,
        requestImages: { files: images.files.length, bytes: images.bytes },
      };
    }
    const removal = await removeFiles(plan.orphans);
    await pruneEmptyDirs(attachmentsRoot);
    const result = {
      ok: removal.failures.length === 0,
      dryRun: false,
      removedObjects: removal.removed,
      removedBytes: removal.bytes,
      failures: removal.failures,
      scannedSessions: plan.scanned,
    };
    if (options.requestImages === true) {
      const cleared = await removeFiles(images.files);
      await pruneEmptyDirs(requestImagesRoot);
      result.requestImages = { removedFiles: cleared.removed, bytes: cleared.bytes, failures: cleared.failures };
    } else {
      result.requestImages = { files: images.files.length, bytes: images.bytes };
    }
    return result;
  }

  /**
   * Read-only plan for a deep clean: what the given Sessions would leave behind
   * (attachments), what the derived cache costs, and which workspace files they
   * explicitly produced.
   * @param {string[]} ids - Sessions the caller is about to delete.
   * @returns {Promise<object>} report consumed by the settings page.
   */
  async function scanAll(ids) {
    const plan = await attachmentPlan(new Set(ids));
    const images = await requestImagesPlan();
    const { files, unreadable } = await artifactScan(ids);
    const scheduled = await scheduleTasksOf(ids);
    return {
      ok: true,
      attachments: {
        objects: plan.objects.length,
        bytes: plan.totalBytes,
        orphanObjects: plan.orphanObjects ?? null,
        orphanBytes: plan.orphanBytes ?? null,
        keptObjects: plan.keptObjects ?? null,
        scannedSessions: plan.scanned ?? 0,
        blocked: plan.blocked,
        failures: plan.failures,
      },
      requestImages: { files: images.files.length, bytes: images.bytes },
      artifacts: files.map((file) => ({
        path: file.path,
        bytes: file.bytes,
        mtime: file.mtime,
        tools: file.tools,
        sessions: file.sessions,
      })),
      unreadableSessions: unreadable,
      schedules: {
        available: scheduled.available,
        count: scheduled.tasks.length,
        items: scheduled.tasks,
        message: scheduled.message,
      },
    };
  }

  /**
   * What already-removed Sessions can still leave on disk: the files they
   * produced (from the deletion manifest), a log directory or projection-cache
   * row for an id that no longer exists, a dangling workspace slot or archive
   * marker, plus the reference-aware attachment picture.
   * @returns {Promise<object>} a read-only report; nothing is removed here.
   */
  async function leftoverScan() {
    const manifest = await readManifest(home);
    const dirs = await scanSessionDirs(sessionsRoot);
    const { archived, workspaces } = await readArchivedState(home);
    const listed = new Set();
    if (sessionPersistence && typeof sessionPersistence.list === 'function') {
      try {
        for (const snapshot of await sessionPersistence.list()) {
          const id = snapshot?.header?.id;
          if (typeof id === 'string') listed.add(id);
        }
      } catch {
        /* an unreadable listing simply widens nothing: every check below still needs a definite miss */
      }
    }
    const gone = (id) => !listed.has(id) && !isResident(id) && (dirs.get(id) ?? []).length === 0;
    // A directory nobody can list is residue too, but only while it is not a
    // readable stored Session — that one is real and must survive.
    const orphanDir = (id) => !listed.has(id) && !isResident(id) && (dirs.get(id) ?? []).length > 0;

    const files = [];
    const logs = [];
    const caches = [];
    for (const record of manifest.deleted) {
      for (const entry of record.files ?? []) {
        if (typeof entry?.path !== 'string' || !path.isAbsolute(entry.path)) continue;
        let stat;
        try {
          stat = await fsp.lstat(entry.path);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (isInside(home, entry.path) || (record.root && !isInside(record.root, entry.path))) continue;
        if (entry.root && path.resolve(entry.path) === path.resolve(entry.root)) continue;
        files.push({
          path: entry.path,
          bytes: stat.size,
          mtime: stat.mtimeMs,
          recordedBytes: entry.bytes,
          sessionId: record.id,
          title: record.title ?? '',
          at: record.at ?? null,
          changed: !fileStampMatches(entry, stat),
        });
      }
      if (orphanDir(record.id)) {
        for (const dir of dirs.get(record.id) ?? []) {
          if (!isInside(sessionsRoot, dir)) continue;
          const stats = await dirStats(dir);
          logs.push({ path: dir, sessionId: record.id, bytes: stats.bytes });
        }
      }
    }

    // Structural leftovers: an id that no stored Session, live Session or log
    // directory owns can only be a stale index entry.
    let cacheEntries = [];
    try {
      cacheEntries = await fsp.readdir(cacheRoot, { withFileTypes: true });
    } catch {
      cacheEntries = [];
    }
    for (const entry of cacheEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      if (!gone(id)) continue;
      const file = path.join(cacheRoot, entry.name);
      let bytes = 0;
      try {
        bytes = (await fsp.stat(file)).size;
      } catch {
        continue;
      }
      caches.push({ path: file, sessionId: id, bytes });
    }
    const accounting = [];
    for (const [workspaceId, record] of Object.entries(workspaces)) {
      if (!record || !Array.isArray(record.sessionIds)) continue;
      for (const id of record.sessionIds) if (gone(id)) accounting.push({ workspaceId, sessionId: id });
    }
    const archivedLeft = archived.filter((id) => gone(id)).map((id) => ({ id }));

    const attachments = await attachmentPlan(new Set());
    const images = await requestImagesPlan();
    const totalBytes = files.reduce((sum, file) => sum + (file.changed ? 0 : file.bytes), 0)
      + (attachments.orphanBytes ?? 0)
      + images.bytes;

    return {
      ok: true,
      files,
      logs,
      caches,
      accounting,
      archived: archivedLeft,
      attachments: {
        objects: attachments.objects.length,
        bytes: attachments.totalBytes,
        orphanObjects: attachments.orphanObjects ?? null,
        orphanBytes: attachments.orphanBytes ?? null,
        blocked: attachments.blocked,
        failures: attachments.failures,
      },
      requestImages: { files: images.files.length, bytes: images.bytes },
      manifestRecords: manifest.deleted.length,
      totalBytes,
    };
  }

  /**
   * Remove the leftovers the caller selected, re-derived on the server so a
   * crafted request cannot reach anything the scan did not offer.
   * @param {object} options - `files` plus one boolean per category.
   * @returns {Promise<object>} per-category outcomes.
   */
  async function purgeLeftovers(options = {}) {
    const plan = await leftoverScan();
    const result = { ok: true, bytes: 0, files: undefined, logs: [], caches: [], accounting: [], archived: [], gc: undefined };

    if (Array.isArray(options.files) && options.files.length > 0) {
      const allowed = plan.files.filter((file) => !file.changed);
      result.files = await deleteArtifactFiles({ files: allowed, requested: options.files, home });
      result.bytes += result.files.bytes;
      // Drop what is gone so the next report does not list it again.
      try {
        const doc = await readManifest(home);
        const kept = [];
        for (const record of doc.deleted) {
          const files = [];
          for (const entry of record.files ?? []) {
            try {
              await fsp.access(entry.path);
              files.push(entry);
            } catch {
              /* removed */
            }
          }
          kept.push({ ...record, files });
        }
        await writeManifest(home, { ...doc, deleted: kept });
      } catch {
        /* the manifest is self-healing on the next delete */
      }
    }

    if (options.logs === true) {
      for (const entry of plan.logs) {
        try {
          await removeTree(entry.path);
          result.logs.push(entry.path);
          result.bytes += entry.bytes ?? 0;
        } catch (error) {
          result.ok = false;
          result.logs.push({ path: entry.path, error: formatError(error) });
        }
      }
    }

    if (options.caches === true) {
      for (const entry of plan.caches) {
        try {
          await fsp.rm(entry.path, { force: true });
          result.caches.push(entry.path);
          result.bytes += entry.bytes ?? 0;
        } catch (error) {
          result.ok = false;
          result.caches.push({ path: entry.path, error: formatError(error) });
        }
      }
    }

    if (options.accounting === true) {
      for (const entry of plan.accounting) {
        const owner = wsEntity(entry.workspaceId);
        if (!owner) continue;
        try {
          await owner.detachSession(entry.sessionId);
          result.accounting.push(entry);
        } catch (error) {
          result.ok = false;
        }
      }
    }

    if (options.archived === true) {
      for (const entry of plan.archived) {
        try {
          await workspaceRegistry.unarchiveSession(entry.id);
          result.archived.push(entry.id);
        } catch {
          result.ok = false;
        }
      }
    }

    if (options.attachments === true) {
      const sweep = await collectGarbage({ dryRun: false, requestImages: false });
      result.gc = sweep;
      result.bytes += sweep.removedBytes ?? 0;
      if (!sweep.ok) result.ok = false;
    }
    if (options.requestImages === true) {
      const images = await requestImagesPlan();
      const cleared = await removeFiles(images.files);
      await pruneEmptyDirs(requestImagesRoot);
      result.gc = { ...(result.gc ?? {}), requestImages: { removedFiles: cleared.removed, bytes: cleared.bytes, failures: cleared.failures } };
      result.bytes += cleared.bytes;
      if (cleared.failures.length > 0) result.ok = false;
    }

    return { ...result, plan: { files: plan.files.length, logs: plan.logs.length, caches: plan.caches.length } };
  }

  return { state, remove, finalizePending, collectGarbage, scanAll, leftoverScan, purgeLeftovers, sessionsRoot, cacheRoot };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { code: 'too-large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === req.headers.host;
  } catch {
    return false;
  }
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function apply(ctx) {
  const home = resolveHome();
  // The registry-wide archive-admission check: every owner of running work
  // answers here, exactly as it does for `archiveSession`.
  const activity = async (sessionId) => {
    if (typeof ctx.waterfall !== 'function') {
      throw new Error('当前 Host 不支持 workspace/session-activity 事件，无法判定会话是否仍在运行');
    }
    return ctx.waterfall('workspace/session-activity', { sessionId }, NO_ACTIVITY);
  };
  // The Schedule service is optional: a profile without the schedule plugin
  // must still be able to purge archived Sessions.
  const getSchedule = () => {
    try {
      return typeof ctx.get === 'function' ? ctx.get('schedule') : undefined;
    } catch {
      return undefined;
    }
  };
  const handlers = createHandlers({
    home,
    sessions: ctx.sessions,
    activity,
    workspaceRegistry: ctx.workspaceRegistry,
    sessionPersistence: ctx.sessionPersistence,
    getSchedule,
  });

  // A delete that ran against a resident Session leaves its bookkeeping behind
  // on purpose; once the process no longer holds that Session, finish it.
  void handlers.finalizePending().then((ids) => {
    if (ids.length > 0) ctx.logger?.info?.(`archived-purge: finalized ${ids.length} deleted session(s)`);
  }).catch((error) => {
    ctx.logger?.warn?.(`archived-purge: finalizing deleted sessions failed: ${formatError(error)}`);
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/state`,
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      try {
        send(res, 200, await handlers.state());
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/delete`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      const type = String(req.headers['content-type'] ?? '');
      if (!type.includes('application/json')) {
        send(res, 415, { ok: false, code: 'content-type-required' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        send(res, 400, {
          ok: false,
          code: error?.code === 'too-large' ? 'payload-too-large' : 'invalid-json',
          message: formatError(error),
        });
        return;
      }
      try {
        const result = await handlers.remove(payload?.sessionIds, {
          files: payload?.files,
          // One switch for the whole derived set; the Host still decides what
          // is eligible, so a crafted `everything` can never reach more.
          everything: payload?.everything === true,
          attachments: payload?.attachments === true,
          requestImages: payload?.requestImages === true,
        });
        // A well-formed request that removed nothing is a business outcome,
        // not a transport failure: 200 keeps `result.message` and
        // `result.results` readable instead of surfacing a bare "HTTP 400".
        send(res, 200, result);
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/scan`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      const type = String(req.headers['content-type'] ?? '');
      if (!type.includes('application/json')) {
        send(res, 415, { ok: false, code: 'content-type-required' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        send(res, 400, { ok: false, code: 'invalid-json', message: formatError(error) });
        return;
      }
      const ids = Array.isArray(payload?.sessionIds)
        ? payload.sessionIds.filter((id) => typeof id === 'string' && ID_RE.test(id))
        : [];
      try {
        send(res, 200, await handlers.scanAll(ids));
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/gc`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      const type = String(req.headers['content-type'] ?? '');
      if (!type.includes('application/json')) {
        send(res, 415, { ok: false, code: 'content-type-required' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        send(res, 400, { ok: false, code: 'invalid-json', message: formatError(error) });
        return;
      }
      try {
        // `dryRun` must be explicitly false to delete anything.
        send(res, 200, await handlers.collectGarbage({
          dryRun: payload?.dryRun !== false,
          requestImages: payload?.requestImages === true,
        }));
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/leftovers`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      try {
        send(res, 200, await handlers.leftoverScan());
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/purge-leftovers`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      const type = String(req.headers['content-type'] ?? '');
      if (!type.includes('application/json')) {
        send(res, 415, { ok: false, code: 'content-type-required' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch (error) {
        send(res, 400, { ok: false, code: 'invalid-json', message: formatError(error) });
        return;
      }
      try {
        send(res, 200, await handlers.purgeLeftovers({
          files: Array.isArray(payload?.files) ? payload.files : [],
          logs: payload?.logs === true,
          caches: payload?.caches === true,
          accounting: payload?.accounting === true,
          archived: payload?.archived === true,
          attachments: payload?.attachments === true,
          requestImages: payload?.requestImages === true,
        }));
      } catch (error) {
        send(res, 500, { ok: false, code: 'internal', message: formatError(error) });
      }
    },
  }));

  // Browser-side mount diagnostics: the Client half reports a failed apply here
  // so a future slot/API change leaves a readable trace instead of only a
  // generic "entry did not activate" dialog.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${ROUTE}/client-error`,
    async handler(req, res) {
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, code: 'method-not-allowed' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, code: 'foreign-origin' });
        return;
      }
      try {
        const payload = JSON.parse(await readBody(req));
        const line = [
          new Date().toISOString(),
          String(payload?.message ?? '').slice(0, 4000),
          String(payload?.stack ?? '').slice(0, 8000),
          '---',
          '',
        ].join('\n');
        await fsp.appendFile(path.join(home, 'archived-purge-client-errors.log'), line, 'utf8');
        send(res, 200, { ok: true });
      } catch (error) {
        send(res, 400, { ok: false, code: 'invalid-json', message: formatError(error) });
      }
    },
  }));
}
