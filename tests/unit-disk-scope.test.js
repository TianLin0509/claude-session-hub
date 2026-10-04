'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiskReleaseEngine } = require('../core/disk-release-engine');
const { createDiskUsageAnalyzer } = require('../core/disk-usage-analyzer');
const { defaultScopes, inside } = require('../core/disk-release-policy');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-disk-scope-unit-'));
  t.after(() => {
    assert.ok(inside(os.tmpdir(), root) && path.basename(root).startsWith('hub-disk-scope-unit-'));
    const stack = [root]; const dirs = [];
    while (stack.length) {
      const dir = stack.pop(); dirs.push(dir);
      for (const name of fs.readdirSync(dir)) {
        const item = path.join(dir, name); const stat = fs.lstatSync(item);
        if (stat.isSymbolicLink()) { try { fs.unlinkSync(item); } catch { fs.rmdirSync(item); } }
        else if (stat.isDirectory()) stack.push(item);
        else fs.unlinkSync(item);
      }
    }
    for (const dir of dirs.reverse()) fs.rmdirSync(dir);
  });
  const write = (relative, text = 'data') => {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); return target;
  };
  let rows = [];
  const engine = scopes => createDiskReleaseEngine({ scopes, lockPath: path.join(root, 'lock'),
    readProcesses: async () => rows, allocatedSizes: async files => files.map(file => file.size) });
  const analyzer = extra => createDiskUsageAnalyzer({ scopes: [{ root, label: '个人文件' }],
    allocatedSizes: async files => files.map(file => file.size), maxMs: 60000, ...extra });
  return { root, write, engine, analyzer, setRows: value => { rows = value; } };
}
const confirm = plan => ({ scanId: plan.scanId, keys: plan.items.filter(item => item.tier !== 'info').map(item => item.key), confirmed: true });

test('default cleanup includes additional caches and VibeData tests, never whole profile/history/model roots', () => {
  const scopes = defaultScopes();
  assert.ok(scopes.some(scope => /uv[\\/]cache$/.test(scope.root)));
  assert.ok(scopes.some(scope => /\.gradle[\\/]caches$/.test(scope.root)));
  assert.ok(scopes.some(scope => scope.mode === 'browserCaches'));
  assert.ok(scopes.some(scope => scope.mode === 'tests' && /VibeData[\\/]Temp$/.test(scope.root)));
  assert.ok(scopes.every(scope => !/\.codex$|xwechat_files$|Models$|Desktop$/.test(scope.root)));
});

test('browser cleanup targets cache folders while Cookies, Preferences, History and neighboring data survive', async t => {
  const f = setup(t);
  f.write('browser/Profile 1/Preferences', '{}');
  const cookie = f.write('browser/Profile 1/Network/Cookies', 'login');
  const history = f.write('browser/Profile 1/History', 'history');
  const cache = f.write('browser/Profile 1/Cache/Cache_Data/old', 'cached');
  const unknown = f.write('browser/unrecognized/Cache/keep', 'important');
  const engine = f.engine([{ root: path.join(f.root, 'browser'), mode: 'browserCaches', label: '浏览器缓存', activeNames: ['chrome.exe'] }]);
  const plan = await engine.scan(); assert.equal(plan.items.length, 1); assert.equal(plan.items[0].selected, true);
  const result = await engine.execute(confirm(plan)); assert.equal(result.results[0].ok, true);
  assert.equal(fs.existsSync(cache), false); assert.equal(fs.readFileSync(cookie, 'utf8'), 'login');
  assert.equal(fs.readFileSync(history, 'utf8'), 'history'); assert.ok(fs.existsSync(unknown));
  assert.ok(fs.existsSync(path.join(f.root, 'browser/Profile 1/Preferences')));
});

test('nested VibeData browser profiles are discovered without selecting the whole device/profile', async t => {
  const f = setup(t); f.write('browser/work/Default/Preferences', '{}'); f.write('browser/work/Default/GPUCache/x');
  const plan = await f.engine([{ root: path.join(f.root, 'browser'), mode: 'browserCaches', label: '缓存' }]).scan();
  assert.equal(plan.items.length, 1); assert.equal(path.basename(plan.items[0].path), 'GPUCache');
});

test('running browser protects its cache even when the process command line has no profile path', async t => {
  const f = setup(t); const file = f.write('cache/item'); f.setRows([{ name: 'chrome.exe', cmd: 'chrome' }]);
  const plan = await f.engine([{ root: path.dirname(file), mode: 'cache', label: '浏览器缓存', activeNames: ['chrome.exe'] }]).scan();
  assert.equal(plan.items[0].tier, 'info'); assert.match(plan.items[0].reason, /正在运行/); assert.ok(fs.existsSync(file));
});

