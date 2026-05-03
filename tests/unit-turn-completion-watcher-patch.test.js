'use strict';
// 锁定 turn-completion-watcher 的 patch-after-settle 行为（2026-05-03）
//
// 三类场景：
//   1. settle 后窗口内收到更长 emit → onTurnPatched 被调
//   2. cancelPatch() 被外部调用后 → 后续 emit 不再触发 onTurnPatched
//   3. signalSource=idle_timer / 短文本 / 同 text → 全部不触发
//
// 用 fake transcriptTap (EventEmitter) 模拟 turn-complete emit。

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher.js');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); process.exitCode = 1; }
}

function makeFakeTap() {
  const ee = new EventEmitter();
  ee.setMaxListeners(100);
  return ee;
}

console.log('Running turn-completion-watcher patch-after-settle tests...');

(async () => {

  await (async () => {
    const name = 'patch 路径：settle 后收到更长 emit → onTurnPatched 被调';
    try {
      const tap = makeFakeTap();
      const patches = [];
      const w = createTurnCompletionWatcher({
        transcriptTap: tap,
        hubSessionId: 'sid-A',
        label: 'Pikachu',
        softAlertT1Ms: 999_999,
        softAlertT2Ms: 999_999,
        onTurnPatched: (p) => patches.push(p),
      });
      const settlePromise = w.wait();
      // M1 emit → settle
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1 短答', signalSource: 'stop_reason_terminal' });
      const r = await settlePromise;
      assert.strictEqual(r.status, 'completed');
      assert.strictEqual(r.text, 'M1 短答');
      // 模拟 30s 后 M2 到达（更长）
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1 短答\n\nM2 真正答案 4647 字 ......', signalSource: 'stop_reason_terminal' });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(patches.length, 1, 'onTurnPatched 应被调一次');
      assert.strictEqual(patches[0].sid, 'sid-A');
      assert.ok(patches[0].text.length > r.text.length);
      assert.strictEqual(patches[0].status, 'completed');
      // cleanup
      w.cancelPatch();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  })();

  await (async () => {
    const name = '短文本 / 同 text / idle_timer 信号 → 不触发 onTurnPatched';
    try {
      const tap = makeFakeTap();
      const patches = [];
      const w = createTurnCompletionWatcher({
        transcriptTap: tap, hubSessionId: 'sid-A', label: 'A',
        softAlertT1Ms: 999_999, softAlertT2Ms: 999_999,
        onTurnPatched: (p) => patches.push(p),
      });
      const sp = w.wait();
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'long initial', signalSource: 'stop_reason_terminal' });
      await sp;
      // 同 text
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'long initial', signalSource: 'stop_reason_terminal' });
      // 更短
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'short', signalSource: 'stop_reason_terminal' });
      // idle_timer 信号源
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'long initial+more idle', signalSource: 'idle_timer_5s' });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(patches.length, 0, '三类信号都不应触发 onTurnPatched');
      w.cancelPatch();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  })();

  await (async () => {
    const name = 'cancelPatch() 被外部调后 → 后续 emit 不再触发';
    try {
      const tap = makeFakeTap();
      const patches = [];
      const w = createTurnCompletionWatcher({
        transcriptTap: tap, hubSessionId: 'sid-A', label: 'A',
        softAlertT1Ms: 999_999, softAlertT2Ms: 999_999,
        onTurnPatched: (p) => patches.push(p),
      });
      const sp = w.wait();
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1', signalSource: 'stop_reason_terminal' });
      await sp;
      w.cancelPatch();
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1 longer', signalSource: 'stop_reason_terminal' });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(patches.length, 0, 'cancelPatch 后不应触发');
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  })();

  await (async () => {
    const name = 'hubSessionId 不匹配的 emit → 不触发';
    try {
      const tap = makeFakeTap();
      const patches = [];
      const w = createTurnCompletionWatcher({
        transcriptTap: tap, hubSessionId: 'sid-A', label: 'A',
        softAlertT1Ms: 999_999, softAlertT2Ms: 999_999,
        onTurnPatched: (p) => patches.push(p),
      });
      const sp = w.wait();
      tap.emit('turn-complete', { hubSessionId: 'sid-A', text: 'M1', signalSource: 'stop_reason_terminal' });
      await sp;
      tap.emit('turn-complete', { hubSessionId: 'sid-OTHER', text: 'M1 longer', signalSource: 'stop_reason_terminal' });
      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(patches.length, 0);
      w.cancelPatch();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  })();

  const failed = process.exitCode || 0;
  console.log(`\n${failed ? '✗' : '✓'} turn-completion-watcher patch: tests done\n`);

})();
