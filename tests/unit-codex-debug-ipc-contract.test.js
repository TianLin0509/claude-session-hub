'use strict';
// E1.2 RED — CodexTap.getDebugSnapshot() 契约
//
// 调试入口：暴露 _pending / _bound / _seen 当前状态，给运行时排查"为什么没 bind"用。
// main.js 加 ipcMain.handle('roundtable-codex-debug-state', ...) 转发此快照到 renderer。
//
// 在 GREEN 实施前 RED 失败（getDebugSnapshot 不存在）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { CodexTap, TranscriptTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('../tests/helpers/fake-codex-rollout');

let failed = 0;

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// === case 1: getDebugSnapshot 方法存在 + 返回固定结构 ===
function testGetDebugSnapshotShape() {
  const tap = new CodexTap();
  assert.strictEqual(typeof tap.getDebugSnapshot, 'function', 'CodexTap must expose getDebugSnapshot()');
  const snap = tap.getDebugSnapshot();
  assert.ok(snap && typeof snap === 'object');
  assert.ok('sessionsRoot' in snap, 'snap must have sessionsRoot');
  assert.ok(Array.isArray(snap.pending), 'snap.pending must be Array');
  assert.ok(Array.isArray(snap.bound), 'snap.bound must be Array');
  assert.ok(Array.isArray(snap.seen), 'snap.seen must be Array');
}

// === case 2: pending 项含 hubSessionId / cwd / spawnTime / ageMs ===
function testPendingItemFields() {
  const tap = new CodexTap();
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

  tap.unregisterSession('hub-debug-1');
}

// === case 3: bound 项含 hubSessionId / rolloutPath / hasLastText ===
async function testBoundItemFields() {
  const tmpRoot = path.join(os.tmpdir(), 'codex-debug-bound-' + Date.now());
  const cwd = 'C:\\test\\bound';
  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });

  try {
    const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd });
    await fr.start();
    await fr.writeAgentMessage('something');
    await fr.close();

    const hubSid = 'hub-debug-bound';
    tap.registerSession(hubSid, { cwd });

    // poll 等 bind
    let bound = false;
    for (let i = 0; i < 40; i++) {
      if (tap._bound.has(hubSid)) { bound = true; break; }
      await _sleep(50);
    }
    assert.ok(bound, 'must bind');

    const snap = tap.getDebugSnapshot();
    assert.strictEqual(snap.bound.length, 1, 'expected 1 bound');
    const item = snap.bound[0];
    assert.strictEqual(item.hubSessionId, hubSid);
    assert.ok(typeof item.rolloutPath === 'string');
    assert.ok(item.rolloutPath.endsWith('.jsonl'));
    assert.strictEqual(typeof item.hasLastText, 'boolean');
    // bind 后 pending 应被清掉
    assert.strictEqual(snap.pending.length, 0, 'pending should be empty after bind');
  } finally {
    tap.unregisterSession('hub-debug-bound');
    await fs.promises.rm(tmpRoot, { recursive: true, force: true });
  }
}

// === case 4: TranscriptTap 暴露 getCodexDebugSnapshot 转发 ===
function testTranscriptTapForwardsSnapshot() {
  const tap = new TranscriptTap();
  assert.strictEqual(typeof tap.getCodexDebugSnapshot, 'function',
    'TranscriptTap must expose getCodexDebugSnapshot() forwarder');
  const snap = tap.getCodexDebugSnapshot();
  assert.ok(snap && typeof snap === 'object');
  assert.ok('sessionsRoot' in snap);
}

// === case 5: 内部敏感字段不暴露（不能含 timer / EventEmitter listeners 等）===
function testSnapshotDoesNotLeakInternals() {
  const tap = new CodexTap();
  tap.registerSession('sid-A', { cwd: 'C:\\x' });
  const snap = tap.getDebugSnapshot();
  // pending 项不应直接暴露 setInterval / setTimeout 句柄
  for (const item of snap.pending) {
    assert.ok(!('_pollTimer' in item), 'pending must not expose _pollTimer');
    assert.ok(!('tail' in item), 'pending must not expose tail object');
  }
  for (const item of snap.bound) {
    assert.ok(!('tail' in item), 'bound must not expose tail object');
    assert.ok(!('_pendingEmitTimer' in item), 'bound must not expose pending timer');
  }
  // 应该可 JSON.stringify 不抛
  let serialized;
  try { serialized = JSON.stringify(snap); } catch (e) { throw new Error('snap not JSON-serializable: ' + e.message); }
  assert.ok(serialized.length > 0);
  tap.unregisterSession('sid-A');
}

// === case 6: main.js 含 codex-debug-state IPC handler ===
function testMainJsHasDebugStateIpc() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(
    /ipcMain\.handle\(['"]roundtable-codex-debug-state['"]/.test(src),
    'main.js must register ipcMain.handle("roundtable-codex-debug-state", ...)',
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
