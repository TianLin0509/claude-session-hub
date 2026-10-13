'use strict';
// 卡片视图下暂停卡片后面终端的绘制（2026-10-13 公司版卡顿）：暂停、xterm 自动解除时仍保持暂停、恢复时补画、接入点、可关。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let failed = 0;
function test(name, fn) { try { fn(); console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message)); } }
const { setBehindCardsPaused, cardPauseStats } = require('../renderer/xterm-card-pause.js');

function fakeTerminal() {
  const refreshed = [];
  const rs = { _isPaused: false, _handleIntersectionChange(entry) { this._isPaused = !entry.isIntersecting; } };
  return { rows: 30, refreshed, rs, refresh: (a, b) => refreshed.push([a, b]), _core: { _renderService: rs } };
}

test('暂停：卡片视图里终端不再绘制；xterm 因为「在可视区域」想自动恢复时仍保持暂停', () => {
  const t = fakeTerminal();
  assert.strictEqual(setBehindCardsPaused(t, true, { env: {} }), true);
  assert.strictEqual(t.rs._isPaused, true);
  t.rs._handleIntersectionChange({ isIntersecting: true });
  assert.strictEqual(t.rs._isPaused, true);
});

test('恢复：解除暂停并整屏补画一次；重复恢复不再补画', () => {
  const t = fakeTerminal();
  setBehindCardsPaused(t, true, { env: {} });
  setBehindCardsPaused(t, false, { env: {} });
  assert.strictEqual(t.rs._isPaused, false);
  assert.deepStrictEqual(t.refreshed, [[0, 29]]);
  setBehindCardsPaused(t, false, { env: {} });
  assert.strictEqual(t.refreshed.length, 1);
  t.rs._handleIntersectionChange({ isIntersecting: false });
  assert.strictEqual(t.rs._isPaused, true, '恢复后 xterm 照常按可视区域自己暂停');
  assert.deepStrictEqual(cardPauseStats(t), { on: false, paused: 1, resumed: 1, isPaused: true });
});

test('进后台走自己的整屏恢复时不重复补画（refresh:false）', () => {
  const t = fakeTerminal();
  setBehindCardsPaused(t, true, { env: {} });
  setBehindCardsPaused(t, false, { refresh: false, env: {} });
  assert.strictEqual(t.rs._isPaused, false);
  assert.strictEqual(t.refreshed.length, 0);
});

test('隐藏期间记下的选区，恢复时一起补上', () => {
  const t = fakeTerminal();
  const calls = [];
  t.rs.__hubHiddenGuard = { pending: [[1, 2], [3, 4], false], replayed: 0 };
  t.rs.handleSelectionChanged = (...a) => calls.push(a);
  setBehindCardsPaused(t, true, { env: {} });
  setBehindCardsPaused(t, false, { env: {} });
  assert.deepStrictEqual(calls, [[[1, 2], [3, 4], false]]);
  assert.strictEqual(t.rs.__hubHiddenGuard.pending, null);
});

test('xterm 结构对不上或关掉开关：什么都不做', () => {
  assert.strictEqual(setBehindCardsPaused({ _core: {} }, true, { env: {} }), false);
  const t = fakeTerminal();
  assert.strictEqual(setBehindCardsPaused(t, true, { env: { HUB_DISABLE_CARD_PAUSE: '1' } }), false);
  assert.strictEqual(t.rs._isPaused, false);
});

test('接入点：卡片视图暂停、进后台恢复（不重复补画）、打开终端时按当前视图决定；问题导航隐藏时不量布局', () => {
  const src = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  assert.match(src, /mode === 'card' && BACKSTAGE_KEEPS_TERMINAL[\s\S]{0,120}setBehindCardsPaused\(terminalCache\.get\(activeSessionId\)\?\.terminal, true\)/);
  assert.match(src, /setCardHiddenTerminal\(cached, false\);\s*setBehindCardsPaused\(cached\.terminal, false, \{ refresh: false \}\);/);
  assert.match(src, /if \(!embedded && BACKSTAGE_KEEPS_TERMINAL\) setBehindCardsPaused\(cached\.terminal, currentView === 'card'\);/);
  const nav = fs.readFileSync(path.join(__dirname, '../renderer/card-question-navigator.js'), 'utf8');
  assert.match(nav, /if \(visible\) updateLayout\(\);/);
  const card = fs.readFileSync(path.join(__dirname, '../renderer/xterm-card-pause.js'), 'utf8');
  assert(card.indexOf('prewarmViewportWidths') < card.indexOf('handleSelectionChanged(...pending)'), '先批量预量再补画');
});

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('unit-xterm-card-pause: all passed');
