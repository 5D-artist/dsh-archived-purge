/**
 * Client half of dsh-archived-purge.
 *
 * A Settings page that lists every archived Session grouped by workspace,
 * supports select-all and per-row selection, and permanently deletes the
 * selection (host: log directory + projection cache + workspace accounting +
 * archive set entry).
 */
window.__ModuleLoader__.load({
  id: 'dsh-archived-purge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'archived-purge';
    const ROUTE = '/plugins/archived-purge';

    const zh = {
      nav: '归档清理',
      title: '归档会话清理',
      subtitle: '永久删除已归档会话及其本地文件：会话日志、投影缓存、工作区记账与归档标记。删除后无法撤销。',
      selectAll: '全选',
      selected: '已选',
      total: '共',
      refresh: '刷新',
      delete: '删除所选',
      confirmTitle: '确认永久删除',
      confirmBody: '将删除以下会话的本地文件与归档记录，且无法恢复：',
      confirmDetail: '归档会话及其投影缓存、工作区记账、归档标记。',
      cancel: '取消',
      confirm: '永久删除',
      deleting: '正在删除…',
      empty: '没有已归档的会话',
      emptyHint: '归档后的会话会出现在这里，可在此统一清理。',
      size: '占用',
      lastActivity: '最后活动',
      missing: '日志缺失',
      live: '运行中',
      activeTurn: '对话运行中',
      activeJob: '后台任务运行中',
      activeSubagent: '子代理运行中',
      activeSchedule: '定时任务唤醒中',
      activityUnknown: '运行状态未知',
      ungrouped: '未归组会话',
      loadFailed: '读取归档列表失败',
      deleteFailed: '删除失败',
      retry: '重试',
      noticeDeleted: '已删除',
      noticeFreed: '释放',
      noticeFailed: '删除未完成',
      pendingFinalizeHint: '另有 {n} 个已删除会话的记账将在下次启动时自动回收',
      deferredSuffix: '（{n} 个的记账待重启后回收）',
      deepTitle: '深度清理（可选）',
      deepScanning: '正在扫描可清理内容…',
      deepBlocked: '无法扫描：{reason}',
      deepAttachments: '无人引用的附件',
      deepAttachmentsNote: '删除后释放 {size}（{n} 个对象）',
      deepAttachmentsNone: '没有会被释放的附件',
      deepRequestImages: '请求图缩放缓存',
      deepRequestImagesNote: '{size}，可重建',
      deepFiles: '该批会话写出的工作区文件',
      deepFilesNote: '共 {n} 个，已选 {m} 个',
      deepFilesEmpty: '没有可识别的产出文件（只识别 write / edit / present 的路径）',
      orphanGc: '清理孤儿附件',
      orphanGcNone: '没有可清理的孤儿附件',
      orphanGcFound: '发现 {n} 个孤儿附件（{size}），另可清空请求图缓存 {cache}',
      orphanGcConfirm: '确认清理',
      orphanGcDone: '已清理附件 {n} 个 · 释放 {size}',
      orphanGcFailed: '清理失败：{message}',
      noticeFiles: '文件 {n} 个 {size}',
      noticeAttachments: '附件 {n} 个 {size}',
      noticeCache: '图缓存 {size}',
      leftovers: '扫描历史残留',
      leftoversTitle: '历史残留',
      leftoversScanning: '正在扫描残留…',
      leftoversEmpty: '没有发现残留',
      leftoverFiles: '已删除会话产出的文件',
      leftoverLogs: '残留日志目录',
      leftoverCaches: '残留投影缓存行',
      leftoverAccounting: '失效的工作区记账',
      leftoverArchived: '失效的归档标记',
      leftoverAttachments: '无人引用的附件',
      leftoverCache: '请求图缓存',
      leftoverChanged: '（{n} 个已被改动，跳过）',
      leftoverFilesNote: '共 {n} 个，已选 {m} 个',
      leftoverPurge: '永久删除所选',
      leftoverDone: '已清理残留：释放 {size}',
      leftoverCount: '{n} 项',
      irreversible: '此操作不可撤销',
      countUnit: '个会话',
    };

    const en = {
      nav: 'Archive Cleanup',
      title: 'Archived session cleanup',
      subtitle: 'Permanently delete archived sessions and their local files: session log, projection cache, workspace accounting, and archive marker. This cannot be undone.',
      selectAll: 'Select all',
      selected: 'Selected',
      total: 'of',
      refresh: 'Refresh',
      delete: 'Delete selected',
      confirmTitle: 'Confirm permanent deletion',
      confirmBody: 'The local files and archive records of these sessions will be deleted and cannot be restored:',
      confirmDetail: 'archived sessions plus their projection cache, workspace accounting, and archive marker.',
      cancel: 'Cancel',
      confirm: 'Delete permanently',
      deleting: 'Deleting…',
      empty: 'No archived sessions',
      emptyHint: 'Archived sessions appear here and can be cleaned up in one place.',
      size: 'Size',
      lastActivity: 'Last activity',
      missing: 'Log missing',
      live: 'Running',
      activeTurn: 'Turn running',
      activeJob: 'Job running',
      activeSubagent: 'Subagent running',
      activeSchedule: 'Schedule waking',
      activityUnknown: 'Activity unknown',
      ungrouped: 'Ungrouped sessions',
      loadFailed: 'Failed to read archived sessions',
      deleteFailed: 'Deletion failed',
      retry: 'Retry',
      noticeDeleted: 'Deleted',
      noticeFreed: 'Freed',
      noticeFailed: 'Deletion not completed',
      pendingFinalizeHint: '{n} deleted Sessions still hold bookkeeping that clears on the next start',
      deferredSuffix: ' ({n} waiting for the next start)',
      deepTitle: 'Deep clean (optional)',
      deepScanning: 'Scanning reclaimable data…',
      deepBlocked: 'Cannot scan: {reason}',
      deepAttachments: 'Unreferenced attachments',
      deepAttachmentsNote: 'frees {size} ({n} objects) after this delete',
      deepAttachmentsNone: 'No attachment would be freed',
      deepRequestImages: 'Request-image cache',
      deepRequestImagesNote: '{size}, regenerable',
      deepFiles: 'Workspace files these Sessions wrote',
      deepFilesNote: '{n} found, {m} selected',
      deepFilesEmpty: 'No identifiable artifacts (only write / edit / present paths are detected)',
      orphanGc: 'Clean orphan attachments',
      orphanGcNone: 'No orphan attachments to clean',
      orphanGcFound: '{n} orphan attachments ({size}); the request-image cache ({cache}) can be cleared too',
      orphanGcConfirm: 'Clean them',
      orphanGcDone: 'Removed {n} attachments · freed {size}',
      orphanGcFailed: 'Cleanup failed: {message}',
      noticeFiles: '{n} files {size}',
      noticeAttachments: '{n} attachments {size}',
      noticeCache: 'image cache {size}',
      leftovers: 'Scan leftovers',
      leftoversTitle: 'Leftovers',
      leftoversScanning: 'Scanning leftovers…',
      leftoversEmpty: 'No leftovers found',
      leftoverFiles: 'Files produced by deleted Sessions',
      leftoverLogs: 'Orphan log directories',
      leftoverCaches: 'Orphan projection-cache rows',
      leftoverAccounting: 'Dangling workspace slots',
      leftoverArchived: 'Dangling archive markers',
      leftoverAttachments: 'Unreferenced attachments',
      leftoverCache: 'Request-image cache',
      leftoverChanged: ' ({n} changed since, skipped)',
      leftoverFilesNote: '{n} found, {m} selected',
      leftoverPurge: 'Delete selected permanently',
      leftoverDone: 'Leftovers cleared: freed {size}',
      leftoverCount: '{n} items',
      irreversible: 'This action cannot be undone',
      countUnit: 'sessions',
    };

    const CSS = `
      .ap-root { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
      .ap-head { display: flex; flex-direction: column; gap: 4px; }
      .ap-title { font-size: 15px; font-weight: 600; }
      .ap-sub { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
      .ap-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
        position: sticky; top: 0; z-index: 2; }
      .ap-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
      .ap-check input { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .ap-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ap-spacer { flex: 1; }
      .ap-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent;
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
      .ap-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .ap-btn:disabled { opacity: .45; cursor: not-allowed; }
      .ap-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .ap-danger:hover:not(:disabled) { background: color-mix(in oklab, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .ap-primary-danger { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-bg-base); }
      .ap-group { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
      .ap-grouphead { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
      .ap-grouptitle { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ap-row { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; border-top: 1px solid var(--dsw-alias-border-l1); }
      .ap-row:hover { background: var(--dsw-alias-bg-layer-1); }
      .ap-row input[type="checkbox"] { margin-top: 3px; width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .ap-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
      .ap-name { font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
      .ap-name.ap-unknown { color: var(--dsw-alias-label-secondary); font-style: italic; }
      .ap-tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .ap-tag { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .ap-tag.ap-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
      .ap-tag.ap-live { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
      .ap-notice { padding: 8px 12px; border-radius: 8px; font-size: 12px; line-height: 1.5;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .ap-notice.ap-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .ap-noticelist { margin: 6px 0 0; padding-left: 18px; max-height: 160px; overflow: auto; }
      .ap-deep { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px;
        display: flex; flex-direction: column; gap: 8px; }
      .ap-deeptitle { font-size: 12px; font-weight: 600; }
      .ap-deeprow { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; }
      .ap-deeprow input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .ap-filelist { max-height: 150px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
      .ap-file { display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; min-width: 0; }
      .ap-file input[type="checkbox"] { width: 13px; height: 13px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .ap-filename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-secondary); direction: rtl; text-align: left; }
      .ap-empty { padding: 36px 12px; text-align: center; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; }
      .ap-empty-title { font-size: 13px; margin-bottom: 4px; }
      .ap-empty-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ap-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
        background: color-mix(in oklab, var(--dsw-alias-label-primary) 42%, transparent); padding: 24px; }
      .ap-dialog { width: min(440px, 100%); background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 12px; padding: 18px; display: flex; flex-direction: column; gap: 12px; box-shadow: 0 18px 48px color-mix(in oklab, var(--dsw-alias-label-primary) 28%, transparent); }
      .ap-dialogtitle { font-size: 14px; font-weight: 600; }
      .ap-dialogbody { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
      .ap-dialoglist { font-size: 12px; line-height: 1.6; margin: 0; padding-left: 18px; max-height: 140px; overflow: auto; }
      .ap-actions { display: flex; justify-content: flex-end; gap: 8px; }
    `;

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unit = 0;
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
    }

    // Activity families reported by the Host's `workspace/session-activity`
    // waterfall; unknown families fall back to their raw name.
    const ACTIVITY_LABELS = {
      turn: 'activeTurn',
      job: 'activeJob',
      subagent: 'activeSubagent',
      schedule: 'activeSchedule',
    };

    function activityLabel(t, kind) {
      const key = ACTIVITY_LABELS[kind];
      return key ? t(key) : String(kind ?? '');
    }

    async function request(path, init) {
      const response = await fetch(ROUTE + path, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...init,
      });
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const error = new Error(payload?.message || `HTTP ${response.status}`);
        error.payload = payload;
        error.status = response.status;
        throw error;
      }
      return payload;
    }

    function createPanel(ctx, t) {
      return function ArchivedPurgePanel() {
        const [loading, setLoading] = useState(true);
        const [data, setData] = useState(null);
        const [error, setError] = useState('');
        const [notice, setNotice] = useState(null);
        const [selected, setSelected] = useState(() => new Set());
        const [confirming, setConfirming] = useState(false);
        const [busy, setBusy] = useState(false);
        const [scan, setScan] = useState(null);
        const [deep, setDeep] = useState({ attachments: true, requestImages: false, files: new Set() });
        const [gc, setGc] = useState(null);
        const [leftovers, setLeftovers] = useState(null);
        const [leftoverSel, setLeftoverSel] = useState(null);
        const masterRef = useRef(null);

        const load = useCallback(async () => {
          setLoading(true);
          setError('');
          try {
            const next = await request('/state');
            setData(next);
            setSelected((current) => {
              const alive = new Set(next.items.map((item) => item.id));
              const kept = new Set();
              for (const id of current) if (alive.has(id)) kept.add(id);
              return kept;
            });
          } catch (cause) {
            setError(cause?.message || t('loadFailed'));
          } finally {
            setLoading(false);
          }
        }, [t]);

        useEffect(() => {
          load();
        }, [load]);

        const items = data?.items ?? [];
        const groups = useMemo(() => {
          const map = new Map();
          for (const item of items) {
            const key = item.workspaceId || '__none__';
            const group = map.get(key) ?? {
              key,
              title: item.workspaceTitle || t('ungrouped'),
              path: item.workspacePath || '',
              items: [],
            };
            group.items.push(item);
            map.set(key, group);
          }
          return [...map.values()];
        }, [items, t]);

        const total = items.length;
        const selectedCount = selected.size;
        const selectedBytes = useMemo(
          () => items.reduce((sum, item) => (selected.has(item.id) ? sum + item.sizeBytes : sum), 0),
          [items, selected],
        );
        const allSelected = total > 0 && selectedCount === total;
        const someSelected = selectedCount > 0 && !allSelected;

        useEffect(() => {
          if (masterRef.current) masterRef.current.indeterminate = someSelected;
        }, [someSelected]);

        const toggle = (id) => {
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
          setNotice(null);
        };

        const toggleAll = () => {
          setSelected(() => (allSelected ? new Set() : new Set(items.map((item) => item.id))));
          setNotice(null);
        };

        const closeConfirm = useCallback(() => setConfirming(false), []);

        const startScan = useCallback(async (ids) => {
          setScan({ loading: true, data: null, error: '' });
          setDeep({ attachments: true, requestImages: false, files: new Set() });
          try {
            const next = await request('/scan', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionIds: ids }),
            });
            setScan({ loading: false, data: next, error: '' });
          } catch (cause) {
            setScan({
              loading: false,
              data: null,
              error: cause?.payload?.message || cause?.message || t('deleteFailed'),
            });
          }
        }, [t]);

        const openConfirm = () => {
          setConfirming(true);
          setNotice(null);
          startScan([...selected]);
        };

        const toggleDeepFile = (filePath) => {
          setDeep((current) => {
            const files = new Set(current.files);
            if (files.has(filePath)) files.delete(filePath);
            else files.add(filePath);
            return { ...current, files };
          });
        };

        const runGcDryRun = async () => {
          setNotice(null);
          setGc({ busy: true, pending: null });
          try {
            const result = await request('/gc', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            });
            if (!result?.ok) {
              setNotice({ kind: 'error', text: `${t('orphanGcFailed').replace('{message}', result?.message || result?.code || '')}` });
              setGc(null);
              return;
            }
            if ((result.orphanObjects ?? 0) === 0) {
              setNotice({ kind: 'ok', text: t('orphanGcNone') });
              setGc(null);
              return;
            }
            setGc({ busy: false, pending: result });
          } catch (cause) {
            setGc(null);
            setNotice({ kind: 'error', text: t('orphanGcFailed').replace('{message}', cause?.message || '') });
          }
        };

        const runGc = async () => {
          setGc({ busy: true, pending: null });
          try {
            const result = await request('/gc', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dryRun: false, requestImages: true }),
            });
            if (!result?.ok) {
              setNotice({ kind: 'error', text: t('orphanGcFailed').replace('{message}', result?.message || result?.code || '') });
            } else {
              const cache = result.requestImages?.bytes ?? 0;
              setNotice({
                kind: 'ok',
                text: t('orphanGcDone')
                  .replace('{n}', String(result.removedObjects ?? 0))
                  .replace('{size}', formatBytes((result.removedBytes ?? 0) + cache)),
              });
            }
            setGc(null);
            await load();
          } catch (cause) {
            setGc(null);
            setNotice({ kind: 'error', text: t('orphanGcFailed').replace('{message}', cause?.message || '') });
          }
        };

        const scanLeftovers = async () => {
          setNotice(null);
          setGc(null);
          setLeftovers({ busy: true, plan: null });
          setLeftoverSel(null);
          try {
            const plan = await request('/leftovers', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            });
            const selectable = plan.files.filter((file) => !file.changed).map((file) => file.path);
            const empty = plan.files.length === 0
              && plan.logs.length === 0
              && plan.caches.length === 0
              && plan.accounting.length === 0
              && plan.archived.length === 0
              && (plan.attachments?.orphanObjects ?? 0) === 0
              && (plan.requestImages?.files ?? 0) === 0;
            if (empty) {
              setLeftovers(null);
              setLeftoverSel(null);
              setNotice({ kind: 'ok', text: t('leftoversEmpty') });
              return;
            }
            setLeftovers({ busy: false, plan });
            setLeftoverSel({
              files: new Set(selectable),
              logs: plan.logs.length > 0,
              caches: plan.caches.length > 0,
              accounting: plan.accounting.length > 0,
              archived: plan.archived.length > 0,
              attachments: (plan.attachments?.orphanObjects ?? 0) > 0,
              requestImages: (plan.requestImages?.files ?? 0) > 0,
            });
          } catch (cause) {
            setLeftovers(null);
            setLeftoverSel(null);
            setNotice({ kind: 'error', text: `${t('deleteFailed')}：${cause?.payload?.message || cause?.message || ''}` });
          }
        };

        const toggleLeftoverFile = (filePath) => {
          setLeftoverSel((current) => {
            if (!current) return current;
            const files = new Set(current.files);
            if (files.has(filePath)) files.delete(filePath);
            else files.add(filePath);
            return { ...current, files };
          });
        };

        const setLeftoverFlag = (key, value) => {
          setLeftoverSel((current) => (current ? { ...current, [key]: value } : current));
        };

        const runLeftoverPurge = async () => {
          if (!leftoverSel) return;
          setLeftovers((current) => ({ busy: true, plan: current?.plan ?? null }));
          try {
            const result = await request('/purge-leftovers', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                files: [...leftoverSel.files],
                logs: leftoverSel.logs,
                caches: leftoverSel.caches,
                accounting: leftoverSel.accounting,
                archived: leftoverSel.archived,
                attachments: leftoverSel.attachments,
                requestImages: leftoverSel.requestImages,
              }),
            });
            setNotice({
              kind: result?.ok === false ? 'error' : 'ok',
              text: result?.ok === false
                ? `${t('deleteFailed')}：${result?.message || ''}`
                : t('leftoverDone').replace('{size}', formatBytes(result?.bytes ?? 0)),
            });
            setLeftovers(null);
            setLeftoverSel(null);
            await load();
          } catch (cause) {
            setLeftovers(null);
            setLeftoverSel(null);
            setNotice({ kind: 'error', text: `${t('deleteFailed')}：${cause?.payload?.message || cause?.message || ''}` });
          }
        };

        useEffect(() => {
          if (!confirming) return undefined;
          const onKey = (event) => {
            if (event.key === 'Escape') closeConfirm();
          };
          window.addEventListener('keydown', onKey);
          return () => window.removeEventListener('keydown', onKey);
        }, [confirming, closeConfirm]);

        const describeFailure = (payload) => {
          const titleOf = (id) => items.find((entry) => entry.id === id)?.title || id;
          const lines = [];
          if (Array.isArray(payload?.active)) {
            for (const entry of payload.active) {
              const labels = (entry.kinds ?? []).map((kind) => activityLabel(t, kind)).join('、');
              lines.push(`${titleOf(entry.id)} — ${labels || t('live')}`);
            }
          }
          if (Array.isArray(payload?.results)) {
            for (const entry of payload.results) {
              if (!entry || entry.ok) continue;
              const labels = (entry.activity ?? []).map((kind) => activityLabel(t, kind)).join('、');
              const reason = entry.code === 'session-active'
                ? labels || t('live')
                : entry.message || entry.code || t('deleteFailed');
              lines.push(`${titleOf(entry.id)} — ${reason}`);
            }
          }
          return lines.slice(0, 8);
        };

        const runDelete = async () => {
          const ids = [...selected];
          const files = [...deep.files];
          const attachments = deep.attachments === true;
          const requestImages = deep.requestImages === true;
          setConfirming(false);
          setBusy(true);
          setNotice(null);
          try {
            const result = await request('/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionIds: ids, files, attachments, requestImages }),
            });
            // The Host answers 200 for every well-formed request, including one
            // that removed nothing; `ok` and `message` carry the outcome.
            if (result?.ok) {
              const deferred = result.deferred?.length ?? 0;
              let text = `${t('noticeDeleted')} ${result.deleted ?? ids.length} ${t('countUnit')} · ${t('noticeFreed')} ${formatBytes(result.removedBytes)}`
                + (deferred > 0 ? t('deferredSuffix').replace('{n}', String(deferred)) : '');
              if (result.artifacts?.deleted > 0) {
                text += ` · ${t('noticeFiles').replace('{n}', String(result.artifacts.deleted)).replace('{size}', formatBytes(result.artifacts.bytes))}`;
              }
              if (result.gc?.removedObjects > 0) {
                text += ` · ${t('noticeAttachments').replace('{n}', String(result.gc.removedObjects)).replace('{size}', formatBytes(result.gc.removedBytes))}`;
              }
              if (result.gc?.requestImages?.removedFiles > 0) {
                text += ` · ${t('noticeCache').replace('{size}', formatBytes(result.gc.requestImages.bytes))}`;
              }
              const details = [];
              if (Array.isArray(result.artifacts?.results)) {
                for (const entry of result.artifacts.results) {
                  if (entry?.ok) continue;
                  details.push(`${entry.path} — ${entry.code || entry.message || t('deleteFailed')}`);
                }
              }
              if (result.gc?.blocked) details.push(`${t('deepAttachments')} — ${result.gc.message || result.gc.blocked}`);
              setNotice({ kind: 'ok', text, details });
              setSelected(new Set());
            } else {
              const details = describeFailure(result);
              setNotice({
                kind: 'error',
                text: `${t('noticeFailed')}：${result?.message || t('deleteFailed')}`,
                details,
              });
            }
            await load();
          } catch (cause) {
            const payload = cause?.payload;
            const details = describeFailure(payload);
            setNotice({
              kind: 'error',
              text: `${t('deleteFailed')}：${payload?.message || cause?.message || ''}`,
              details,
            });
          } finally {
            setBusy(false);
          }
        };

        const checkbox = (checked, onChange, label) => h('input', {
          type: 'checkbox',
          checked,
          onChange,
          'aria-label': label,
        });

        const leftoverPlan = leftovers?.plan ?? null;
        const leftoverChanged = leftoverPlan ? leftoverPlan.files.filter((file) => file.changed).length : 0;
        const leftoverFree = (() => {
          if (!leftoverPlan || !leftoverSel) return 0;
          let total = 0;
          for (const file of leftoverPlan.files) {
            if (!file.changed && leftoverSel.files.has(file.path)) total += file.bytes;
          }
          if (leftoverSel.logs) total += leftoverPlan.logs.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
          if (leftoverSel.caches) total += leftoverPlan.caches.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
          if (leftoverSel.attachments) total += leftoverPlan.attachments?.orphanBytes ?? 0;
          if (leftoverSel.requestImages) total += leftoverPlan.requestImages?.bytes ?? 0;
          return total;
        })();

        const leftoverRow = (key, label, count, bytes) => h('label', { className: 'ap-deeprow', key },
          h('input', {
            type: 'checkbox',
            checked: Boolean(leftoverSel?.[key]),
            disabled: count === 0,
            onChange: (event) => setLeftoverFlag(key, event.target.checked),
          }),
          h('span', null, label),
          h('span', { className: 'ap-meta' }, count === 0 ? '—' : `${count}${bytes ? ` · ${formatBytes(bytes)}` : ''}`),
        );

        return h('div', { className: 'ap-root' },
          h('style', null, CSS),
          h('div', { className: 'ap-head' },
            h('div', { className: 'ap-title' }, t('title')),
            h('div', { className: 'ap-sub' }, t('subtitle')),
          ),
          h('div', { className: 'ap-bar' },
            h('label', { className: 'ap-check' },
              h('input', {
                ref: masterRef,
                type: 'checkbox',
                checked: allSelected,
                onChange: toggleAll,
                disabled: total === 0 || busy,
                'aria-label': t('selectAll'),
              }),
              t('selectAll'),
            ),
            h('span', { className: 'ap-meta' },
              `${t('selected')} ${selectedCount} / ${total}${selectedCount > 0 ? ` · ${formatBytes(selectedBytes)}` : ''}`,
            ),
            h('span', { className: 'ap-spacer' }),
            h('button', {
              type: 'button',
              className: 'ap-btn',
              onClick: scanLeftovers,
              disabled: loading || busy || leftovers?.busy === true,
            }, t('leftovers')),
            h('button', {
              type: 'button',
              className: 'ap-btn',
              onClick: runGcDryRun,
              disabled: loading || busy || gc?.busy === true,
            }, t('orphanGc')),
            h('button', {
              type: 'button',
              className: 'ap-btn',
              onClick: load,
              disabled: loading || busy,
            }, t('refresh')),
            h('button', {
              type: 'button',
              className: 'ap-btn ap-danger',
              onClick: openConfirm,
              disabled: selectedCount === 0 || busy,
            }, busy ? t('deleting') : t('delete')),
          ),
          error
            ? h('div', { className: 'ap-notice ap-error' }, `${t('loadFailed')}：${error}`)
            : null,
          gc?.pending
            ? h('div', { className: 'ap-notice' },
              h('div', null, t('orphanGcFound')
                .replace('{n}', String(gc.pending.orphanObjects ?? 0))
                .replace('{size}', formatBytes(gc.pending.orphanBytes ?? 0))
                .replace('{cache}', formatBytes(gc.pending.requestImages?.bytes ?? 0))),
              h('div', { className: 'ap-actions' },
                h('button', { type: 'button', className: 'ap-btn', onClick: () => setGc(null) }, t('cancel')),
                h('button', { type: 'button', className: 'ap-btn ap-danger', onClick: runGc }, t('orphanGcConfirm')),
              ),
            )
            : null,
          notice
            ? h('div', { className: notice.kind === 'error' ? 'ap-notice ap-error' : 'ap-notice' },
              h('div', null, notice.text),
              Array.isArray(notice.details) && notice.details.length > 0
                ? h('ul', { className: 'ap-noticelist' }, notice.details.map((line, index) => h('li', { key: index }, line)))
                : null,
            )
            : null,
          leftovers?.busy
            ? h('div', { className: 'ap-notice' }, t('leftoversScanning'))
            : leftoverPlan && leftoverSel
              ? h('div', { className: 'ap-notice ap-deep' },
                h('div', { className: 'ap-deeptitle' }, t('leftoversTitle')),
                leftoverRow('files', t('leftoverFiles'), leftoverPlan.files.length,
                  leftoverPlan.files.filter((file) => !file.changed).reduce((sum, file) => sum + file.bytes, 0)),
                leftoverChanged > 0
                  ? h('div', { className: 'ap-meta' }, t('leftoverChanged').replace('{n}', String(leftoverChanged)))
                  : null,
                leftoverPlan.files.length > 0
                  ? h('div', { className: 'ap-filelist' },
                    leftoverPlan.files.slice(0, 60).map((file) => h('label', { className: 'ap-file', key: file.path },
                      h('input', {
                        type: 'checkbox',
                        checked: leftoverSel.files.has(file.path),
                        disabled: file.changed,
                        onChange: () => toggleLeftoverFile(file.path),
                      }),
                      h('span', { className: 'ap-filename', title: file.path }, file.path),
                      h('span', { className: 'ap-meta' }, file.changed ? t('leftoverChanged').replace('{n}', '1') : formatBytes(file.bytes)),
                    )),
                  )
                  : null,
                leftoverRow('logs', t('leftoverLogs'), leftoverPlan.logs.length,
                  leftoverPlan.logs.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)),
                leftoverRow('caches', t('leftoverCaches'), leftoverPlan.caches.length,
                  leftoverPlan.caches.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0)),
                leftoverRow('accounting', t('leftoverAccounting'), leftoverPlan.accounting.length, 0),
                leftoverRow('archived', t('leftoverArchived'), leftoverPlan.archived.length, 0),
                leftoverRow('attachments', t('leftoverAttachments'), leftoverPlan.attachments?.orphanObjects ?? 0,
                  leftoverPlan.attachments?.orphanBytes ?? 0),
                leftoverRow('requestImages', t('leftoverCache'), leftoverPlan.requestImages?.files ?? 0,
                  leftoverPlan.requestImages?.bytes ?? 0),
                h('div', { className: 'ap-actions' },
                  h('span', { className: 'ap-meta ap-spacer' }, `${t('noticeFreed')} ${formatBytes(leftoverFree)}`),
                  h('button', {
                    type: 'button',
                    className: 'ap-btn',
                    onClick: () => { setLeftovers(null); setLeftoverSel(null); },
                  }, t('cancel')),
                  h('button', { type: 'button', className: 'ap-btn ap-primary-danger', onClick: runLeftoverPurge }, t('leftoverPurge')),
                ),
              )
              : null,
          (data?.pendingFinalize ?? 0) > 0
            ? h('div', { className: 'ap-meta' }, t('pendingFinalizeHint').replace('{n}', String(data.pendingFinalize)))
            : null,
          loading
            ? h('div', { className: 'ap-meta' }, '…')
            : items.length === 0
              ? h('div', { className: 'ap-empty' },
                h('div', { className: 'ap-empty-title' }, t('empty')),
                h('div', { className: 'ap-empty-hint' }, t('emptyHint')),
              )
              : groups.map((group) => h('div', { className: 'ap-group', key: group.key },
                h('div', { className: 'ap-grouphead' },
                  h('span', { className: 'ap-grouptitle' }, group.title),
                  h('span', null, `${group.items.length} ${t('countUnit')}`),
                ),
                group.items.map((item) => h('div', { className: 'ap-row', key: item.id },
                  checkbox(selected.has(item.id), () => toggle(item.id), item.title || item.id),
                  h('div', { className: 'ap-body' },
                    h('div', { className: 'ap-name' + (item.title ? '' : ' ap-unknown') }, item.title || item.id),
                    h('div', { className: 'ap-tags' },
                      item.lastActivity
                        ? h('span', { className: 'ap-meta' }, `${t('lastActivity')} ${new Date(item.lastActivity).toLocaleString()}`)
                        : null,
                      h('span', { className: 'ap-meta' }, `${t('size')} ${formatBytes(item.sizeBytes)}`),
                      item.exists ? null : h('span', { className: 'ap-tag ap-warn' }, t('missing')),
                      item.active
                        ? h('span', { className: 'ap-tag ap-live' }, activityLabel(t, item.activity?.[0]) || t('live'))
                        : null,
                      item.active ? null : item.activityUnknown
                        ? h('span', { className: 'ap-tag ap-warn' }, t('activityUnknown'))
                        : null,
                    ),
                  ),
                )),
              )),
          confirming
            ? h('div', {
              className: 'ap-overlay',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget) closeConfirm();
              },
            }, h('div', {
              className: 'ap-dialog',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-labelledby': 'ap-confirm-title',
            },
            h('div', { className: 'ap-dialogtitle', id: 'ap-confirm-title' }, t('confirmTitle')),
            h('div', { className: 'ap-dialogbody' }, t('confirmBody')),
            h('ul', { className: 'ap-dialoglist' },
              h('li', null, `${selectedCount} ${t('countUnit')} · ${formatBytes(selectedBytes)}`),
              h('li', null, t('confirmDetail')),
              h('li', null, t('irreversible')),
            ),
            h('div', { className: 'ap-deep' },
              h('div', { className: 'ap-deeptitle' }, t('deepTitle')),
              scan?.loading
                ? h('div', { className: 'ap-meta' }, t('deepScanning'))
                : scan?.error
                  ? h('div', { className: 'ap-meta' }, t('deepBlocked').replace('{reason}', scan.error))
                  : scan?.data
                    ? [
                      h('div', { className: 'ap-deeprow', key: 'attachments' },
                        h('input', {
                          type: 'checkbox',
                          checked: deep.attachments,
                          disabled: (scan.data.attachments.orphanObjects ?? 0) === 0,
                          onChange: (event) => setDeep((current) => ({ ...current, attachments: event.target.checked })),
                        }),
                        h('span', null, t('deepAttachments')),
                        h('span', { className: 'ap-meta' },
                          scan.data.attachments.blocked
                            ? t('deepBlocked').replace('{reason}', scan.data.attachments.blocked)
                            : (scan.data.attachments.orphanObjects ?? 0) === 0
                              ? t('deepAttachmentsNone')
                              : t('deepAttachmentsNote')
                                .replace('{size}', formatBytes(scan.data.attachments.orphanBytes ?? 0))
                                .replace('{n}', String(scan.data.attachments.orphanObjects ?? 0))),
                      ),
                      h('div', { className: 'ap-deeprow', key: 'cache' },
                        h('input', {
                          type: 'checkbox',
                          checked: deep.requestImages,
                          disabled: (scan.data.requestImages?.files ?? 0) === 0,
                          onChange: (event) => setDeep((current) => ({ ...current, requestImages: event.target.checked })),
                        }),
                        h('span', null, t('deepRequestImages')),
                        h('span', { className: 'ap-meta' },
                          t('deepRequestImagesNote').replace('{size}', formatBytes(scan.data.requestImages?.bytes ?? 0))),
                      ),
                      h('div', { key: 'files' },
                        h('div', { className: 'ap-deeprow' },
                          h('span', null, t('deepFiles')),
                          h('span', { className: 'ap-meta' },
                            t('deepFilesNote')
                              .replace('{n}', String(scan.data.artifacts.length))
                              .replace('{m}', String(deep.files.size))),
                        ),
                        scan.data.artifacts.length === 0
                          ? h('div', { className: 'ap-meta' }, t('deepFilesEmpty'))
                          : h('div', { className: 'ap-filelist' },
                            scan.data.artifacts.slice(0, 60).map((file) => h('label', { className: 'ap-file', key: file.path },
                              h('input', {
                                type: 'checkbox',
                                checked: deep.files.has(file.path),
                                onChange: () => toggleDeepFile(file.path),
                              }),
                              h('span', { className: 'ap-filename', title: file.path }, file.path),
                              h('span', { className: 'ap-meta' }, formatBytes(file.bytes)),
                            )),
                          ),
                      ),
                    ]
                    : null,
            ),
            h('div', { className: 'ap-actions' },
              h('button', { type: 'button', className: 'ap-btn', onClick: closeConfirm }, t('cancel')),
              h('button', {
                type: 'button',
                className: 'ap-btn ap-primary-danger',
                onClick: runDelete,
                autoFocus: true,
              }, t('confirm')),
            ),
            ))
            : null,
        );
      };
    }

    function reportMountError(error) {
      try {
        console.error('[dsh-archived-purge] client mount failed', error);
      } catch {
        /* console unavailable */
      }
      try {
        fetch(ROUTE + '/client-error', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: String(error?.message ?? error),
            stack: String(error?.stack ?? ''),
          }),
        }).catch(() => {});
      } catch {
        /* reporting is best-effort */
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'archived-purge: dictionaries');
          const t = ctx.locale.bind(NS);
          const Panel = createPanel(ctx, t);
          // `settings.section` is declared by the settings shell entry, which may
          // activate after this plugin. Registering straight away throws inside
          // SlotCore ("slot ... is not declared") and fails the whole web boot, so
          // wait for the declaration and re-register whenever it returns.
          ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'archived-purge',
            order: 25,
            label: () => t('nav'),
            locale: NS,
          }, Panel)), 'archived-purge: settings section');
        } catch (error) {
          reportMountError(error);
        }
      },
    };
  },
});
