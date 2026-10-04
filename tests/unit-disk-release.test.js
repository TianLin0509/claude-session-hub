'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiskReleaseEngine, PLAN_TTL_MS } = require('../core/disk-release-engine');
const { allocatedSizes, retainLiveProcessRows } = require('../core/disk-release-windows');
const { acquireDiskReleaseLock } = require('../core/disk-release-lock');
const { inside, defaultScopes } = require('../core/disk-release-policy');

async function makeDirectoryLink(target, link) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return; }
    catch (error) {
      if (error.code !== 'EBUSY') throw error;
      if (fs.existsSync(link) && fs.lstatSync(link).isSymbolicLink()
          && fs.realpathSync(link) === fs.realpathSync(target)) return;
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

function cleanup(root) {
  assert.ok(inside(os.tmpdir(), root) && path.basename(root).startsWith('hub-disk-unit-'));
  if (!fs.existsSync(root)) return;
  const dirs = []; const stack = [root];
  while (stack.length) {
    const folder = stack.pop(); dirs.push(folder);
    for (const name of fs.readdirSync(folder)) {
      const target = path.join(folder, name); const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) { try { fs.unlinkSync(target); } catch { fs.rmdirSync(target); } }
      else if (stat.isDirectory()) stack.push(target);
      else fs.unlinkSync(target);
    }
  }
  for (const folder of dirs.reverse()) fs.rmdirSync(folder);
}
function setup(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-disk-unit-'));
  const target = path.join(root, 'hub-writing-fixture');
  const file = path.join(target, 'data', 'cache', 'session-search-v3.sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(65536, 7));
  const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, old, old);
  let rows = [{ pid: process.pid, name: 'node.exe', cmd: 'unit test runner' }];
  const options = { scopes: [{ root, mode: 'tests', label: 'Test' }], dataDir: path.join(root, 'data'),
    lockPath: path.join(root, 'cleanup.lock'), readProcesses: async () => rows,
    allocatedSizes: async files => files.map(entry => entry.size), ...overrides };
  const engine = createDiskReleaseEngine(options);
  t.after(() => cleanup(root));
  return { root, target, file, engine, options, setRows: value => { rows = value; } };
}
const request = (plan, keys = plan.items.filter(item => item.tier !== 'info').map(item => item.key)) => ({ scanId: plan.scanId, keys, confirmed: true });

test('departed processes do not block cleanup while unreadable live processes stay protected', () => {
  const rows = [{ pid: 1, name: 'node.exe', cmd: null }, { pid: 2, name: 'node.exe', cmd: null },
    { pid: 3, name: 'node.exe', cmd: null }, { pid: 4, name: 'node.exe', cmd: 'node active' }];
  const result = retainLiveProcessRows(rows, pid => {
    if (pid === 1) { const error = new Error('gone'); error.code = 'ESRCH'; throw error; }
    if (pid === 2) { const error = new Error('access denied'); error.code = 'EPERM'; throw error; }
  });
  assert.deepEqual(result.map(row => row.pid), [2, 3, 4]);
});

