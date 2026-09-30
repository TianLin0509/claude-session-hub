'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatRelativeTime, isFresh } = require('../renderer/file-manager-time');
const { planDirectoryGroups, isNoiseFolder } = require('../renderer/file-manager-grouping');
const { selectSessionChanges, createSessionChangesTracker } = require('../renderer/file-manager-session-changes');
const { createPrefs, createViewOptions } = require('../renderer/file-manager-view-options');
const { registerFileManagerIpc } = require('../main/ipc/file-manager-handlers');

const at = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

test('relative time: 刚刚 / N 分钟前 / 今天 / 昨天 / N 天前 / MM/DD / 跨年', () => {
  const now = at(2026, 9, 29, 19, 30);
  assert.equal(formatRelativeTime(now - 20 * 1000, now), '刚刚');
  assert.equal(formatRelativeTime(now + 20 * 1000, now), '刚刚', 'small clock skew');
  assert.equal(formatRelativeTime(now - 60 * 1000, now), '1 分钟前');
  assert.equal(formatRelativeTime(now - 59 * 60 * 1000, now), '59 分钟前');
  assert.equal(formatRelativeTime(at(2026, 9, 29, 8, 5), now), '今天 08:05');
  assert.equal(formatRelativeTime(at(2026, 9, 28, 23, 59), now), '昨天 23:59');
  assert.equal(formatRelativeTime(at(2026, 9, 27, 12, 0), now), '2 天前');
  assert.equal(formatRelativeTime(at(2026, 9, 23, 12, 0), now), '6 天前');
  assert.equal(formatRelativeTime(at(2026, 9, 22, 12, 0), now), '09/22');
  assert.equal(formatRelativeTime(at(2025, 12, 31, 12, 0), now), '2025/12/31');
  assert.equal(formatRelativeTime(null, now), '—');
  // 刚过午夜：40 分钟前优先于「昨天」。
  const midnight = at(2026, 9, 30, 0, 20);
  assert.equal(formatRelativeTime(at(2026, 9, 29, 23, 40), midnight), '40 分钟前');
  assert.equal(formatRelativeTime(at(2026, 9, 29, 22, 10), midnight), '昨天 22:10');
});

test('freshness window is 10 minutes', () => {
  const now = at(2026, 9, 29, 19, 30);
  assert.equal(isFresh(now - 9 * 60 * 1000, now), true);
  assert.equal(isFresh(now - 10 * 60 * 1000, now), false);
  assert.equal(isFresh(undefined, now), false);
});

test('noise folders never take a top-5 slot and sink to the end of the folder group', () => {
  const dir = (name, mtimeMs) => ({ name, path: `C:\\w\\${name}`, type: 'directory', mtimeMs });
  // 已按修改时间降序：.git 与 node_modules 最新。
  const sorted = [dir('.git', 9), dir('node_modules', 8), dir('core', 7), dir('__pycache__', 6), dir('tests', 5), dir('docs', 4), dir('main', 3), dir('.pytest_cache', 2), dir('tools', 1)];
  const [folders] = planDirectoryGroups(sorted, { limit: 5 });
  assert.deepEqual(folders.visible.map(e => e.name), ['core', 'tests', 'docs', 'main', 'tools']);
  const [expanded] = planDirectoryGroups(sorted, { limit: 5, isExpanded: () => true });
  assert.deepEqual(expanded.visible.map(e => e.name), ['core', 'tests', 'docs', 'main', 'tools', '.git', 'node_modules', '__pycache__', '.pytest_cache']);
  // 普通文件夹不足 5 个时，噪声目录补位（仍排在最后）。
  const [few] = planDirectoryGroups([dir('.git', 9), dir('core', 7)], { limit: 5 });
  assert.deepEqual(few.visible.map(e => e.name), ['core', '.git']);
  assert.equal(isNoiseFolder({ name: '.git', type: 'file' }), false, 'a file named .git is not a noise folder');
  const [raw] = planDirectoryGroups(sorted, { limit: 5, demoteNoise: false });
  assert.equal(raw.visible[0].name, '.git');
});

