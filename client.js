/**
 * Client half of dsh-archived-purge.
 *
 * A Settings page that lists every archived Session grouped by workspace,
 * supports select-all / per-group / per-row selection, and permanently deletes
 * the selection. The confirmation dialog derives a one-click "everything"
 * scope on the Host (log + projection cache + bookkeeping + archive marker,
 * the files the Session wrote, attachments only it referenced, and scheduled
 * tasks aimed at it) while still letting the user untick individual files.
 */
window.__ModuleLoader__.load({
  id: 'dsh-archived-purge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'archived-purge';
    const ROUTE = '/plugins/archived-purge';
    const MAX_VISIBLE_FILES = 60;

    const zh = {
      nav: '归档清理',
      title: '归档会话清理',
      subtitle: '永久删除已归档会话及其本地资料。删除后无法撤销，也不会影响仍在使用的会话。',
      statSessions: '归档会话',
      statSize: '占用空间',
      statActive: '运行中',
      statSelected: '已选',
      selectAll: '全选',
      selected: '已选',
      total: '共',
      countUnit: '个会话',
      filesUnit: '个文件',
      refresh: '刷新',
      delete: '删除所选',
      deleting: '正在删除…',
      confirmTitle: '永久删除会话',
      confirmBody: '将删除 {n} 个会话及其资料，此操作无法撤销：',
      scopeTitle: '清理范围',
      scopeSession: '会话日志、投影缓存与归档记录',
      scopeFiles: '该批会话写出的工作区文件',
      scopeAttachments: '仅被这些会话引用的附件',
      scopeSchedules: '指向这些会话的定时任务',
      scopeImages: '请求图缩放缓存（可重建）',
      scopeImagesNote: '{size} · 清空后按需重建',
      scopeEmpty: '无',
      showFiles: '查看文件',
      hideFiles: '收起',
      estimate: '预计释放',
      scanning: '正在扫描可清理内容…',
      scanFailed: '无法扫描：{reason}',
      filesNone: '没有可识别的产出文件（只识别 write / edit / present 的路径）',
      cancel: '取消',
      confirm: '永久删除',
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
      scheduleTag: '{n} 个定时任务',
      ungrouped: '未归组会话',
      groupSelect: '全选本组',
      groupClear: '取消本组',
      loadFailed: '读取归档列表失败',
      deleteFailed: '删除失败',
      retry: '重试',
      noticeDeleted: '已删除',
      noticeFreed: '释放',
      noticeFailed: '删除未完成',
      noticeFiles: '文件 {n} 个 {size}',
      noticeAttachments: '附件 {n} 个 {size}',
      noticeSchedules: '定时任务 {n} 个',
      noticeCache: '图缓存 {size}',
      pendingFinalizeHint: '另有 {n} 个已删除会话的记账将在下次启动时自动回收',
      deferredSuffix: '（{n} 个的记账待重启后回收）',
      orphanGc: '清理孤儿附件',
      orphanGcNone: '没有可清理的孤儿附件',
      orphanGcFound: '发现 {n} 个孤儿附件（{size}），另可清空请求图缓存 {cache}',
      orphanGcConfirm: '确认清理',
      orphanGcDone: '已清理附件 {n} 个 · 释放 {size}',
      orphanGcFailed: '清理失败：{message}',
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
      deepAttachments: '附件',
      deepBlocked: '无法扫描：{reason}',
      details: '原因',
    };

    const en = {
      nav: 'Archive Cleanup',
      title: 'Archived session cleanup',
      subtitle: 'Permanently delete archived sessions and what they produced on disk. This cannot be undone and never touches sessions still in use.',
      statSessions: 'Archived',
      statSize: 'On disk',
      statActive: 'Running',
      statSelected: 'Selected',
      selectAll: 'Select all',
      selected: 'Selected',
      total: 'of',
      countUnit: 'sessions',
      filesUnit: 'files',
      refresh: 'Refresh',
      delete: 'Delete selected',
      deleting: 'Deleting…',
      confirmTitle: 'Permanently delete sessions',
      confirmBody: '{n} sessions and their materials will be deleted. This cannot be undone:',
      scopeTitle: 'Scope',
      scopeSession: 'Session log, projection cache and archive record',
      scopeFiles: 'Workspace files these sessions wrote',
      scopeAttachments: 'Attachments only these sessions reference',
      scopeSchedules: 'Scheduled tasks aimed at these sessions',
      scopeImages: 'Request-image cache (regenerable)',
      scopeImagesNote: '{size} · rebuilt on demand',
      scopeEmpty: 'none',
      showFiles: 'Show files',
      hideFiles: 'Hide',
      estimate: 'Frees about',
      scanning: 'Scanning reclaimable data…',
      scanFailed: 'Cannot scan: {reason}',
      filesNone: 'No identifiable artifacts (only write / edit / present paths are detected)',
      cancel: 'Cancel',
      confirm: 'Delete permanently',
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
      scheduleTag: '{n} scheduled task(s)',
      ungrouped: 'Ungrouped sessions',
      groupSelect: 'Select group',
      groupClear: 'Clear group',
      loadFailed: 'Failed to read archived sessions',
      deleteFailed: 'Deletion failed',
      retry: 'Retry',
      noticeDeleted: 'Deleted',
      noticeFreed: 'Freed',
      noticeFailed: 'Deletion not completed',
      noticeFiles: '{n} files {size}',
      noticeAttachments: '{n} attachments {size}',
      noticeSchedules: '{n} scheduled tasks',
      noticeCache: 'image cache {size}',
      pendingFinalizeHint: '{n} deleted Sessions still hold bookkeeping that clears on the next start',
      deferredSuffix: ' ({n} waiting for the next start)',
      orphanGc: 'Clean orphan attachments',
      orphanGcNone: 'No orphan attachments to clean',
      orphanGcFound: '{n} orphan attachments ({size}); the request-image cache ({cache}) can be cleared too',
      orphanGcConfirm: 'Clean them',
      orphanGcDone: 'Removed {n} attachments · freed {size}',
      orphanGcFailed: 'Cleanup failed: {message}',
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
      deepAttachments: 'Attachments',
      deepBlocked: 'Cannot scan: {reason}',
      details: 'Reasons',
    };

    const CSS = `
      .ap-root { display: flex; flex-direction: column; gap: 14px; color: var(--dsw-alias-label-primary); }
      .ap-hero { display: flex; flex-direction: column; gap: 12px; padding: 16px 18px;
        border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px;
        background: linear-gradient(135deg, color-mix(in oklab, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-1)), var(--dsw-alias-bg-layer-1) 62%); }
      .ap-title { font-size: 17px; font-weight: 650; letter-spacing: .01em; }
      .ap-sub { font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); max-width: 72ch; }
      .ap-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; }
      .ap-stat { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px;
        background: color-mix(in oklab, var(--dsw-alias-bg-base) 62%, transparent);
        border: 1px solid var(--dsw-alias-border-l1); }
      .ap-statvalue { font-size: 15px; font-weight: 620; font-variant-numeric: tabular-nums; }
      .ap-statlabel { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .ap-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 8px 10px;
        background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
        position: sticky; top: 0; z-index: 2; }
      .ap-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; user-select: none; }
      .ap-check input, .ap-row input[type="checkbox"], .ap-deeprow input[type="checkbox"], .ap-file input[type="checkbox"] {
        width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
      .ap-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .ap-spacer { flex: 1; }
      .ap-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent;
        color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 8px; cursor: pointer;
        transition: background-color .12s ease, border-color .12s ease, opacity .12s ease; }
      .ap-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .ap-btn:disabled { opacity: .45; cursor: not-allowed; }
      .ap-btn:focus-visible, .ap-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .ap-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .ap-danger:hover:not(:disabled) { background: color-mix(in oklab, var(--dsw-alias-state-error-primary) 12%, transparent); }
      .ap-primary-danger { background: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-bg-base); font-weight: 600; }
      .ap-primary-danger:hover:not(:disabled) { filter: brightness(1.06); }
      .ap-link { appearance: none; border: 0; background: transparent; color: var(--dsw-alias-brand-primary);
        font: inherit; font-size: 11.5px; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
      .ap-link:hover { background: color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent); }
      .ap-group { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; overflow: hidden;
        background: var(--dsw-alias-bg-base); }
      .ap-grouphead { display: flex; align-items: center; gap: 8px; padding: 8px 12px; font-size: 12px;
        background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
      .ap-grouptitle { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .ap-grouppath { font-size: 11px; color: var(--dsw-alias-label-secondary); direction: rtl;
        max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ap-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; cursor: pointer;
        border-top: 1px solid var(--dsw-alias-border-l1); transition: background-color .12s ease; }
      .ap-row:hover { background: var(--dsw-alias-bg-layer-1); }
      .ap-row input[type="checkbox"] { margin-top: 3px; flex: none; }
      .ap-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
      .ap-name { font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
      .ap-name.ap-unknown { color: var(--dsw-alias-label-secondary); font-style: italic; }
      .ap-tags { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .ap-tag { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary); }
      .ap-tag.ap-warn { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
      .ap-tag.ap-live { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
      .ap-tag.ap-schedule { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .ap-notice { padding: 9px 12px; border-radius: 10px; font-size: 12px; line-height: 1.55;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
      .ap-notice.ap-error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .ap-noticelist { margin: 6px 0 0; padding-left: 18px; max-height: 160px; overflow: auto; }
      .ap-deep { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 10px 12px;
        display: flex; flex-direction: column; gap: 8px; background: var(--dsw-alias-bg-layer-1); }
      .ap-deeptitle { font-size: 12px; font-weight: 600; }
      .ap-scopehead { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
        color: var(--dsw-alias-label-secondary); }
      .ap-deeprow { display: flex; align-items: center; gap: 8px; font-size: 12px; flex-wrap: wrap; min-height: 24px; }
      .ap-deeprow .ap-meta { margin-left: auto; }
      .ap-filelist { max-height: 168px; overflow: auto; display: flex; flex-direction: column; gap: 1px;
        padding: 4px 0 4px 22px; }
      .ap-file { display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer; min-width: 0;
        padding: 3px 6px; border-radius: 6px; }
      .ap-file:hover { background: var(--dsw-alias-bg-layer-2); }
      .ap-filename { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        color: var(--dsw-alias-label-secondary); }
      .ap-total { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
      .ap-total strong { font-size: 15px; font-variant-numeric: tabular-nums; }
      .ap-empty { padding: 44px 12px; text-align: center; border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; }
      .ap-empty-title { font-size: 13px; margin-bottom: 4px; font-weight: 600; }
      .ap-empty-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ap-overlay { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
        background: color-mix(in oklab, var(--dsw-alias-label-primary) 42%, transparent); padding: 24px; }
      .ap-dialog { width: min(520px, 100%); max-height: calc(100vh - 48px); overflow: auto;
        background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 14px; padding: 18px; display: flex; flex-direction: column; gap: 12px;
        box-shadow: 0 18px 48px color-mix(in oklab, var(--dsw-alias-label-primary) 28%, transparent); }
      .ap-dialogtitle { font-size: 15px; font-weight: 650; }
      .ap-dialogbody { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
      .ap-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
      .ap-actions .ap-spacer { min-width: 8px; }
      @media (max-width: 560px) {
        .ap-bar { position: static; }
        .ap-hero { padding: 14px; }
        .ap-grouppath { display: none; }
        .ap-overlay { padding: 12px; align-items: flex-end; }
        .ap-dialog { max-height: calc(100vh - 24px); }
      }
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

    function baseName(filePath) {
      const parts = String(filePath ?? '').split(/[\\/]/);
      return parts[parts.length - 1] || String(filePath ?? '');
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
        const [deep, setDeep] = useState({ files: true, attachments: true, requestImages: false });
        const [excluded, setExcluded] = useState(() => new Set());
        const [showFiles, setShowFiles] = useState(false);
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
        const activeCount = items.filter((item) => item.active).length;
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

        const allInGroup = (group) => group.items.every((item) => selected.has(item.id));

        const toggleGroup = (group) => {
          const pick = !allInGroup(group);
          setSelected((current) => {
            const next = new Set(current);
            for (const item of group.items) {
              if (pick) next.add(item.id);
              else next.delete(item.id);
            }
            return next;
          });
          setNotice(null);
        };

        const closeConfirm = useCallback(() => setConfirming(false), []);

        const startScan = useCallback(async (ids) => {
          setScan({ loading: true, data: null, error: '' });
          setDeep({ files: true, attachments: true, requestImages: false });
          setExcluded(new Set());
          setShowFiles(false);
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
          setExcluded((current) => {
            const next = new Set(current);
            if (next.has(filePath)) next.delete(filePath);
            else next.add(filePath);
            return next;
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

        const scanned = scan?.data ?? null;
        const artifacts = scanned?.artifacts ?? [];
        const keptFiles = artifacts.filter((file) => !excluded.has(file.path));
        const keptBytes = keptFiles.reduce((sum, file) => sum + file.bytes, 0);
        const orphanCount = scanned?.attachments?.orphanObjects ?? 0;
        const orphanBytes = scanned?.attachments?.orphanBytes ?? 0;
        const scheduleCount = scanned?.schedules?.count ?? 0;
        const cacheBytes = scanned?.requestImages?.bytes ?? 0;
        const scopeFiles = deep.files ? keptBytes : 0;
        const scopeAttachments = deep.attachments && orphanCount > 0 ? orphanBytes : 0;
        const scopeCache = deep.requestImages && cacheBytes > 0 ? cacheBytes : 0;
        const totalFree = selectedBytes + scopeFiles + scopeAttachments + scopeCache;

        const runDelete = async () => {
          const ids = [...selected];
          const body = { sessionIds: ids, attachments: deep.attachments && orphanCount > 0, requestImages: deep.requestImages };
          // `everything` lets the Host re-derive the set from logs that are
          // still readable instead of trusting a list the browser built.
          if (scanned && deep.files && excluded.size === 0) body.everything = true;
          else if (scanned && deep.files && keptFiles.length > 0) body.files = keptFiles.map((file) => file.path);
          setConfirming(false);
          setBusy(true);
          setNotice(null);
          try {
            const result = await request('/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
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
              if (result.schedules?.deleted > 0) {
                text += ` · ${t('noticeSchedules').replace('{n}', String(result.schedules.deleted))}`;
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
              if (Array.isArray(result.schedules?.failures)) {
                for (const entry of result.schedules.failures) details.push(`${entry.id} — ${entry.message}`);
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

        const checkbox = (checked, onChange, label, disabled = false) => h('input', {
          type: 'checkbox',
          checked,
          disabled,
          onChange,
          'aria-label': label,
        });

        const stat = (value, label) => h('div', { className: 'ap-stat', key: label },
          h('span', { className: 'ap-statvalue' }, value),
          h('span', { className: 'ap-statlabel' }, label),
        );

        const leftoverPlan = leftovers?.plan ?? null;
        const leftoverChanged = leftoverPlan ? leftoverPlan.files.filter((file) => file.changed).length : 0;
        const leftoverFree = (() => {
          if (!leftoverPlan || !leftoverSel) return 0;
          let sum = 0;
          for (const file of leftoverPlan.files) {
            if (!file.changed && leftoverSel.files.has(file.path)) sum += file.bytes;
          }
          if (leftoverSel.logs) sum += leftoverPlan.logs.reduce((acc, entry) => acc + (entry.bytes ?? 0), 0);
          if (leftoverSel.caches) sum += leftoverPlan.caches.reduce((acc, entry) => acc + (entry.bytes ?? 0), 0);
          if (leftoverSel.attachments) sum += leftoverPlan.attachments?.orphanBytes ?? 0;
          if (leftoverSel.requestImages) sum += leftoverPlan.requestImages?.bytes ?? 0;
          return sum;
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

        const fileRow = (file) => h('label', { className: 'ap-file', key: file.path },
          h('input', {
            type: 'checkbox',
            checked: !excluded.has(file.path),
            onChange: () => toggleDeepFile(file.path),
          }),
          h('span', { className: 'ap-filename', title: file.path }, baseName(file.path)),
          h('span', { className: 'ap-meta' }, formatBytes(file.bytes)),
        );

        return h('div', { className: 'ap-root' },
          h('style', null, CSS),
          h('header', { className: 'ap-hero' },
            h('div', { className: 'ap-title' }, t('title')),
            h('div', { className: 'ap-sub' }, t('subtitle')),
            h('div', { className: 'ap-stats' },
              stat(String(data?.archivedCount ?? total), t('statSessions')),
              stat(formatBytes(data?.totalBytes ?? 0), t('statSize')),
              stat(String(activeCount), t('statActive')),
              stat(`${selectedCount} · ${formatBytes(selectedBytes)}`, t('statSelected')),
            ),
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
              `${t('selected')} ${selectedCount} / ${total}`,
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
                    leftoverPlan.files.slice(0, MAX_VISIBLE_FILES).map((file) => h('label', { className: 'ap-file', key: file.path },
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
              : groups.map((group) => h('section', { className: 'ap-group', key: group.key },
                h('div', { className: 'ap-grouphead' },
                  h('span', { className: 'ap-grouptitle' }, group.title),
                  group.path ? h('span', { className: 'ap-grouppath', title: group.path }, group.path) : null,
                  h('span', { className: 'ap-spacer' }),
                  h('span', { className: 'ap-meta' }, `${group.items.length} ${t('countUnit')}`),
                  h('button', {
                    type: 'button',
                    className: 'ap-link',
                    onClick: () => toggleGroup(group),
                  }, allInGroup(group) ? t('groupClear') : t('groupSelect')),
                ),
                group.items.map((item) => h('label', { className: 'ap-row', key: item.id },
                  checkbox(selected.has(item.id), () => toggle(item.id), item.title || item.id),
                  h('div', { className: 'ap-body' },
                    h('div', { className: 'ap-name' + (item.title ? '' : ' ap-unknown') }, item.title || item.id),
                    h('div', { className: 'ap-tags' },
                      h('span', { className: 'ap-meta' }, `${t('size')} ${formatBytes(item.sizeBytes)}`),
                      item.lastActivity
                        ? h('span', { className: 'ap-meta' }, `${t('lastActivity')} ${new Date(item.lastActivity).toLocaleString()}`)
                        : null,
                      item.scheduleCount > 0
                        ? h('span', { className: 'ap-tag ap-schedule' }, t('scheduleTag').replace('{n}', String(item.scheduleCount)))
                        : null,
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
            h('div', { className: 'ap-dialogbody' }, t('confirmBody').replace('{n}', String(selectedCount))),
            h('div', { className: 'ap-deep' },
              h('div', { className: 'ap-scopehead' }, t('scopeTitle')),
              h('div', { className: 'ap-deeprow' },
                h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true }),
                h('span', null, t('scopeSession')),
                h('span', { className: 'ap-meta' }, formatBytes(selectedBytes)),
              ),
              scan?.loading
                ? h('div', { className: 'ap-meta' }, t('scanning'))
                : scan?.error
                  ? h('div', { className: 'ap-meta' }, t('scanFailed').replace('{reason}', scan.error))
                  : scanned
                    ? [
                      h('div', { key: 'files' },
                        h('div', { className: 'ap-deeprow' },
                          h('input', {
                            type: 'checkbox',
                            checked: deep.files,
                            disabled: artifacts.length === 0,
                            onChange: (event) => setDeep((current) => ({ ...current, files: event.target.checked })),
                          }),
                          h('span', null, t('scopeFiles')),
                          h('span', { className: 'ap-meta' },
                            artifacts.length === 0
                              ? t('filesNone')
                              : `${keptFiles.length} ${t('filesUnit')} · ${formatBytes(keptBytes)}`),
                          artifacts.length > 0
                            ? h('button', {
                              type: 'button',
                              className: 'ap-link',
                              onClick: () => setShowFiles((current) => !current),
                            }, showFiles ? t('hideFiles') : t('showFiles'))
                            : null,
                        ),
                        showFiles && artifacts.length > 0
                          ? h('div', { className: 'ap-filelist' },
                            artifacts.slice(0, MAX_VISIBLE_FILES).map((file) => fileRow(file)))
                          : null,
                      ),
                      h('div', { className: 'ap-deeprow', key: 'attachments' },
                        h('input', {
                          type: 'checkbox',
                          checked: deep.attachments,
                          disabled: orphanCount === 0,
                          onChange: (event) => setDeep((current) => ({ ...current, attachments: event.target.checked })),
                        }),
                        h('span', null, t('scopeAttachments')),
                        h('span', { className: 'ap-meta' },
                          scanned.attachments?.blocked
                            ? t('deepBlocked').replace('{reason}', scanned.attachments.blocked)
                            : orphanCount === 0
                              ? t('scopeEmpty')
                              : `${orphanCount} · ${formatBytes(orphanBytes)}`),
                      ),
                      scheduleCount > 0
                        ? h('div', { className: 'ap-deeprow', key: 'schedules' },
                          h('input', { type: 'checkbox', checked: true, disabled: true, readOnly: true }),
                          h('span', null, t('scopeSchedules')),
                          h('span', { className: 'ap-meta' }, String(scheduleCount)),
                        )
                        : null,
                      h('div', { className: 'ap-deeprow', key: 'cache' },
                        h('input', {
                          type: 'checkbox',
                          checked: deep.requestImages,
                          disabled: cacheBytes === 0,
                          onChange: (event) => setDeep((current) => ({ ...current, requestImages: event.target.checked })),
                        }),
                        h('span', null, t('scopeImages')),
                        h('span', { className: 'ap-meta' },
                          cacheBytes === 0
                            ? t('scopeEmpty')
                            : t('scopeImagesNote').replace('{size}', formatBytes(cacheBytes))),
                      ),
                    ]
                    : null,
            ),
            h('div', { className: 'ap-dialogbody ap-total' },
              h('span', null, `${t('estimate')}`),
              h('strong', null, formatBytes(totalFree)),
            ),
            h('div', { className: 'ap-dialogbody' }, t('irreversible')),
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
