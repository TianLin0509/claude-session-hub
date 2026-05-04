'use strict';
// B1.5 RED — 自动 + 手动 同时（同 tick 内）触发 → 只执行一次
// 比 B1.4 更严苛：B1.4 是顺序触发，B1.5 是几乎同时。
// 验证 settled 单 latch 在 race 条件下也是原子的。

const assert = require('assert');
const { EventEmitter } = require('events');
const { createTurnCompletionWatcher } = require('../core/turn-completion-watcher');

let failed = 0;

function _makeFakeTap() { return new EventEmitter(); }

// === case 1: 同 tick 自动 + 手动 → 只 resolve 一次 ===
async function testSameTickRaceOnlyOneWin() {
  const tap = _makeFakeTap();
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-race-1',
    label: 'pikachu',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  let resolveCount = 0;
  const p = watcher.wait().then((r) => { resolveCount++; return r; });

  // 同步同 tick：先 emit 后 manualExtract
  tap.emit('turn-complete', { hubSessionId: 'sid-race-1', text: 'auto-wins', signalSource: 'task_complete' });
  watcher.manualExtract('manual-loses');

  const result = await p;
  assert.strictEqual(resolveCount, 1, 'must resolve exactly once');
  assert.strictEqual(result.status, 'completed', 'auto wins (emit first)');
  assert.strictEqual(result.text, 'auto-wins');
  // 给 microtask 队列跑一会儿验证不二次 resolve
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(resolveCount, 1, 'still 1 after delay');
}

// === case 2: 同 tick 反向：先手动后自动 ===
async function testSameTickReverseOrder() {
  const tap = _makeFakeTap();
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-race-2',
    label: 'charmander',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  let resolveCount = 0;
  const p = watcher.wait().then((r) => { resolveCount++; return r; });

  watcher.manualExtract('manual-wins');
  tap.emit('turn-complete', { hubSessionId: 'sid-race-2', text: 'auto-loses', signalSource: 'task_complete' });

  const result = await p;
  assert.strictEqual(resolveCount, 1);
  assert.strictEqual(result.status, 'manual_extracted', 'manual wins (called first)');
  assert.strictEqual(result.text, 'manual-wins');
}

// === case 3: 跨 microtask 的 race：Promise.all 两条触发链 ===
async function testCrossMicrotaskRace() {
  const tap = _makeFakeTap();
  const watcher = createTurnCompletionWatcher({
    transcriptTap: tap,
    hubSessionId: 'sid-race-3',
    label: 'squirtle',
    softAlertT1Ms: 999_999,
    softAlertT2Ms: 999_999,
  });

  let resolveCount = 0;
  const p = watcher.wait().then((r) => { resolveCount++; return r; });

  await Promise.all([
    Promise.resolve().then(() => {
      tap.emit('turn-complete', { hubSessionId: 'sid-race-3', text: 'route-A', signalSource: 'task_complete' });
    }),
    Promise.resolve().then(() => {
      watcher.manualExtract('route-B');
    }),
  ]);

  const result = await p;
  assert.strictEqual(resolveCount, 1, 'cross-microtask race must still settle once');
  assert.ok(['completed', 'manual_extracted'].includes(result.status), 'either path is acceptable, but only one');
}

// === runner ===

const tests = [
  testSameTickRaceOnlyOneWin,
  testSameTickReverseOrder,
  testCrossMicrotaskRace,
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
