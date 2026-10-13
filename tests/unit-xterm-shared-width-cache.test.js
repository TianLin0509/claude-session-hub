'use strict';
// 终端测字宽（2026-10-13 侧栏切换卡顿）：隐藏时不白量、所有终端共用一份字宽表、结构不对就不装。
const assert = require('assert');
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('  ✓ ' + name); } catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e.stack || e.message)); } }

function fakeXterm({ rects = 1 } = {}) {
  const calls = [];
  class WidthCache {
    constructor() { this._font = 'Consolas'; this._fontSize = 14; this._weight = 'normal'; this._weightBold = 'bold';
      this._container = { isConnected: true, getClientRects: () => ({ length: rects }) }; }
    _measure(text, variant) { calls.push(text + variant); return 8 * text.length; }
  }
  const cache = new WidthCache();
  return { terminal: { _core: { _renderService: { _renderer: { value: { _widthCache: cache } } } } }, cache, calls, WidthCache };
}

(async () => {
  global.window = { devicePixelRatio: 2 };
  const fresh = () => { delete require.cache[require.resolve('../renderer/xterm-shared-width-cache.js')]; return require('../renderer/xterm-shared-width-cache.js'); };

  await test('隐藏的终端不再逐字强制排版：同一段同步代码里只查一次是否渲染，直接返回 0（与原来量出的结果相同）', async () => {
    const mod = fresh(); const x = fakeXterm({ rects: 0 });
    assert.strictEqual(mod.installSharedWidthCache(x.terminal, {}), true);
    for (const ch of '物理层下行先做同步') assert.strictEqual(x.cache._measure(ch, 0), 0);
    assert.strictEqual(x.calls.length, 0);
    assert.strictEqual(mod.sharedWidthCacheStats().skippedHidden, 9);
  });

  await test('看得见时照常测量；量到的宽度所有终端共用，第二个终端不再重量', async () => {
    const mod = fresh(); const x = fakeXterm();
    mod.installSharedWidthCache(x.terminal, {});
    assert.strictEqual(x.cache._measure('中', 0), 8);
    const other = new x.WidthCache();
    assert.strictEqual(other._measure('中', 0), 8);
    assert.strictEqual(x.calls.length, 1);
    other._fontSize = 16; other._measure('中', 0);
    assert.strictEqual(x.calls.length, 2, '字号不同要重新量');
    window.devicePixelRatio = 1; other._measure('中', 0); window.devicePixelRatio = 2;
    assert.strictEqual(x.calls.length, 3, '屏幕缩放不同要重新量');
  });

  await test('隐藏判定只在当前同步代码内有效：终端显示出来后马上恢复测量', async () => {
    const mod = fresh(); const x = fakeXterm({ rects: 0 });
    mod.installSharedWidthCache(x.terminal, {});
    assert.strictEqual(x.cache._measure('A', 0), 0);
    assert.strictEqual(x.calls.length, 0);
    x.cache._container.getClientRects = () => ({ length: 1 });
    assert.strictEqual(x.cache._measure('B', 0), 0, '同一段同步代码里沿用「隐藏」判定');
    await Promise.resolve(); await Promise.resolve();
    x.cache._measure('C', 0);
    assert.deepStrictEqual(x.calls, ['C0'], '下一段代码重新判定，看得见就真的去量');
  });
  await test('结构对不上（xterm 升级）或关掉开关时不装，行为不变', async () => {
    let mod = fresh();
    assert.strictEqual(mod.installSharedWidthCache({ _core: {} }, {}), false);
    mod = fresh(); const x = fakeXterm();
    assert.strictEqual(mod.installSharedWidthCache(x.terminal, { HUB_DISABLE_SHARED_WIDTH_CACHE: '1' }), false);
    assert.strictEqual(x.WidthCache.prototype.__hubSharedWidth, undefined);
  });

  await test('renderer 在终端打开处安装（与隐藏终端重画闸门同一位置）', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../renderer/renderer.js'), 'utf8');
    assert.strictEqual((src.match(/installSharedWidthCache\(cached\.terminal\)/g) || []).length, 2);
  });

  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('unit-xterm-shared-width-cache: all passed');
})();
