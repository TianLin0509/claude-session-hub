'use strict';
// gemini-equiv RED — GeminiTap.getDebugSnapshot() 契约
//
// 与 codex 镜像（unit-codex-debug-ipc-contract.test.js）：
//   暴露 _pending / _bound / _seen 当前状态，给运行时排查"为什么没 bind"用。
//   main.js 加 ipcMain.handle('roundtable-gemini-debug-state', ...) 转发此快照到 renderer。
//
// 在 GREEN 实施前 RED 失败：
//   - GeminiTap.getDebugSnapshot 不存在
//   - GeminiTap 不接受 opts.tmpRoot（导致 case 3 没法离线测）
//   - TranscriptTap.getGeminiDebugSnapshot 不存在
//   - main.js 没 roundtable-gemini-debug-state IPC

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { GeminiTap, TranscriptTap } = require('../core/transcript-tap');
const { FakeGeminiSession } = require('./helpers/fake-gemini-session');

let failed = 0;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// === case 1: getDebugSnapshot 方法存在 + 返回固定结构 ===
function testGetDebugSnapshotShape() {
  const tap = new GeminiTap();
  assert.strictEqual(typeof tap.getDebugSnapshot, 'function', 'GeminiTap must expose getDebugSnapshot()');
  const snap = tap.getDebugSnapshot();
  assert.ok(snap && typeof snap === 'object');
  assert.ok(typeof snap.tmpRoot === 'string', 'snap must have tmpRoot string (gemini 单 root，不像 codex 多 root)');
  assert.ok(snap.tmpRoot.length > 0);
  assert.ok(Array.isArray(snap.pending), 'snap.pending must be Array');
  assert.ok(Array.isArray(snap.bound), 'snap.bound must be Array');
  assert.ok(Array.isArray(snap.seen), 'snap.seen must be Array');
}

// === case 2: pending 项含 hubSessionId / cwd / spawnTime / ageMs / projectDir ===
function testPendingItemFields() {
  const tap = new GeminiTap();
  tap.registerSession('hub-debug-1', { cwd: 'C:\\test\\dir' });

  const snap = tap.getDebugSnapshot();
  assert.strictEqual(snap.pending.length, 1, 'expected 1 pending after registerSession');
  const item = snap.pending[0];
  assert.strictEqual(item.hubSessionId, 'hub-debug-1');
  assert.ok(typeof item.cwd === 'string');
  assert.ok(item.cwd.length > 0);
  assert.ok(typeof item.spawnTime === 'number');
  assert.ok(typeof item.ageMs === 'number');
  assert.ok(item.ageMs >= 0);
  // projectDir 在 _scanOnce 解析前可为 null
  assert.ok('projectDir' in item, 'pending item must include projectDir field (may be null until resolved)');

  tap.unregisterSession('hub-debug-1');
}

// === case 3: bound 项含 hubSessionId / sessionPath / hasLastText / isJsonl ===
async function testBoundItemFields() {
  const tmpRoot = path.join(os.tmpdir(), 'gemini-debug-bound-' + Date.now());
  const cwd = 'C:\\test\\bound-gemini';
  // GeminiTap 须接受 opts.tmpRoot 注入（向后兼容默认 ~/.gemini/tmp）
  const tap = new GeminiTap({ tmpRoot });

  let fr;
  try {
    fr = new FakeGeminiSession({ tmpRoot, cwd });
    await fr.start();
    await fr.writeFullTurn('hello from fake gemini');
    await fr.close();

    const hubSid = 'hub-debug-bound-gemini';
    tap.registerSession(hubSid, { cwd });

    // poll 等 bind（_scanOnce 1s 间隔）
    let bound = false;
    for (let i = 0; i < 60; i++) {
      if (tap._bound.has(hubSid)) { bound = true; break; }
      await _sleep(100);
    }
    assert.ok(bound, 'must bind within 6s');

    const snap = tap.getDebugSnapshot();
    assert.strictEqual(snap.bound.length, 1, 'expected 1 bound');
    const item = snap.bound[0];
    assert.strictEqual(item.hubSessionId, hubSid);
    assert.ok(typeof item.sessionPath === 'string');
    assert.ok(item.sessionPath.endsWith('.jsonl'));
    assert.strictEqual(typeof item.hasLastText, 'boolean');
    assert.strictEqual(typeof item.isJsonl, 'boolean');
    // bind 后 pending 应被清掉
    assert.strictEqual(snap.pending.length, 0, 'pending should be empty after bind');
  } finally {
    if (fr) { try { await fr.close(); } catch {} }
    tap.unregisterSession('hub-debug-bound-gemini');
    try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

// === case 4: TranscriptTap 暴露 getGeminiDebugSnapshot 转发 ===
function testTranscriptTapForwardsSnapshot() {
  const tap = new TranscriptTap();
  assert.strictEqual(typeof tap.getGeminiDebugSnapshot, 'function',
    'TranscriptTap must expose getGeminiDebugSnapshot() forwarder');
  const snap = tap.getGeminiDebugSnapshot();
  assert.ok(snap && typeof snap === 'object');
  assert.ok(typeof snap.tmpRoot === 'string');
}

// === case 5: 内部敏感字段不暴露（不能含 timer / EventEmitter listeners 等）===
function testSnapshotDoesNotLeakInternals() {
  const tap = new GeminiTap();
  tap.registerSession('sid-A', { cwd: 'C:\\x' });
  const snap = tap.getDebugSnapshot();
  for (const item of snap.pending) {
    assert.ok(!('_pollTimer' in item), 'pending must not expose _pollTimer');
    assert.ok(!('tail' in item), 'pending must not expose tail object');
  }
  for (const item of snap.bound) {
    assert.ok(!('tail' in item), 'bound must not expose tail object');
    assert.ok(!('debounceTimer' in item), 'bound must not expose debounceTimer');
    assert.ok(!('_idleTimer' in item), 'bound must not expose _idleTimer');
    assert.ok(!('_streamingBuf' in item), 'bound must not expose _streamingBuf (大对象)');
  }
  let serialized;
  try { serialized = JSON.stringify(snap); } catch (e) { throw new Error('snap not JSON-serializable: ' + e.message); }
  assert.ok(serialized.length > 0);
  tap.unregisterSession('sid-A');
}

// === case 6: main.js 含 roundtable-gemini-debug-state IPC handler ===
function testMainJsHasDebugStateIpc() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(
    /ipcMain\.handle\(['"]roundtable-gemini-debug-state['"]/.test(src),
    'main.js must register ipcMain.handle("roundtable-gemini-debug-state", ...)',
  );
}

// === runner ===

const tests = [
  testGetDebugSnapshotShape,
  testPendingItemFields,
  testBoundItemFields,
  testTranscriptTapForwardsSnapshot,
  testSnapshotDoesNotLeakInternals,
  testMainJsHasDebugStateIpc,
];

(async () => {
  for (const t of tests) {
    try {
      const r = t();
      if (r && typeof r.then === 'function') await r;
      console.log('  ✓', t.name);
    } catch (e) {
      console.error('  ✗', t.name);
      console.error('    ', e.stack || e.message);
      failed++;
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
