'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  entryGroup, groupStateKey, groupToggleLabel, planDirectoryGroups,
} = require('../renderer/file-manager-grouping');
const { createFolderActivityTracker } = require('../renderer/file-manager-activity');
const {
  createFolderActivityService, scanFolderActivity, MAX_DIRECTORIES_PER_REQUEST,
} = require('../core/file-manager-activity');
const { registerFileManagerIpc } = require('../main/ipc/file-manager-handlers');
const { createJunctionFixture } = require('./helpers/junction-fixture');

const file = (name, mtimeMs = 0) => ({ name, path: `C:\\w\\${name}`, type: 'file', mtimeMs });
const dir = (name, mtimeMs = 0) => ({ name, path: `C:\\w\\${name}`, type: 'directory', mtimeMs });

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fm-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function touch(target, seconds, content = 'x') {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  fs.utimesSync(target, seconds, seconds);
}

test('files come before folders; each group keeps its incoming sort order', () => {
  const plan = planDirectoryGroups([dir('b'), file('x.md'), dir('a'), { name: 'lnk', type: 'link' }, file('y.md')]);
  assert.deepEqual(plan.map(g => g.group), ['files', 'folders']);
  assert.deepEqual(plan[0].visible.map(e => e.name), ['x.md', 'lnk', 'y.md']);
  assert.deepEqual(plan[1].visible.map(e => e.name), ['b', 'a']);
  assert.equal(entryGroup({ type: 'other' }), 'files');
  assert.deepEqual(planDirectoryGroups([]), []);
});

test('each group shows top 5 with a toggle; expanded shows all and offers collapse', () => {
  const files = Array.from({ length: 8 }, (_, i) => file(`f${i}.md`));
  const folders = Array.from({ length: 6 }, (_, i) => dir(`d${i}`));
  const [f, d] = planDirectoryGroups([...folders, ...files], { limit: 5 });
  assert.deepEqual(f.visible.map(e => e.name), ['f0.md', 'f1.md', 'f2.md', 'f3.md', 'f4.md']);
  assert.equal(f.hiddenCount, 3); assert.equal(f.showToggle, true);
  assert.equal(groupToggleLabel(f), '显示全部 8 个文件');
  assert.equal(d.visible.length, 5); assert.equal(groupToggleLabel(d), '显示全部 6 个文件夹');
  const [open] = planDirectoryGroups(files, { limit: 5, isExpanded: g => g === 'files' });
  assert.equal(open.visible.length, 8); assert.equal(open.showToggle, true);
  assert.equal(groupToggleLabel(open), '收起文件');
  const [small] = planDirectoryGroups(files.slice(0, 5), { limit: 5 });
  assert.equal(small.showToggle, false); assert.equal(groupToggleLabel(small), '');
  const [all] = planDirectoryGroups(files, { limit: Infinity });
  assert.equal(all.visible.length, 8); assert.equal(all.showToggle, false);
});

test('pinned entries past the cut stay visible so a refresh re-rank never hides them', () => {
  const folders = Array.from({ length: 7 }, (_, i) => dir(`d${i}`));
  const [plan] = planDirectoryGroups(folders, { limit: 5, isPinned: e => e.name === 'd6' });
  assert.deepEqual(plan.visible.map(e => e.name), ['d0', 'd1', 'd2', 'd3', 'd4', 'd6']);
  assert.equal(plan.hiddenCount, 1);
  const [allPinned] = planDirectoryGroups(folders.slice(0, 6), { limit: 5, isPinned: e => e.name === 'd5' });
  assert.equal(allPinned.hiddenCount, 0); assert.equal(allPinned.showToggle, false);
  assert.equal(groupStateKey('C:\\W', 'files'), groupStateKey('c:\\w', 'files'));
});

test('subtree scan finds deep changes that the folder mtime does not reflect', async t => {
  const root = tempRoot(t);
  const folder = path.join(root, 'docs');
  touch(path.join(folder, 'old.md'), 1000);
  touch(path.join(folder, 'design', 'deep', 'new.md'), 5000);
  touch(path.join(folder, 'node_modules', 'pkg', 'newer.js'), 9000);
  touch(path.join(folder, '.git', 'index'), 9000);
  for (const d of [folder, path.join(folder, 'design'), path.join(folder, 'design', 'deep'), path.join(folder, 'node_modules'), path.join(folder, 'node_modules', 'pkg'), path.join(folder, '.git')]) fs.utimesSync(d, 500, 500);
  const result = await scanFolderActivity(folder);
  assert.equal(result.ok, true);
  assert.equal(Math.round(result.latestMs / 1000), 5000);
  assert.equal(path.relative(folder, result.latestPath), path.join('design', 'deep', 'new.md'));
  assert.equal(result.incomplete, false);
  assert.equal((await scanFolderActivity(path.join(folder, 'node_modules'))).skipped, 'excluded');
});

test('subtree scan limits are explicit: depth, entries and time', async t => {
  const root = tempRoot(t);
  touch(path.join(root, 'a', 'b', 'c', 'deep.md'), 5000);
  for (let i = 0; i < 20; i++) touch(path.join(root, 'many', `f${i}.txt`), 1000 + i);
  const shallow = await scanFolderActivity(path.join(root, 'a'), { maxDepth: 1 });
  assert.equal(shallow.incomplete, true); assert.ok(shallow.reasons.includes('depth'));
  const few = await scanFolderActivity(path.join(root, 'many'), { maxEntries: 5 });
  assert.equal(few.incomplete, true); assert.ok(few.reasons.includes('entries')); assert.ok(Number.isFinite(few.latestMs));
  let clock = 0;
  const slow = await scanFolderActivity(path.join(root, 'a'), { timeBudgetMs: 10, now: () => (clock += 20) });
  assert.equal(slow.incomplete, true); assert.ok(slow.reasons.includes('time'));
});