test('browser starting after scan preserves the previously selected cache', async t => {
  const f = setup(t); const file = f.write('cache/item');
  const engine = f.engine([{ root: path.dirname(file), mode: 'cache', label: '缓存', activeNames: ['chrome.exe'] }]);
  const plan = await engine.scan(); f.setRows([{ name: 'chrome.exe', cmd: 'chrome' }]);
  const result = await engine.execute(confirm(plan)); assert.equal(result.results[0].ok, false); assert.ok(fs.existsSync(file));
});

test('uv caches hardlinked to an installed environment are protected', async t => {
  const f = setup(t); const cache = f.write('uv/cache/package'); const installed = path.join(f.root, 'installed'); fs.linkSync(cache, installed);
  const plan = await f.engine([{ root: path.dirname(cache), mode: 'cache', label: 'uv' }]).scan();
  assert.equal(plan.items[0].tier, 'info'); assert.match(plan.items[0].reason, /共享文件/);
  assert.ok(fs.existsSync(cache)); assert.ok(fs.existsSync(installed));
});

test('Java build activity and Yarn installation retain rebuildable caches', async t => {
  const f = setup(t); const file = f.write('cache/a'); const scope = { root: path.dirname(file), mode: 'cache', label: 'Gradle', activeNames: ['java.exe'] };
  f.setRows([{ name: 'java.exe', cmd: 'java gradle daemon' }]);
  assert.equal((await f.engine([scope]).scan()).items[0].tier, 'info');
  f.setRows([{ name: 'node.exe', cmd: 'node yarn install' }]);
  assert.equal((await f.engine([scope]).scan()).items[0].tier, 'info'); assert.ok(fs.existsSync(file));
});

test('read-only analysis reports measured allocation and children, never provides deletion keys', async t => {
  const f = setup(t); const file = f.write('photos/family.jpg', 'x'.repeat(1000));
  const result = await f.analyzer({ allocatedSizes: async files => files.map(() => 64) }).analyze();
  assert.equal(result.readOnly, true); assert.equal(result.items[0].bytes, 64);
  assert.deepEqual(result.items[0].children, [{ title: 'photos', bytes: 64 }]);
  assert.equal(result.items[0].key, undefined); assert.equal(result.scanId, undefined); assert.ok(fs.existsSync(file));
});

test('file-count bound marks analysis as partial, never labels it as a complete size', async t => {
  const f = setup(t); for (let i = 0; i < 5; i++) f.write(`photos/${i}`, 'abc');
  const result = await f.analyzer({ maxFiles: 2 }).analyze();
  assert.equal(result.items[0].partial, true); assert.equal(result.items[0].fileCount, 2);
  assert.equal(result.items[0].bytes, 6); assert.equal(fs.readdirSync(path.join(f.root, 'photos')).length, 5);
});

test('analysis skips directory links and retains personal files outside the scope', async t => {
  const f = setup(t); const personal = f.write('outside/personal.txt', 'keep'); const scope = path.join(f.root, 'scope'); fs.mkdirSync(scope);
  const link = path.join(scope, 'linked');
  for (let i = 0; ; i++) {
    try { fs.symlinkSync(path.dirname(personal), link, process.platform === 'win32' ? 'junction' : 'dir'); break; }
    catch (error) { if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()) break; if (error.code !== 'EBUSY' || i >= 4) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  const result = await f.analyzer({ scopes: [{ root: scope, label: '项目' }] }).analyze();
  assert.equal(result.items[0].bytes, 0); assert.equal(result.items[0].partial, true); assert.equal(result.items[0].skippedLinks, 1);
  assert.equal(fs.readFileSync(personal, 'utf8'), 'keep');
});

test('bounded analysis visits sibling files before exhausting its budget inside a deep environment', async t => {
  const f = setup(t); f.write('a-task/delivery', 'x'.repeat(1000));
  for (let i = 0; i < 4; i++) f.write(`z-environment/deep/lib/${i}`, 'x');
  const result = await f.analyzer({ maxFiles: 1 }).analyze();
  assert.equal(result.items[0].bytes, 1000); assert.equal(result.items[0].partial, true);
  assert.equal(result.items[0].children[0].title, 'a-task');
});

test('failed allocation lookup does not substitute sparse logical length and yields a partial result', async t => {
  const f = setup(t); f.write('snapshot', 'large');
  const result = await f.analyzer({ allocatedSizes: async () => [-1] }).analyze();
  assert.equal(result.items[0].bytes, 0); assert.equal(result.items[0].partial, true);
});

test('usage analysis can cancel without deleting a file or invalidating a cleanup plan', async t => {
  const f = setup(t); const file = f.write('cache/item'); const engine = f.engine([{ root: path.dirname(file), mode: 'cache', label: '缓存' }]);
  const plan = await engine.scan(); let analyzer;
  analyzer = f.analyzer({ onProgress: () => analyzer.cancel() });
  await assert.rejects(analyzer.analyze(), /取消/); assert.ok(fs.existsSync(file));
  const result = await engine.execute(confirm(plan)); assert.equal(result.results[0].ok, true);
});
