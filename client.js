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
          setConfirming(false);
          setBusy(true);
          setNotice(null);
          try {
            const result = await request('/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionIds: ids }),
            });
            // The Host answers 200 for every well-formed request, including one
            // that removed nothing; `ok` and `message` carry the outcome.
            if (result?.ok) {
              setNotice({
                kind: 'ok',
                text: `${t('noticeDeleted')} ${result.deleted ?? ids.length} ${t('countUnit')} · ${t('noticeFreed')} ${formatBytes(result.removedBytes)}`,
              });
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
              onClick: load,
              disabled: loading || busy,
            }, t('refresh')),
            h('button', {
              type: 'button',
              className: 'ap-btn ap-danger',
              onClick: () => setConfirming(true),
              disabled: selectedCount === 0 || busy,
            }, busy ? t('deleting') : t('delete')),
          ),
          error
            ? h('div', { className: 'ap-notice ap-error' }, `${t('loadFailed')}：${error}`)
            : null,
          notice
            ? h('div', { className: notice.kind === 'error' ? 'ap-notice ap-error' : 'ap-notice' },
              h('div', null, notice.text),
              Array.isArray(notice.details) && notice.details.length > 0
                ? h('ul', { className: 'ap-noticelist' }, notice.details.map((line, index) => h('li', { key: index }, line)))
                : null,
            )
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
