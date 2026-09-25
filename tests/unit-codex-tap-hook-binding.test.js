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