test('session changes keep only files modified at or after the session start, newest first', () => {
  const file = (name, mtimeMs, type = 'file') => ({ name, path: `C:\\w\\${name}`, type, mtimeMs });
  const list = selectSessionChanges([file('old.md', 999), file('start.md', 1000), file('new.md', 3000), file('mid.md', 2000), file('dir', 5000, 'directory')], 1000);
  assert.deepEqual(list.map(e => e.name), ['new.md', 'mid.md', 'start.md']);
  assert.deepEqual(selectSessionChanges([file('a', 5)], 0), [], 'unknown session start shows nothing');
  assert.equal(selectSessionChanges(Array.from({ length: 10 }, (_, i) => file(`f${i}`, 2000 + i)), 1000, 3).length, 3);
});

test('session changes tracker throttles automatic scans and passes since to the scan', async () => {
  const calls = []; let clock = 0; let updates = 0;
  const tracker = createSessionChangesTracker({
    getRoot: () => 'C:\\w', getSince: () => 1000, now: () => clock, intervalMs: 15000, onUpdate: () => { updates++; },
    ipcRenderer: { invoke: async (channel, payload) => { calls.push([channel, payload]); return { ok: true, entries: [{ name: 'a.md', type: 'file', mtimeMs: 2000 }, { name: 'b.md', type: 'file', mtimeMs: 500 }] }; } },
  });
  await tracker.refresh();
  assert.equal(calls[0][0], 'file-manager:scan'); assert.equal(calls[0][1].since, 1000); assert.equal(calls[0][1].recent, true);
  assert.deepEqual(tracker.get().entries.map(e => e.name), ['a.md']);
  clock = 5000; await tracker.refresh(); assert.equal(calls.length, 1, 'within interval: no rescan');
  await tracker.refresh({ force: true }); assert.equal(calls.length, 2, 'manual refresh rescans');
  clock = 30000; await tracker.refresh(); assert.equal(calls.length, 3);
  assert.equal(updates, 1, 'unchanged rescans do not re-render');
  const none = createSessionChangesTracker({ getRoot: () => 'C:\\w', getSince: () => 0, ipcRenderer: { invoke: () => assert.fail('no scan without a start time') } });
  await none.refresh(); assert.equal(none.get(), null);
});

test('scan IPC applies since and limit on the main side', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fm-since-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, seconds) => { const full = path.join(root, name); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, 'x'); fs.utimesSync(full, seconds, seconds); };
  write('old.md', 1000); write('sub/new.md', 3000); write('newer.md', 4000); write('node_modules/pkg/skip.js', 5000);
  const handlers = new Map();
  registerFileManagerIpc({ handle: (name, fn) => handlers.set(name, fn) }, { dataDir: path.join(root, '.hub'), electron: { shell: {}, clipboard: {} } });
  const scan = p => handlers.get('file-manager:scan')(null, p);
  let r = await scan({ root, query: '', recent: true, since: 2000 * 1000 });
  assert.deepEqual(r.entries.map(e => e.name), ['newer.md', 'new.md']);
  r = await scan({ root, query: '', recent: true, since: 2000 * 1000, limit: 1 });
  assert.deepEqual(r.entries.map(e => e.name), ['newer.md']); assert.equal(r.truncated, true);
});

test('prefs store merges fields so view options, favorites and width do not overwrite each other', () => {
  const store = new Map();
  const w = { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  const prefs = createPrefs(w);
  assert.deepEqual(prefs.load(), {});
  prefs.save({ sort: 'name', descending: false });
  prefs.save({ favorites: [{ path: 'C:\\x', type: 'directory' }] });
  prefs.save({ width: '420px' });
  assert.deepEqual(prefs.load(), { sort: 'name', descending: false, favorites: [{ path: 'C:\\x', type: 'directory' }], width: '420px' });
  store.set('hub-file-manager-v2', '{broken');
  assert.deepEqual(prefs.load(), {}, 'corrupt prefs fall back to defaults');
});

test('legacy saved name sort does not override the mtime default; an explicit choice does', () => {
  const store = new Map();
  const w = { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  const anchor = { classList: { toggle() {} }, addEventListener() {} };
  const make = () => createViewOptions({ document: {}, window: w, anchor, prefs: createPrefs(w), onChange() {}, report(e) { throw e; } });
  store.set('hub-file-manager-v2', JSON.stringify({ sort: 'name', descending: false, width: '400px' }));
  let options = make();
  assert.equal(options.view.sort, 'mtime');
  assert.equal(options.view.descending, true);
  options.setSort('name');
  assert.equal(JSON.parse(store.get('hub-file-manager-v2')).sortChosen, true);
  options = make();
  assert.equal(options.view.sort, 'name');
  assert.equal(options.view.descending, false);
});