test('subtree scan does not follow junctions', async t => {
  const root = tempRoot(t);
  const outside = tempRoot(t);
  touch(path.join(outside, 'external.md'), 9000);
  touch(path.join(root, 'work', 'local.md'), 2000);
  await createJunctionFixture(outside, path.join(root, 'work', 'linked'));
  try {
    const result = await scanFolderActivity(path.join(root, 'work'));
    assert.equal(path.basename(result.latestPath), 'local.md');
    assert.equal((await scanFolderActivity(path.join(root, 'work', 'linked'))).skipped, 'link');
  } finally { fs.unlinkSync(path.join(root, 'work', 'linked')); }
});

test('service caches within TTL, force rescans, and rejects paths outside root', async t => {
  const root = tempRoot(t);
  const folder = path.join(root, 'docs'); fs.mkdirSync(folder);
  let scans = 0; let clock = 0;
  const service = createFolderActivityService({ ttlMs: 1000, now: () => clock, scan: async d => { scans++; return { ok: true, directory: d, latestMs: scans, latestPath: d }; } });
  let r = await service.lookup({ root, directories: [folder] });
  assert.equal(r.results[0].latestMs, 1);
  r = await service.lookup({ root, directories: [folder] });
  assert.equal(scans, 1); assert.equal(r.results[0].cached, true);
  r = await service.lookup({ root, directories: [folder], force: true });
  assert.equal(scans, 2);
  clock = 5000; await service.lookup({ root, directories: [folder] }); assert.equal(scans, 3);
  r = await service.lookup({ root, directories: [os.tmpdir()] });
  assert.equal(r.results[0].ok, false);
  await assert.rejects(service.lookup({ root, directories: Array.from({ length: MAX_DIRECTORIES_PER_REQUEST + 1 }, (_, i) => path.join(root, String(i))) }), /最多/);
});

test('IPC exposes folder-activity through the shared file-manager handler', async t => {
  const root = tempRoot(t);
  touch(path.join(root, 'docs', 'a.md'), 3000);
  const handlers = new Map();
  registerFileManagerIpc({ handle: (name, fn) => handlers.set(name, fn) }, { dataDir: path.join(root, 'hub'), electron: { shell: {}, clipboard: {} } });
  const r = await handlers.get('file-manager:folder-activity')(null, { root, directories: [path.join(root, 'docs')] });
  assert.equal(r.ok, true); assert.equal(Math.round(r.results[0].latestMs / 1000), 3000);
  const bad = await handlers.get('file-manager:folder-activity')(null, { root: 'relative' });
  assert.equal(bad.ok, false);
});

test('tracker queries only stale folders, merges deep mtime and describes it', async () => {
  const calls = []; let clock = 0; let updates = 0;
  const tracker = createFolderActivityTracker({
    getRoot: () => 'C:\\w', ttlMs: 100, now: () => clock, onUpdate: () => { updates++; },
    ipcRenderer: { invoke: async (channel, payload) => {
      calls.push(payload);
      return { ok: true, results: payload.directories.map(d => ({ ok: true, directory: d, latestMs: 9000, latestPath: `${d}\\sub\\new.md`, incomplete: d.endsWith('b'), reasons: d.endsWith('b') ? ['time'] : [] })) };
    } },
  });
  const a = dir('a', 1000); const b = dir('b', 20000);
  assert.equal(tracker.effectiveMtime(a), 1000);
  await tracker.request([a.path, b.path]);
  assert.equal(calls.length, 1); assert.equal(updates, 1);
  assert.equal(tracker.effectiveMtime(a), 9000);
  assert.equal(tracker.effectiveMtime(b), 20000);
  assert.equal(tracker.effectiveMtime(file('x', 42)), 42);
  assert.match(tracker.describe(a), /^子树最近改动：sub\\new\.md /);
  assert.match(tracker.describe(b), /扫描不完整：超出扫描时间/);
  await tracker.request([a.path]); assert.equal(calls.length, 1);
  await tracker.request([a.path], { force: true }); assert.equal(calls.length, 2); assert.equal(calls[1].force, true);
  clock = 500; await tracker.request([a.path, b.path]); assert.equal(calls.length, 3);
  tracker.clear(); assert.equal(tracker.get(a.path), null); assert.equal(tracker.effectiveMtime(a), 1000);
});

test('tracker drops responses that arrive after the root changed', async () => {
  let release;
  const tracker = createFolderActivityTracker({
    getRoot: () => 'C:\\w',
    ipcRenderer: { invoke: () => new Promise(resolve => { release = () => resolve({ ok: true, results: [{ ok: true, directory: 'C:\\w\\a', latestMs: 5 }] }); }) },
  });
  const pending = tracker.request(['C:\\w\\a']);
  assert.equal(tracker.isPending('C:\\w\\a'), true);
  tracker.clear(); release(); await pending;
  assert.equal(tracker.get('C:\\w\\a'), null);
});
