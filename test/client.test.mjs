import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';

/**
 * The Settings page is plain React loaded through `window.__ModuleLoader__`.
 * This harness supplies a minimal hook runtime and a stubbed `fetch`, so the
 * real `client.js` can be mounted and clicked without a browser: it catches a
 * render crash and pins the deep-clean request body.
 */

const ROUTE = '/plugins/archived-purge';

function makeRuntime() {
  const slots = [];
  const effects = [];
  const callbacks = new Map();
  let cursor = 0;
  let dirty = false;
  let mounted;

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        dirty = true;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(factory) {
      cursor += 1;
      return factory();
    },
    useCallback(factory) {
      const index = cursor++;
      if (!callbacks.has(index)) callbacks.set(index, factory);
      return callbacks.get(index);
    },
    useEffect(fn, deps) {
      const index = cursor++;
      const key = `${index}:${JSON.stringify(deps ?? null)}`;
      if (!effects.some((entry) => entry.key === key)) effects.push({ key, fn });
    },
  };

  function renderOnce() {
    cursor = 0;
    effects.length = 0;
    return mounted();
  }

  async function settle(tree, limit = 40) {
    let current = tree;
    for (let step = 0; step < limit; step += 1) {
      const due = effects.splice(0, effects.length);
      for (const entry of due) await entry.fn();
      await new Promise((resolve) => setImmediate(resolve));
      if (!dirty && effects.length === 0) return current;
      if (dirty) {
        dirty = false;
        current = renderOnce();
      }
    }
    return current;
  }

  return {
    React,
    mount(component) {
      mounted = component;
      return renderOnce();
    },
    settle,
    rerender() {
      dirty = false;
      return renderOnce();
    },
  };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function find(node, predicate) {
  const hits = [];
  walk(node, (child) => {
    if (predicate(child)) hits.push(child);
  });
  return hits;
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  return (node.children ?? []).map(textOf).join('');
}

function hasClass(node, className) {
  return typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className);
}

async function mountPanel(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), body });
    const route = String(url).slice(ROUTE.length);
    const payload = responses[route]?.(body) ?? {};
    return { ok: true, status: 200, json: async () => payload };
  };
  const { React, mount, settle } = makeRuntime();
  let definition;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: { load(spec) { definition = spec; } },
  };
  const source = await fsp.readFile(new URL('../client.js', import.meta.url), 'utf8');
  new Function('window', source)(globalThis.window);
  const module = definition.factory((id) => {
    assert.equal(id, 'react');
    return React;
  });

  let Panel;
  const strings = {};
  module.apply({
    effect(fn) {
      fn();
    },
    locale: {
      register() {},
      bind() {
        return (key) => key;
      },
    },
    slots: {
      inject(_slot, load) {
        load();
      },
      register(_spec, component) {
        Panel = component;
        return () => {};
      },
    },
  });
  assert.ok(Panel, 'the settings section was registered');
  const first = mount(Panel);
  const tree = await settle(first);
  return { tree, calls, restore: () => { globalThis.fetch = original; }, settle, strings };
}

const stateResponse = () => ({
  items: [
    {
      id: 'session-a',
      title: 'Alpha',
      workspaceId: 'w1',
      workspaceTitle: 'demo-workspace',
      workspacePath: 'C:\\ws',
      sizeBytes: 4096,
      cacheBytes: 512,
      lastActivity: 1_700_000_000_000,
      exists: true,
      active: false,
      activity: [],
      activityUnknown: false,
      resident: true,
    },
  ],
  archivedCount: 1,
  pendingFinalize: 0,
  totalBytes: 4096,
});

