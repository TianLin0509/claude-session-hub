'use strict';
// 窗口缩放兜底（core/window-scale-guard.js，2026-10-19）：只在窗口缩放和所在显示器不一致时动作，正常时只读不改。
//   node --test tests/unit-window-scale-guard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path');
const G = require('../core/window-scale-guard');

// 公司真机读数（125% 屏、2560×1440、任务栏 40 物理像素）：错的时候按 100% 排版，最大化窗口 2578×1398；对的时候 2064×1120。
const COMPANY_DISPLAY = { id: 1, scaleFactor: 1.25, workArea: { x: 0, y: 0, width: 2048, height: 1120 }, bounds: { x: 0, y: 0, width: 2048, height: 1152 } };
const BAD = { bounds: { x: -9, y: -9, width: 2578, height: 1398 }, maximized: true, visible: true, minimized: false, display: COMPANY_DISPLAY, windowScale: 1 };
const GOOD = { bounds: { x: -8, y: -8, width: 2064, height: 1136 }, maximized: true, visible: true, minimized: false, display: COMPANY_DISPLAY, windowScale: 1.25 };
// 本机实测（2.25 倍）：最大化 1720×926，工作区 1707×912
const HOME = { bounds: { x: -6, y: -6, width: 1720, height: 926 }, maximized: true, visible: true, display: { scaleFactor: 2.25, workArea: { x: 0, y: 0, width: 1707, height: 912 } }, windowScale: 2.25 };

test('判定：公司真机那次（按 100% 排版）判为不一致，两条判据都成立', () => {
  const m = G.detectScaleMismatch(BAD);
  assert.deepEqual(m.reasons, ['scale', 'maximized-oversize']);
  // 显示器参数也一样过时（都报 1.0）时只靠尺寸判不出来；等显示器参数更新（display-metrics-changed）后尺寸判据成立
  assert.equal(G.detectScaleMismatch({ ...BAD, display: { ...COMPANY_DISPLAY, scaleFactor: 1, workArea: { x: 0, y: 0, width: 2560, height: 1400 } } }), null);
  assert.deepEqual(G.detectScaleMismatch({ ...BAD, windowScale: 1.25 }).reasons, ['maximized-oversize']);
});

test('判定：正常读数（公司修好后、本机 2.25 倍、未最大化、页面缩放过）一律不动作', () => {
  assert.equal(G.detectScaleMismatch(GOOD), null);
  assert.equal(G.detectScaleMismatch(HOME), null);
  assert.equal(G.detectScaleMismatch({ ...GOOD, maximized: false, bounds: { x: 100, y: 100, width: 1200, height: 800 } }), null);
  assert.equal(G.detectScaleMismatch({ ...GOOD, windowScale: 1.25 * 1.01 }), null, '2% 以内的误差不算');
  assert.equal(G.detectScaleMismatch({ ...GOOD, windowScale: null }), null, '读不到页面缩放时只看尺寸');
  assert.equal(G.detectScaleMismatch({ ...BAD, minimized: true }), null, '最小化时不判断');
  assert.equal(G.detectScaleMismatch({ ...BAD, visible: false }), null, '不可见时不判断');
  assert.equal(G.detectScaleMismatch({}), null);
});

function fakeWin(state) {
  const w = new EventEmitter();
  w.calls = [];
  w.state = state;
  w.isDestroyed = () => false;
  w.unmaximize = () => w.calls.push('unmaximize');
  w.maximize = () => w.calls.push('maximize');
  w.setBounds = b => w.calls.push(['setBounds', b]);
  return w;
}
const immediate = (fn) => { fn(); return 0; };

test('兜底：不一致时做一次「取消最大化 → 按工作区 setBounds → 重新最大化」，复查一致就结束', async () => {
  const win = fakeWin(BAD);
  const screen = new EventEmitter();
  const logs = [];
  let reads = 0;
  const guard = G.installWindowScaleGuard(win, { screen, log: (e, d) => logs.push([e, d]), setTimeoutImpl: immediate, clearTimeoutImpl: () => {},
    read: async () => (reads++ === 0 ? BAD : GOOD) });
  const r = await guard.check('show');
  assert.equal(r.action, 'remaximize');
  assert.equal(r.after, 'ok');
  assert.deepEqual(win.calls, ['unmaximize', ['setBounds', { x: 0, y: 0, width: 2048, height: 1120 }], 'maximize']);
  assert.deepEqual(logs.map(x => x[0]), ['scale-probe', 'scale-mismatch-fixed', 'scale-recheck']);
  assert.equal(logs[2][1].ok, true);
});

test('兜底：正常时只记一条读数，不碰窗口；显示器变化、解锁时同样只读', async () => {
  const win = fakeWin(GOOD);
  const screen = new EventEmitter();
  const power = new EventEmitter();
  const logs = [];
  const timers = [];
  const guard = G.installWindowScaleGuard(win, { screen, powerMonitor: power, log: (e, d) => logs.push([e, d]), setTimeoutImpl: fn => { timers.push(fn); return timers.length; },
    clearTimeoutImpl: () => {}, read: async () => GOOD });
  win.emit('show');
  screen.emit('display-metrics-changed');
  power.emit('unlock-screen');
  for (const fn of timers.splice(0)) fn();
  await new Promise(r => setImmediate(r));
  assert.ok(await guard.check('manual') === null);
  assert.deepEqual(win.calls, [], '正常时不碰窗口');
  assert.deepEqual(logs.map(x => x[0]), ['scale-probe']);
  assert.equal(logs[0][1].mismatch, null);
});

test('兜底：一直不一致时最多动作 3 次，之后只记日志；复查仍不一致如实记下', async () => {
  const win = fakeWin(BAD);
  const logs = [];
  const guard = G.installWindowScaleGuard(win, { screen: new EventEmitter(), log: (e, d) => logs.push([e, d]), setTimeoutImpl: immediate, clearTimeoutImpl: () => {}, read: async () => BAD });
  for (let i = 0; i < 5; i++) await guard.check('display-changed');
  assert.equal(win.calls.filter(c => c === 'maximize').length, 3);
  assert.equal(logs.filter(x => x[0] === 'scale-mismatch-skipped').length, 2);
  assert.ok(logs.filter(x => x[0] === 'scale-recheck').every(x => x[1].ok === false));
});

test('兜底：没最大化的窗口按工作区收进来（一次 setBounds）', () => {
  const win = fakeWin(null);
  const action = G.applyScaleFix(win, { maximized: false, bounds: { x: 1500, y: 900, width: 2578, height: 1398 }, display: COMPANY_DISPLAY });
  assert.equal(action, 'setbounds');
  assert.deepEqual(win.calls, [['setBounds', { x: 0, y: 0, width: 2048, height: 1120 }]]);
});

test('契约：主窗口装了兜底；测试窗口默认不装，隔离实例显式打开才装', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/core\/window-scale-guard\.js'\)\.installWindowScaleGuard\(mainWindow,/);
  assert.match(main, /e2eScaleGuard = isIsolatedHub\(\) && process\.env\.CLAUDE_HUB_E2E_SCALE_GUARD === '1'/);
  assert.match(main, /if \(e2eScaleGuard \|\| \(!mainWindow\.__hubBackgroundE2E && !keepIsolatedE2EWindowHidden\(\)\)\)/);
});