test('confirmed selection deletes only selected test data, keeps neighboring source and writes a receipt', async t => {
  const { root, file, engine } = setup(t);
  const neighbor = path.join(root, 'project', 'main.js'); fs.mkdirSync(path.dirname(neighbor)); fs.writeFileSync(neighbor, 'source');
  const plan = await engine.scan(); assert.equal(plan.items.length, 1); assert.equal(plan.items[0].selected, true);
  const result = await engine.execute(request(plan));
  assert.equal(result.results[0].ok, true); assert.equal(result.results[0].deletedFiles, 1);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.readFileSync(neighbor, 'utf8'), 'source');
  assert.ok(fs.existsSync(result.receiptPath)); assert.equal(typeof result.netFreeChangeBytes, 'number');
});
test('execution requires explicit confirmation and a scan-bound selection', async t => {
  const { file, engine } = setup(t); const plan = await engine.scan();
  await assert.rejects(engine.execute({ scanId: plan.scanId, keys: [plan.items[0].key] }), /确认/);
  await assert.rejects(engine.execute(request(plan, [plan.items[0].key, '../../outside'])), /未知/);
  assert.ok(fs.existsSync(file));
});
test('recent files remain read-only and cannot be executed', async t => {
  const { file, engine } = setup(t); fs.utimesSync(file, new Date(), new Date());
  const plan = await engine.scan(); assert.equal(plan.items[0].tier, 'info'); assert.match(plan.items[0].reason, /最近两天/);
  await assert.rejects(engine.execute(request(plan, [plan.items[0].key])), /不可清理/); assert.ok(fs.existsSync(file));
});
test('file modification after scan skips the whole item', async t => {
  const { file, engine } = setup(t); const plan = await engine.scan(); fs.appendFileSync(file, 'changed');
  const result = await engine.execute(request(plan));
  assert.equal(result.results[0].ok, false); assert.ok(fs.existsSync(file));
});
test('new files added after scan are preserved', async t => {
  const { target, file, engine } = setup(t); const plan = await engine.scan();
  const newer = path.join(target, 'new.txt'); fs.writeFileSync(newer, 'current work');
  const result = await engine.execute(request(plan));
  assert.equal(result.results[0].ok, false); assert.ok(fs.existsSync(file)); assert.ok(fs.existsSync(newer));
});
test('test directories containing source or installed dependencies are protected', async t => {
  const { target, engine } = setup(t); fs.mkdirSync(path.join(target, '.git'));
  const plan = await engine.scan(); assert.equal(plan.items[0].tier, 'info'); assert.match(plan.items[0].reason, /源码/);
});
test('junctions are never traversed or cleaned', async t => {
  const { root, target, file, engine } = setup(t);
  const external = path.join(root, 'external'); fs.mkdirSync(external); const protectedFile = path.join(external, 'keep.txt'); fs.writeFileSync(protectedFile, 'keep');
  await makeDirectoryLink(external, path.join(target, 'linked'));
  const plan = await engine.scan(); assert.equal(plan.items[0].tier, 'info'); assert.ok(fs.existsSync(file));
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep');
});
test('a target replaced with a junction after scan cannot escape its boundary', async t => {
  const { root, target, engine } = setup(t); const plan = await engine.scan();
  const moved = path.join(root, 'original'); fs.renameSync(target, moved);
  const external = path.join(root, 'external'); fs.mkdirSync(external); const protectedFile = path.join(external, 'keep.txt'); fs.writeFileSync(protectedFile, 'keep');
  await makeDirectoryLink(external, target);
  const result = await engine.execute(request(plan)); assert.equal(result.results[0].ok, false);
  assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'keep');
});
test('activity detected after scan blocks cleanup', async t => {
  const { target, file, engine, setRows } = setup(t); const plan = await engine.scan();
  setRows([{ pid: process.pid, name: 'electron.exe', cmd: `electron --user-data-dir="${target}"` }]);
  const result = await engine.execute(request(plan)); assert.equal(result.results[0].ok, false); assert.match(result.results[0].message, /使用/); assert.ok(fs.existsSync(file));
});
test('unreadable development process identity fails closed', async t => {
  const { file, engine, setRows } = setup(t); setRows([{ pid: 55555, name: 'python.exe', cmd: null }]);
  const plan = await engine.scan(); assert.equal(plan.items[0].tier, 'info'); assert.ok(fs.existsSync(file));
});
test('process enumeration failure after scan never deletes files and releases the lock', async t => {
  let fail = false;
  const fixture = setup(t, { readProcesses: async () => { if (fail) throw new Error('probe failed'); return []; } });
  const plan = await fixture.engine.scan(); fail = true;
  await assert.rejects(fixture.engine.execute(request(plan)), /probe failed/);
  assert.ok(fs.existsSync(fixture.file)); assert.equal(fs.existsSync(fixture.options.lockPath), false);
  const unlock = await acquireDiskReleaseLock(fixture.options.lockPath); await unlock();
});
test('expired plans cannot be replayed', async t => {
  let clock = Date.now(); const { file, engine } = setup(t, { now: () => clock });
  const plan = await engine.scan(); clock += PLAN_TTL_MS + 1;
  await assert.rejects(engine.execute(request(plan)), /过期/); assert.ok(fs.existsSync(file));
});
test('cross-window OS cleanup lock preserves all files while another operation owns it', async t => {
  const { file, engine, options } = setup(t); const plan = await engine.scan();
  const unlock = await acquireDiskReleaseLock(options.lockPath);
  try { await assert.rejects(engine.execute(request(plan)), /另一个窗口/); assert.ok(fs.existsSync(file)); }
  finally { await unlock(); }
});
test('cleanup can proceed after another operation releases the OS lock', async t => {
  const { file, engine, options } = setup(t); const plan = await engine.scan();
  const unlock = await acquireDiskReleaseLock(options.lockPath); await unlock();
  const result = await engine.execute(request(plan)); assert.equal(result.results[0].ok, true); assert.equal(fs.existsSync(file), false);
});
test('physical allocation is used for predicted space and Android devices are unselected', async t => {
  const fixture = setup(t); const emulator = path.join(fixture.root, '20260901-test-avd');
  const file = path.join(emulator, 'userdata.img'); fs.mkdirSync(emulator); fs.writeFileSync(file, Buffer.alloc(1048576));
  const old = new Date(Date.now() - 3 * 86400000); fs.utimesSync(file, old, old);
  const engine = createDiskReleaseEngine({ ...fixture.options, scopes: [{ root: fixture.root, mode: 'emulators' }], allocatedSizes: async files => files.map(() => 4096) });
  const plan = await engine.scan(); assert.equal(plan.items[0].bytes, 4096); assert.equal(plan.items[0].logicalBytes, 1048576);
  assert.equal(plan.items[0].tier, 'manual'); assert.equal(plan.items[0].selected, false);
});
test('unavailable allocation reads preserve the candidate', async t => {
  const { file, engine } = setup(t, { allocatedSizes: async files => files.map(() => -1) });
  const plan = await engine.scan(); assert.equal(plan.items[0].tier, 'info'); assert.match(plan.items[0].reason, /占用/); assert.ok(fs.existsSync(file));
});
test('production data remains protected even if it has a test-shaped folder name', async t => {
  const fixture = setup(t);
  const engine = createDiskReleaseEngine({ ...fixture.options, dataDir: fixture.target });
  const plan = await engine.scan(); assert.equal(plan.items[0].tier, 'info'); assert.match(plan.items[0].reason, /范围/); assert.ok(fs.existsSync(fixture.file));
});
test('test scope overrides cannot point outside the isolated test data parent', () => {
  assert.throws(() => defaultScopes({ dataDir: path.join(os.tmpdir(), 'isolated-data', 'data'), testRoot: path.join(os.tmpdir(), 'other-task') }), /隔离/);
});
test('actual Windows allocation helper accepts Chinese paths as data', { skip: process.platform !== 'win32' }, async t => {
  const { root } = setup(t); const file = path.join(root, "中文 ' cache.bin"); fs.writeFileSync(file, Buffer.alloc(524288, 3));
  const sizes = await allocatedSizes([{ path: file, size: 524288 }]);
  assert.equal(sizes.length, 1); assert.ok(sizes[0] > 0 && sizes[0] <= 528384);
});
