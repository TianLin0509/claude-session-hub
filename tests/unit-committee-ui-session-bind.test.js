'use strict';
/**
 * [投委会浮窗绑定 session] 单测（2026-06-29 道雪）——真实执行 committee-ui.js 的 syncActiveMeeting，
 * 验证浮窗只在所属投研 session 被查看时显示、切到别的 session 隐藏、切回恢复（最小 DOM mock，无 jsdom 依赖）。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// ── 最小 DOM mock（committee-ui.js 需要 document/window 才能 load + 渲染浮窗）──
const created = [];
function mkEl() {
  return {
    style: {}, className: '', innerHTML: '', dataset: {},
    appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    setAttribute() {}, getAttribute() { return null; }, focus() {}, closest() { return null; },
  };
}
global.document = {
  createElement() { const el = mkEl(); created.push(el); return el; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {}, removeEventListener() {},
};
global.window = { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} };

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name); console.error('    ' + (e.stack || e.message)); }
}

console.log('--- 投委会浮窗绑定 session ---');

// 真实 require + 执行 committee-ui.js（IIFE 注册 window.committeeUI）
require(path.join(__dirname, '..', 'renderer', 'committee-ui.js'));
const ui = global.window.committeeUI;

test('committee-ui 暴露 syncActiveMeeting', () => {
  assert.ok(ui && typeof ui.syncActiveMeeting === 'function', 'syncActiveMeeting 已导出');
});

test('浮窗只在所属 session 被查看时显示，切到别的 session 隐藏，切回恢复（真实 display 切换）', () => {
  created.length = 0;
  ui.closePanel();                                                    // 清掉上个用例的浮窗单例，干净隔离
  ui.showModal({ id: 'meeting-A' });                                   // _meetingId=A, _activeMeetingId=A
  ui.onProgress({ meetingId: 'meeting-A', type: 'act', act: '立会' }); // 创建 _panelEl
  const panel = created.find(e => e.className === 'cm-panel');
  assert.ok(panel, '投委会浮窗已创建（cm-panel）');
  assert.strictEqual(panel.style.display, '', '看 session A（浮窗所属）→ 浮窗显示');

  ui.syncActiveMeeting('meeting-B');                                   // 用户切到 session B
  assert.strictEqual(panel.style.display, 'none', '切到 session B → 浮窗隐藏（不再盖在别的 session 上）');

  ui.syncActiveMeeting('meeting-A');                                   // 切回 A
  assert.strictEqual(panel.style.display, '', '切回 session A → 浮窗恢复显示');

  ui.syncActiveMeeting(null);                                          // 离开群聊
  assert.strictEqual(panel.style.display, 'none', '离开群聊 → 浮窗隐藏');
});

test('非所属 session 的投委会进度到来时，浮窗后台创建但保持隐藏（不打扰当前 session）', () => {
  created.length = 0;
  ui.closePanel();                                                    // 清掉上个用例的浮窗单例，干净隔离
  ui.showModal({ id: 'meeting-A' });
  ui.syncActiveMeeting('meeting-B');                                   // 用户当前看 B
  ui.onProgress({ meetingId: 'meeting-A', type: 'act', act: '建库' }); // A 的进度
  const panel = created.find(e => e.className === 'cm-panel');
  assert.ok(panel, '浮窗仍创建（_liveState 后台更新不丢进度）');
  assert.strictEqual(panel.style.display, 'none', '但当前看 B → A 的浮窗保持隐藏');
});

// ── meeting-room 调用链路（静态契约）──
const mr = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
test('meeting-room 切入 session 通知 syncActiveMeeting(meetingId)、离开通知 syncActiveMeeting(null)', () => {
  assert.ok(/syncActiveMeeting\(meetingId\)/.test(mr), 'openMeeting 调 syncActiveMeeting(meetingId)');
  assert.ok(/syncActiveMeeting\(null\)/.test(mr), 'closeMeetingPanel 调 syncActiveMeeting(null)');
});

console.log(`\n${failed === 0 ? 'OK 全绿' : 'FAIL ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
