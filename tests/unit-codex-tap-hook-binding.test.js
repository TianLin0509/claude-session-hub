'use strict';
// hook 报上来的 rollout 路径是权威身份：文件还没落盘时先钉住，
// 同 cwd 同一秒出现的其他顶层 rollout（另一个 Codex、子代理）一律不许抢绑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout');

async function waitFor(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-bind-'));
  const sessionsRoot = path.join(root, 'sessions');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const tap = new CodexTap({ sessionsRoot, pollIntervalMs: 40 });
  t.after(() => { tap.unregisterSession('hub-1'); fs.rmSync(root, { recursive: true, force: true }); });
  return { sessionsRoot, cwd, tap };
}

test('a pinned hook path wins over a same-cwd decoy that appears first', async t => {
  const { sessionsRoot, cwd, tap } = setup(t);
  tap.registerSession('hub-1', { cwd });
  const real = new FakeCodexRollout({ sessionsRoot, cwd, sid: '019eaaaa-0000-7000-8000-00000000000a' });
  const decoy = new FakeCodexRollout({ sessionsRoot, cwd, sid: '019ebbbb-0000-7000-8000-00000000000b' });
  // hook 先到：文件还不存在，只能钉住期望路径。
  assert.equal(await tap.bindFromHook('hub-1', { codexSid: real.sid, transcriptPath: real.rolloutPath }), false);
  await decoy.start();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(tap.getRolloutPath('hub-1'), null, 'the decoy must not be guessed onto a pinned session');
  await real.start();
  assert.ok(await waitFor(() => tap.getRolloutPath('hub-1') === real.rolloutPath), 'scanner binds the pinned file');
  await decoy.cleanup?.(); await real.cleanup?.();
});

test('an existing file binds immediately; rebind replaces a wrong guess only when asked', async t => {
  const { sessionsRoot, cwd, tap } = setup(t);
  const first = new FakeCodexRollout({ sessionsRoot, cwd, sid: '019ecccc-0000-7000-8000-00000000000c' });
  const second = new FakeCodexRollout({ sessionsRoot, cwd, sid: '019edddd-0000-7000-8000-00000000000d' });
  await first.start(); await second.start();
  tap.registerSession('hub-1', { cwd });
  assert.equal(await tap.bindFromHook('hub-1', { codexSid: first.sid, transcriptPath: first.rolloutPath }), true);
  assert.equal(tap.getRolloutPath('hub-1'), first.rolloutPath);
  assert.equal(await tap.bindFromHook('hub-1', { codexSid: second.sid, transcriptPath: second.rolloutPath }), false,
    'without rebind a different thread cannot take over');
  assert.equal(tap.getRolloutPath('hub-1'), first.rolloutPath);
  assert.equal(await tap.bindFromHook('hub-1', { codexSid: second.sid, transcriptPath: second.rolloutPath, rebind: true }), true);
  assert.equal(tap.getRolloutPath('hub-1'), second.rolloutPath);
  await first.cleanup?.(); await second.cleanup?.();
});

// 2026-09-25 真机：Codex /compact 写 task_started 与 last_agent_message 为空的 task_complete，
// 旧逻辑只在有正文时收尾，Hub 于是一直显示运行中。
test('a task_complete without an answer settles the turn without reporting a reply', async t => {
  const { sessionsRoot, cwd, tap } = setup(t);
  const rollout = new FakeCodexRollout({ sessionsRoot, cwd, sid: '019eeeee-0000-7000-8000-00000000000e' });
  await rollout.start();
  tap.registerSession('hub-1', { cwd });
  assert.equal(await tap.bindFromHook('hub-1', { codexSid: rollout.sid, transcriptPath: rollout.rolloutPath }), true);
  const completes = [], aborts = [];
  tap.on('turn-complete', ev => completes.push(ev));
  tap.on('turn-aborted', ev => aborts.push(ev));
  await rollout.writeRaw({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'compact-1' } });
  await rollout.writeRaw({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'compact-1', last_agent_message: null } });
  assert.ok(await waitFor(() => aborts.length === 1), 'the empty completion settles the turn');
  assert.equal(aborts[0].signalSource, 'task_complete_without_answer');
  assert.equal(aborts[0].turnId, 'compact-1');
  assert.equal(completes.length, 0, 'no reply card / unread for a turn without an answer');
  // 正常的一轮：final_answer 之后的空 task_complete 不能冲掉正文。
  await rollout.writeRaw({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } });
  await rollout.writeRaw({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-2',
    item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'ANSWER' }] } } });
  await rollout.writeRaw({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: null } });
  assert.ok(await waitFor(() => completes.length === 1));
  assert.equal(completes[0].text, 'ANSWER');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(completes.length, 1, 'reported once');
  await rollout.cleanup?.();
});
