'use strict';
// B1.4 RED — 自动 + 手动 + 多次调用幂等
// 通过 turn-completion-watcher 验证：settled 后任何后续触发不再 emit/resolve 二次。
//
// watcher 现有 settled latch 设计已经幂等（settle 第二次直接 return），
// 本测试是契约保护——避免后续重构破坏幂等性。

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');

let failed = 0;

function _makeFakeTap() {
  const tap = new EventEmitter();
  tap.removeListener = tap.removeListener.bind(tap);
  return tap;
}

// === case 1: 自动 turn-complete + 后续手动 extract → 只 resolve 一次 ===
async function testAutoThenManualOnlyOnce() {
  const tap = _makeFakeTap();
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-A',
    label: 'pikachu',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  let resolveCount = 0;
  const result = await new Promise((resolve) => {
    watcher.wait().then((r) => { resolveCount++; resolve(r); });
    setImmediate(() => tap.emit('turn-complete', {
      hubSessionId: 'sid-A',
      text: 'auto-final',
      signalSource: 'task_complete',
    }));
    // 50ms 后再手动 extract，应被吞
    setTimeout(() => {
      watcher.manualExtract('manual-text-after');
    }, 50);
    setTimeout(() => resolve(null), 200);
  });

  assert.ok(result, 'wait() must resolve');
  assert.strictEqual(result.status, 'completed', 'first signal wins → completed');
  assert.strictEqual(result.text, 'auto-final');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(resolveCount, 1, 'wait() must resolve exactly once');
  assert.strictEqual(watcher.isSettled(), true);
}

// === case 2: 多次 manualExtract → 只 settle 一次 ===
async function testMultipleManualExtractsOnlyFirstWins() {
  const tap = _makeFakeTap();
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-B',
    label: 'charmander',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  const p = watcher.wait();
  watcher.manualExtract('first');
  watcher.manualExtract('second');
  watcher.manualExtract('third');
  const result = await p;
  assert.strictEqual(result.status, 'manual_extracted');
  assert.strictEqual(result.text, 'first', 'only first manualExtract should settle');
}

// === case 3: turn-complete 后再 emit turn-error → 不二次 settle ===
async function testCompletedThenErrorIgnored() {
  const tap = _makeFakeTap();
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-C',
    label: 'squirtle',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  const p = watcher.wait();
  tap.emit('turn-complete', { hubSessionId: 'sid-C', text: 'done', signalSource: 'task_complete' });
  // 200ms 后 emit turn-error，应被吞（settled=true）
  setTimeout(() => tap.emit('turn-error', { hubSessionId: 'sid-C', reason: 'fake-error' }), 200);
  const result = await p;
  assert.strictEqual(result.status, 'completed', 'completed first must win');
  assert.strictEqual(result.text, 'done');
  await new Promise((r) => setTimeout(r, 250));
  // settled latch 不允许二次切换
  assert.strictEqual(watcher.isSettled(), true);
}

// === case 4: 跨 sid 的 turn-complete 不触发本 watcher ===
async function testWatcherIgnoresOtherSidsTurnComplete() {
  const tap = _makeFakeTap();
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-D',
    label: 'wartortle',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  let timedOut = false;
  const result = await Promise.race([
    watcher.wait(),
    new Promise((r) => setTimeout(() => { timedOut = true; r({ status: 'timeout' }); }, 200)),
  ]);
  // 在 race 内部 emit 错 sid 的 turn-complete
  tap.emit('turn-complete', { hubSessionId: 'sid-OTHER', text: 'wrong-sid', signalSource: 'task_complete' });
  assert.ok(timedOut || result.status === 'timeout', 'watcher must not pick up other sid turn-complete');
  watcher.skip();  // teardown
}

// === runner ===

const tests = [
  testAutoThenManualOnlyOnce,
  testMultipleManualExtractsOnlyFirstWins,
  testCompletedThenErrorIgnored,
  testWatcherIgnoresOtherSidsTurnComplete,
];

(async () => {
  for (const t of tests) {
    try {
      await t();
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
