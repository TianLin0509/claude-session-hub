'use strict';
// 锁定 roundtable-watcher 的自动恢复 + resendCurrentPrompt 行为（2026-05-03）
//
// _autoRecoverSend：
//   echoSeen=true  → 仅 writeToSession('\r')，1 次
//   echoSeen=false → writeToSession(prompt) + writeToSession('\r')
//   verify 失败：返回 false
//   verify 成功：返回 true
//
// resendCurrentPrompt：
//   ring buffer 含 promptHeader → mode='enter_only'，仅 writeToSession('\r')
//   ring buffer 不含           → mode='rewrite_full'，写 prompt + '\r'

const assert = require('assert');
const path = require('path');

const rtWatcher = require('../core/roundtable-watcher.js');

function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => console.log(`  ✓ ${name}`),
    e => { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
  );
}

function makeFakeSm(initialActivity = 100, opts = {}) {
  const writes = [];
  let activity = initialActivity;
  return {
    writes,
    writeToSession(sid, data) {
      writes.push({ sid, data });
      // 模拟 echo：除非 mockSilent 设了，每次写入 stdout 涨
      if (!opts.mockSilent) activity += String(data).length;
    },
    getRoundtableLastActivity() { return activity; },
    bumpActivity(n) { activity += n; },
    getSessionBuffer(_sid) { return opts.bufferText || ''; },
    setRoundtableReady() {},
    getRoundtableReady() { return true; },
  };
}

console.log('Running roundtable-watcher resend tests...');

(async () => {

  await test('_autoRecoverSend echoSeen=true → 仅写 \\r 一次，verify 通过', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const recovered = await rtWatcher._autoRecoverSend({
      sid: 'sid-A', kind: 'claude', prompt: 'hello', echoSeen: true,
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(recovered, true);
    assert.strictEqual(sm.writes.length, 1, '仅 1 次 write');
    assert.strictEqual(sm.writes[0].data, '\r');
  });

  await test('_autoRecoverSend echoSeen=false → 写 prompt + \\r 两次', async () => {
    const sm = makeFakeSm();
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const recovered = await rtWatcher._autoRecoverSend({
      sid: 'sid-A', kind: 'claude', prompt: 'hello world', echoSeen: false,
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(recovered, true);
    assert.strictEqual(sm.writes.length, 2);
    assert.strictEqual(sm.writes[0].data, 'hello world');
    assert.strictEqual(sm.writes[1].data, '\r');
  });

  await test('_autoRecoverSend verify 失败 → 返回 false', async () => {
    const sm = makeFakeSm(100, { mockSilent: true });  // 写入后 activity 不动
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const recovered = await rtWatcher._autoRecoverSend({
      sid: 'sid-A', kind: 'claude', prompt: 'hi', echoSeen: true,
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(recovered, false);
  });

  await test('resendCurrentPrompt 输入框已含 prompt → mode=enter_only', async () => {
    const sm = makeFakeSm(100, { bufferText: '$ user\n[research · 第 3 轮 · 默认提问]\n## ...' });
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.resendCurrentPrompt({
      sid: 'sid-A', kind: 'claude',
      prompt: '[research · 第 3 轮 · 默认提问]\n## 用户问题\n请分析',
      promptHeader: '[research · 第 3 轮 · 默认提问]',
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'enter_only');
    assert.strictEqual(sm.writes.length, 1);
    assert.strictEqual(sm.writes[0].data, '\r');
  });

  await test('resendCurrentPrompt 输入框不含 prompt → mode=rewrite_full', async () => {
    const sm = makeFakeSm(100, { bufferText: '$ \n(no prompt yet)\n' });
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.resendCurrentPrompt({
      sid: 'sid-A', kind: 'claude',
      prompt: '[research · 第 3 轮 · 默认提问]\nL2',
      promptHeader: '[research · 第 3 轮 · 默认提问]',
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.mode, 'rewrite_full');
    assert.strictEqual(sm.writes.length, 2);
    assert.strictEqual(sm.writes[0].data, '[research · 第 3 轮 · 默认提问]\nL2');
    assert.strictEqual(sm.writes[1].data, '\r');
  });

  await test('resendCurrentPrompt promptHeader 空 → 退化为 rewrite_full（保守）', async () => {
    const sm = makeFakeSm(100, { bufferText: 'whatever' });
    rtWatcher.init({ sessionManager: sm, cliReadyDetector: { isReady: () => true } });
    const r = await rtWatcher.resendCurrentPrompt({
      sid: 'sid-A', kind: 'claude',
      prompt: 'just text',
      promptHeader: '',  // empty
      timing: { ENTER_RETRY_GAP_MS: 10, POST_ENTER_VERIFY_MS: 30 },
    });
    assert.strictEqual(r.mode, 'rewrite_full');
  });

  console.log('\n✓ roundtable-watcher resend: tests done\n');
})();
