'use strict';
// 看不见的终端不整屏重画（renderer/xterm-hidden-render-guard.js）：暂停时拦下、可见时用最后一次选区补画一次；
// xterm 内部结构不认识就原样放行。真实界面逐行核对见 tests/e2e-hidden-terminal-render-guard.js。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { installHiddenRenderGuard } = require('../renderer/xterm-hidden-render-guard');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }

function fakeTerminal() {
  const calls = [];
  const rs = {
    _isPaused: false,
    _selectionState: { start: undefined, end: undefined, columnSelectMode: false },
    handleSelectionChanged(start, end, mode) {
      this._selectionState.start = start; this._selectionState.end = end; this._selectionState.columnSelectMode = mode;
      calls.push(['render', start, end, mode]);
    },
    _handleIntersectionChange(entry) { this._isPaused = !entry.isIntersecting; calls.push(['intersect', entry.isIntersecting]); },
  };
  return { terminal: { _core: { _renderService: rs } }, rs, calls };
}

test('可见时照常重画', () => {
  const { terminal, rs, calls } = fakeTerminal();
  assert.strictEqual(installHiddenRenderGuard(terminal, {}), true);
  rs.handleSelectionChanged([0, 1], [3, 1], false);
  assert.deepStrictEqual(calls, [['render', [0, 1], [3, 1], false]]);
});

test('暂停时只记状态不重画，恢复可见时用最后一次选区补画一次', () => {
  const { terminal, rs, calls } = fakeTerminal();
  installHiddenRenderGuard(terminal, {});
  rs._handleIntersectionChange({ isIntersecting: false });
  rs.handleSelectionChanged(undefined, undefined, false);
  rs.handleSelectionChanged([2, 0], [5, 0], true);
  assert.deepStrictEqual(calls.filter(c => c[0] === 'render'), [], 'nothing rendered while hidden');
  assert.deepStrictEqual(rs._selectionState, { start: [2, 0], end: [5, 0], columnSelectMode: true }, 'selection state kept current');
  rs._handleIntersectionChange({ isIntersecting: true });
  assert.deepStrictEqual(calls.filter(c => c[0] === 'render'), [['render', [2, 0], [5, 0], true]], 'one replay with the latest selection');
  assert.deepStrictEqual(rs.__hubHiddenGuard, { skipped: 2, replayed: 1, pending: null });
  rs._handleIntersectionChange({ isIntersecting: true });
  assert.strictEqual(calls.filter(c => c[0] === 'render').length, 1, 'no second replay');
});

test('不认识的结构、重复安装、关闭开关都原样放行', () => {
  assert.strictEqual(installHiddenRenderGuard({ _core: {} }, {}), false);
  assert.strictEqual(installHiddenRenderGuard(null, {}), false);
  const { terminal } = fakeTerminal();
  assert.strictEqual(installHiddenRenderGuard(terminal, {}), true);
  assert.strictEqual(installHiddenRenderGuard(terminal, {}), false);
  const other = fakeTerminal();
  assert.strictEqual(installHiddenRenderGuard(other.terminal, { HUB_DISABLE_HIDDEN_RENDER_GUARD: '1' }), false);
  assert.strictEqual(other.rs.__hubHiddenGuard, undefined);
});

test('xterm 5.5 里被包住的两个内部方法确实存在，主界面两处打开终端的地方都装了闸门', () => {
  const bundle = fs.readFileSync(require.resolve('@xterm/xterm/lib/xterm.js'), 'utf8');
  assert.ok(bundle.includes('handleSelectionChanged(e,t,i){this._selectionState.start=e'), 'RenderService.handleSelectionChanged');
  assert.ok(bundle.includes('_handleIntersectionChange(e){this._isPaused='), 'RenderService._handleIntersectionChange');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.strictEqual((src.match(/installHiddenRenderGuard\(cached\.terminal\)/g) || []).length, 2);
});

console.log(`unit-xterm-hidden-render-guard: ${passed} passed`);
