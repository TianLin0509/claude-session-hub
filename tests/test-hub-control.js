// tests/test-hub-control.js
// 独立 Node 测试 hub-control 基础操作，不依赖 Electron / Hub
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const hubControl = require('../core/hub-control');

const TMP_BASE = path.join(os.tmpdir(), 'hub-control-test-' + Date.now());

function setup() {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  return TMP_BASE;
}

function teardown() {
  try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch {}
}

async function main() {
  const dataDir = setup();

  // Test 1: writeControlFile 写 + 读回正确内容
  const startedAt = Date.now();
  const file = hubControl.writeControlFile({
    pid: process.pid,
    hookPort: 3456,
    cdpPort: 9221,
    token: 'abc123',
    dataDir,
    startedAt,
  });
  assert.ok(fs.existsSync(file), 'control file should exist');
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(back.pid, process.pid);
  assert.strictEqual(back.hookPort, 3456);
  assert.strictEqual(back.cdpPort, 9221);
  assert.strictEqual(back.token, 'abc123');
  assert.strictEqual(back.startedAt, startedAt);
  console.log('OK Test 1: writeControlFile + readback');

  // Test 2: cleanStale 不动当前进程（活的）
  const removed1 = hubControl.cleanStale(dataDir, { youngFileGraceMs: 0 });
  assert.deepStrictEqual(removed1, [], 'should not remove alive pid');
  console.log('OK Test 2: cleanStale keeps alive');

  // Test 3: cleanStale 删除假 PID
  const fakeFile = hubControl.writeControlFile({
    pid: 99999999, hookPort: 3457, cdpPort: 9222, token: 'x', dataDir, startedAt: Date.now() - 10000,
  });
  // 改 mtime 让它过 grace
  fs.utimesSync(fakeFile, new Date(Date.now() - 10000), new Date(Date.now() - 10000));
  const removed2 = hubControl.cleanStale(dataDir, { youngFileGraceMs: 5000 });
  assert.ok(removed2.includes(99999999), 'should remove fake pid');
  assert.ok(!fs.existsSync(fakeFile), 'fake control file should be deleted');
  console.log('OK Test 3: cleanStale removes dead pid');

  // Test 4: young file 不清理
  const youngFile = hubControl.writeControlFile({
    pid: 99999998, hookPort: 3458, cdpPort: 9223, token: 'y', dataDir, startedAt: Date.now(),
  });
  const removed3 = hubControl.cleanStale(dataDir, { youngFileGraceMs: 5000 });
  assert.ok(!removed3.includes(99999998), 'should not remove young file');
  assert.ok(fs.existsSync(youngFile), 'young file should survive');
  console.log('OK Test 4: cleanStale skips young files');

  // Test 5: unlinkSelf
  hubControl.unlinkSelf(dataDir, process.pid);
  const myFile = hubControl.controlFilePath(dataDir, process.pid);
  assert.ok(!fs.existsSync(myFile), 'self control file should be deleted');
  console.log('OK Test 5: unlinkSelf');

  // Test 6: readDevToolsActivePort 超时返回 null
  const port = await hubControl.readDevToolsActivePort(dataDir, { timeoutMs: 200, pollMs: 50 });
  assert.strictEqual(port, null, 'should return null on timeout');
  console.log('OK Test 6: readDevToolsActivePort timeout to null');

  // Test 7: readDevToolsActivePort 读到端口
  fs.writeFileSync(path.join(dataDir, 'DevToolsActivePort'), '12345\n/devtools/browser/abc\n');
  const port2 = await hubControl.readDevToolsActivePort(dataDir, { timeoutMs: 500 });
  assert.strictEqual(port2, 12345, 'should read port from DevToolsActivePort');
  console.log('OK Test 7: readDevToolsActivePort reads port');

  // Test 8: writeControlFile 原子写 (tmp 不残留)
  hubControl.writeControlFile({
    pid: 12345, hookPort: 3459, cdpPort: 9224, token: 'atomic', dataDir, startedAt: Date.now(),
  });
  const tmpFile = hubControl.controlFilePath(dataDir, 12345) + '.tmp';
  assert.ok(!fs.existsSync(tmpFile), 'tmp file should not linger after rename');
  console.log('OK Test 8: writeControlFile atomic (no .tmp residue)');

  teardown();
  console.log('\nAll tests passed.');
}

main().catch(err => {
  teardown();
  console.error(err);
  process.exit(1);
});