test('the settings page renders, then sends the deep-clean delete body', async () => {
  const responses = {
    '/state': stateResponse,
    '/scan': () => ({
      ok: true,
      attachments: { objects: 2, bytes: 200, orphanObjects: 1, orphanBytes: 100, keptObjects: 1, blocked: undefined },
      requestImages: { files: 1, bytes: 50 },
      artifacts: [{ path: 'C:\\ws\\report.md', bytes: 10, mtime: 1, tools: ['write'], sessions: ['session-a'] }],
      unreadableSessions: [],
    }),
    '/delete': () => ({
      ok: true,
      deleted: 1,
      failed: 0,
      deferred: [],
      removedBytes: 4096,
      artifacts: { deleted: 1, bytes: 10, results: [] },
      gc: { removedObjects: 1, removedBytes: 100 },
    }),
  };
  const panel = await mountPanel(responses);
  try {
    // Listing renders the archived Session row.
    const rows = find(panel.tree, (node) => hasClass(node, 'ap-row'));
    assert.equal(rows.length, 1);
    assert.match(textOf(rows[0]), /Alpha/);

    // Select all, then open the confirmation dialog: the dialog asks /scan.
    const selectAll = find(panel.tree, (node) => node.props?.type === 'checkbox' && node.props?.['aria-label'] === 'selectAll')[0];
    selectAll.props.onChange();
    let tree = await panel.settle(panel.tree);
    const deleteButton = find(tree, (node) => node.type === 'button' && textOf(node) === 'delete')[0];
    assert.ok(deleteButton, 'the delete button exists');
    deleteButton.props.onClick();
    tree = await panel.settle(tree);
    assert.ok(panel.calls.some((call) => call.url.endsWith('/scan')), 'opening the dialog scans first');

    // The deep-clean block shows the attachment and artifact numbers.
    const deep = find(tree, (node) => hasClass(node, 'ap-deep'))[0];
    assert.ok(deep, 'the deep-clean block rendered');
    assert.match(textOf(deep), /report\.md/);

    // Tick the produced file, then confirm.
    const fileRow = find(deep, (node) => hasClass(node, 'ap-file'))[0];
    assert.ok(fileRow, 'the produced file is offered');
    const fileBox = find(fileRow, (node) => node.props?.type === 'checkbox')[0];
    fileBox.props.onChange();
    tree = await panel.settle(tree);
    const confirm = find(tree, (node) => node.type === 'button' && textOf(node) === 'confirm')[0];
    assert.ok(confirm, 'the confirm button exists');
    confirm.props.onClick();
    tree = await panel.settle(tree);

    const del = panel.calls.find((call) => call.url.endsWith('/delete'));
    assert.deepEqual(del.body.sessionIds, ['session-a']);
    assert.deepEqual(del.body.files, ['C:\\ws\\report.md']);
    assert.equal(del.body.attachments, true);
    assert.equal(del.body.requestImages, false);
    assert.match(textOf(tree), /noticeDeleted/);
  } finally {
    panel.restore();
  }
});

test('the orphan-attachment sweep asks before deleting anything', async () => {
  let executed = false;
  const responses = {
    '/state': stateResponse,
    '/gc': (body) => {
      if (body?.dryRun === false) executed = true;
      return {
        ok: true,
        dryRun: body?.dryRun !== false,
        orphanObjects: 3,
        orphanBytes: 300,
        requestImages: { files: 2, bytes: 80 },
        removedObjects: 3,
        removedBytes: 300,
      };
    },
  };
  const panel = await mountPanel(responses);
  try {
    const button = find(panel.tree, (node) => node.type === 'button' && textOf(node) === 'orphanGc')[0];
    assert.ok(button, 'the sweep button exists');
    button.props.onClick();
    let tree = await panel.settle(panel.tree);
    assert.equal(executed, false, 'the first request is a dry run');
    assert.match(textOf(tree), /orphanGcFound/);

    const confirm = find(tree, (node) => node.type === 'button' && textOf(node) === 'orphanGcConfirm')[0];
    assert.ok(confirm, 'the inline confirmation rendered');
    confirm.props.onClick();
    tree = await panel.settle(tree);
    assert.equal(executed, true);
    assert.match(textOf(tree), /orphanGcDone/);
  } finally {
    panel.restore();
  }
});
