'use strict';
// Phase 0 fake harness 自验 smoke test
// 验证 tests/helpers/fake-codex-{rollout,pty,ipc-harness}.js 三件套自身可用
//
// 这不是业务逻辑测试，是"帮助函数能跑通"的最低保证。
// 服务于 Phase 1/2/3 的真实单测——若这个 smoke 挂了，下游单测全废。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { FakeCodexRollout } = require('../tests/helpers/fake-codex-rollout');
const { FakeCodexPty } = require('../tests/helpers/fake-codex-pty');
const { FakeIpcHarness, KNOWN_CHANNELS } = require('../tests/helpers/fake-codex-ipc-harness');

let failed = 0;

// === FakeCodexRollout ===

async function testRolloutWriteFullTurn() {
  const tmpRoot = path.join(os.tmpdir(), 'fake-codex-test-' + Date.now());
  const fr = new FakeCodexRollout({
    sessionsRoot: tmpRoot,
    cwd: 'C:\\Users\\test\\proj',
    sid: 'test-sid-aaaa-bbbb-cccc-dddddddddddd',
  });
  await fr.start({ baseInstructionsText: 'short instructions' });
  await fr.writeFullTurn(['intermediate 1', 'intermediate 2'], 'final answer', { gapMs: 10 });
  await fr.close();

  // rollout 文件应存在
  assert.ok(fs.existsSync(fr.rolloutPath), 'rolloutPath must exist after start+close');
  const content = fs.readFileSync(fr.rolloutPath, 'utf8');
  const lines = content.trim().split('\n');
  assert.ok(lines.length >= 4, `expected ≥4 lines (session_meta + 2 agent_message + 1 task_complete), got ${lines.length}`);

  // 首行 session_meta 字段齐全
  const meta = JSON.parse(lines[0]);
  assert.strictEqual(meta.type, 'session_meta');
  assert.strictEqual(meta.payload.cwd, 'C:\\Users\\test\\proj');
  assert.strictEqual(meta.payload.cli_version, '0.125.0');
  assert.strictEqual(meta.payload.id, 'test-sid-aaaa-bbbb-cccc-dddddddddddd');

  // 末行 task_complete + last_agent_message
  const last = JSON.parse(lines[lines.length - 1]);
  assert.strictEqual(last.type, 'event_msg');
  assert.strictEqual(last.payload.type, 'task_complete');
  assert.strictEqual(last.payload.last_agent_message, 'final answer');

  await fr.cleanup();
  assert.ok(!fs.existsSync(tmpRoot), 'cleanup must remove sessionsRoot');
}

async function testRolloutStreamingOnlyHasNoTaskComplete() {
  const tmpRoot = path.join(os.tmpdir(), 'fake-codex-test-' + Date.now() + '-streaming');
  const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd: '/x' });
  await fr.start();
  await fr.writeStreamingOnly(['piece A', 'piece B'], { gapMs: 5 });
  await fr.close();

  const content = fs.readFileSync(fr.rolloutPath, 'utf8');
  assert.ok(!content.includes('"task_complete"'), 'streaming-only must not contain task_complete');
  assert.ok(content.includes('"piece A"'), 'must contain first agent_message');
  assert.ok(content.includes('"piece B"'), 'must contain second agent_message');

  await fr.cleanup();
}

function testRolloutCleanupRefusesUnsafePath() {
  const fr = new FakeCodexRollout({
    sessionsRoot: 'C:\\Users\\lintian\\.codex\\sessions',  // 真实生产路径
    cwd: '/x',
  });
  return fr.cleanup().then(
    () => { throw new Error('cleanup should have refused unsafe path'); },
    (err) => { assert.ok(err.message.includes('refused'), 'expected refusal error'); },
  );
}

// === FakeCodexPty ===

function testPtyWriteLogAndAck() {
  const pty = new FakeCodexPty();
  let received = '';
  pty.on('data', (d) => { received += d; });

  pty.write('hello\r');
  pty.emitAck('hello');
  pty.close();

  assert.strictEqual(pty.getWriteLog(), 'hello\r', 'write log must capture user input');
  assert.ok(pty.hasWritten('hello'), 'hasWritten should return true for known substr');
  assert.ok(received.includes('hello'), 'ack should echo prompt');
  assert.ok(received.includes('thinking...'), 'ack should include status line proxy');
}

function testPtyEchoOnlyNoAck() {
  const pty = new FakeCodexPty();
  let received = '';
  pty.on('data', (d) => { received += d; });

  pty.emitEchoOnly('foo');

  assert.ok(received.includes('foo'), 'echo only should include prompt');
  assert.ok(!received.includes('thinking...'), 'echo only must NOT include ack signal');
}

// === FakeIpcHarness ===

async function testHarnessHandleAndInvoke() {
  const ipc = new FakeIpcHarness();
  ipc.handle('roundtable-manual-extract', async (_e, { sid }) => {
    return { ok: true, text: `extracted-for-${sid}`, source: 'test', extractMode: 'final_answer' };
  });

  const reply = await ipc.invoke('roundtable-manual-extract', { meetingId: 'm1', sid: 's1' });
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.text, 'extracted-for-s1');
  assert.strictEqual(reply.extractMode, 'final_answer');

  const timeline = ipc.getTimeline();
  assert.strictEqual(timeline.length, 2, 'expected invoke + reply records');
  assert.strictEqual(timeline[0].direction, 'renderer->main:invoke');
  assert.strictEqual(timeline[1].direction, 'main->renderer:reply');
}

async function testHarnessSendToRendererAndWaitForEvent() {
  const ipc = new FakeIpcHarness();

  setImmediate(() => ipc.sendToRenderer('roundtable-send-stuck', { meetingId: 'm', sid: 's', kind: 'codex' }));

  const payload = await ipc.waitForEvent('roundtable-send-stuck', { timeoutMs: 200 });
  assert.strictEqual(payload.kind, 'codex');
  assert.strictEqual(payload.sid, 's');
}

async function testHarnessWaitForEventTimeout() {
  const ipc = new FakeIpcHarness();
  let threw = null;
  try {
    await ipc.waitForEvent('roundtable-state-update', { timeoutMs: 50 });
  } catch (e) { threw = e; }
  assert.ok(threw, 'expected timeout error');
  assert.ok(threw.message.includes('timeout'), 'error message must mention timeout');
}

function testHarnessKnownChannelsCoverage() {
  // 校验已知 channel 清单覆盖 main.js 现状（plan v2 文档化的 4 + 6）
  assert.strictEqual(KNOWN_CHANNELS.handle.length, 4, 'expected 4 handle channels');
  assert.strictEqual(KNOWN_CHANNELS.push.length, 6, 'expected 6 push channels');
  assert.ok(KNOWN_CHANNELS.handle.includes('roundtable-manual-extract'));
  assert.ok(KNOWN_CHANNELS.push.includes('roundtable-send-stuck'));
}

// === runner ===

const tests = [
  testRolloutWriteFullTurn,
  testRolloutStreamingOnlyHasNoTaskComplete,
  testRolloutCleanupRefusesUnsafePath,
  testPtyWriteLogAndAck,
  testPtyEchoOnlyNoAck,
  testHarnessHandleAndInvoke,
  testHarnessSendToRendererAndWaitForEvent,
  testHarnessWaitForEventTimeout,
  testHarnessKnownChannelsCoverage,
];

(async () => {
  for (const t of tests) {
    try {
      const r = t();
      if (r && typeof r.then === 'function') await r;
    } catch (e) {
      console.error('  ✗', t.name);
      console.error('    ', e.stack || e.message);
      failed++;
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
