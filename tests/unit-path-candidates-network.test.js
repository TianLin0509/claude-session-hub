'use strict';
// 2026-10-09 生产实测：卡片正文里出现 \\100.100.97.83\cellDT\...（家里连不上的公司共享），
// 识别路径链接时在渲染主线程上 fs.statSync 等 SMB 超时，整个窗口冻结 24 秒。
// 约束：网络路径绝不在主线程同步查询；查到存在后链接照常补上；同一共享连不上时不重复排队超时。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const realStatSync = fs.statSync, realExistsSync = fs.existsSync, realStat = fs.promises.stat;
const syncNetworkCalls = [];
const asyncCalls = [];
let asyncImpl = null;
fs.statSync = function (p, ...rest) { if (/^\\\\/.test(String(p))) syncNetworkCalls.push(String(p)); return realStatSync.call(this, p, ...rest); };
fs.existsSync = function (p) { if (/^\\\\/.test(String(p))) syncNetworkCalls.push(String(p)); return realExistsSync.call(this, p); };
fs.promises.stat = p => { asyncCalls.push(String(p)); return asyncImpl(String(p)); };

const pc = require('../renderer/path-candidates.js');
const dirStat = { isDirectory: () => true };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

beforeEach(() => { syncNetworkCalls.length = 0; asyncCalls.length = 0; });

test('a share path is never stat-ed synchronously and does not block rendering', async () => {
  // Only the exact folder exists, as on a real share (greedy longer matches do not).
  const gate = [];
  asyncImpl = p => new Promise((resolve, reject) => gate.push(() => (p === '\\\\10.9.9.1\\cellDT\\trace\\day1'
    ? resolve(dirStat) : reject(Object.assign(new Error('nope'), { code: 'ENOENT' })))));
  const release = () => { while (gate.length) gate.shift()(); };
  const pending = [];
  const text = '在 A 框粘贴这个目录：\\\\10.9.9.1\\cellDT\\trace\\day1';
  const started = Date.now();
  const first = pc.collectPathCandidates(text, null, { onNetworkPending: p => pending.push(p) });
  assert.ok(Date.now() - started < 50);
  assert.deepEqual(syncNetworkCalls, [], 'no synchronous fs call on a UNC path');
  assert.equal(first.length, 0, 'unknown yet: not linked (same as an unreachable path today)');
  assert.ok(pending.length > 0, 'the caller is told a share path is pending');

  const resolved = [];
  const off = pc.onNetworkPathResolved(p => resolved.push(p));
  release();
  await tick();
  release(); // paths that waited for the share's first verdict
  await tick();
  off();
  assert.ok(resolved.length > 0, 'listeners hear when the path exists');
  const second = pc.collectPathCandidates(text);
  assert.equal(second.length, 1, 'once known, the folder is linked as before');
  assert.equal(second[0].openPath, '\\\\10.9.9.1\\cellDT\\trace\\day1');
  assert.deepEqual(syncNetworkCalls, []);
});

test('an unreachable share is probed once, not once per path', async () => {
  let fail;
  asyncImpl = () => new Promise((_, reject) => { fail = () => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })); });
  const text = ['\\\\10.9.9.2\\share\\a\\b', '\\\\10.9.9.2\\share\\c\\d', '\\\\10.9.9.2\\share\\e\\f'].join(' 和 ');
  pc.collectPathCandidates(text);
  assert.equal(asyncCalls.length, 1, 'later paths wait for the share verdict');
  fail();
  await tick();
  pc.collectPathCandidates(text);
  pc.collectPathCandidates('\\\\10.9.9.2\\share\\g\\h');
  assert.equal(asyncCalls.length, 1, 'a share that timed out is skipped for a while');
  assert.deepEqual(syncNetworkCalls, []);
});

test('a missing entry on a reachable share does not mark the share down', async () => {
  asyncImpl = p => (p.endsWith('missing') ? Promise.reject(Object.assign(new Error('nope'), { code: 'ENOENT' })) : Promise.resolve(dirStat));
  pc.collectPathCandidates('\\\\10.9.9.3\\share\\missing');
  await tick();
  pc.collectPathCandidates('\\\\10.9.9.3\\share\\present\\dir');
  await tick();
  assert.equal(pc.collectPathCandidates('\\\\10.9.9.3\\share\\present\\dir').length, 1);
});

test('clicking a share path checks it off the main thread', async () => {
  asyncImpl = () => Promise.resolve(dirStat);
  assert.equal(await pc._isDirectoryPathAsync('\\\\10.9.9.4\\share\\dir'), true);
  assert.deepEqual(syncNetworkCalls, []);
});

test('local folders are still recognised immediately', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-local-dir-'));
  try {
    const found = pc.collectPathCandidates(`打开 ${dir}\\ 看看`);
    assert.ok(found.some(c => c.openPath.replace(/\\$/, '') === dir), JSON.stringify(found));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test.after(() => { fs.statSync = realStatSync; fs.existsSync = realExistsSync; fs.promises.stat = realStat; });
