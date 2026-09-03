'use strict';
// 归档提示不再自动弹全局模态（2026-07-29 用户要求）。
//
// 旧行为：某个 session/群聊首轮一结束，maybePromptArchive 直接 openArchiveContext，
// 把归档框糊到用户脸上。问题有两层：
//   1. 模态是全局的，不属于任何 session —— 可能弹在用户当时根本没在看的那个会话上；
//   2. 首轮刚出结果正是用户在读的时候，打断感很强。
// 新行为：只记下建议并广播事件，由 workspace chip 显示一个轻标记（琥珀边 + 小圆点），
// 用户点 chip 才打开归档框；不点就不打扰，也不再追问。

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CTRL_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'workspace-controller.js'), 'utf8');
const ROOM_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
const CSS_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles', 'meeting-room-base.css'), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error && error.message)); }
}

console.log('Running archive suggestion (no auto-modal) tests...');

test('maybePromptArchive 不再直接打开归档框', () => {
  const start = CTRL_SRC.indexOf('async function maybePromptArchive(');
  assert.ok(start > 0, '找不到 maybePromptArchive');
  const body = CTRL_SRC.slice(start, CTRL_SRC.indexOf('\n  }', start));
  assert.ok(!/else openArchiveContext\(context\)/.test(body),
    'maybePromptArchive 不允许再自动 openArchiveContext —— 那是全局模态');
  assert.ok(body.includes('archiveSuggestions.set'), '应改为记录建议');
  assert.ok(body.includes('workspace-archive-suggestion'), '应广播事件供 UI 显示轻提示');
});

test('对外暴露查询/打开/清除建议的接口', () => {
  for (const api of ['getArchiveSuggestion', 'hasArchiveSuggestion', 'openArchiveSuggestion', 'dismissArchiveSuggestion']) {
    assert.ok(CTRL_SRC.includes(api + ':'), `WorkspaceController 缺少 ${api}`);
  }
});

test('openArchiveSuggestion 没有建议时返回 false，不空开一个框', () => {
  const start = CTRL_SRC.indexOf('openArchiveSuggestion: (scope, id) =>');
  assert.ok(start > 0);
  const body = CTRL_SRC.slice(start, start + 320);
  assert.ok(/if \(!context\) return false;/.test(body), '无建议必须直接返回 false');
});

// 2026-07-29 P1-2：这段逻辑原来只写在群聊侧，独立会话的建议进了没人读的 Map。
// 修复方式是把它抽成 WorkspaceController.attachArchiveHint，群聊 chip 与独立会话
// header 的 📁 路径共用同一个实现 —— 所以这里只检查「两处都接到同一根线上」，
// 具体行为（点亮 / 打开归档框 / 无建议时回落复制）由 unit-archive-session-chip
// 真跑一遍 controller 来验，不再做逐行文本断言。
test('归档提示由 attachArchiveHint 统一提供，群聊与独立会话都接上了', () => {
  assert.ok(/attachArchiveHint,/.test(CTRL_SRC), 'WorkspaceController 必须导出 attachArchiveHint');
  assert.ok(/function attachArchiveHint\(/.test(CTRL_SRC), '共用实现应当只有一处');

  const start = ROOM_SRC.indexOf("const workspaceChip = document.getElementById('mr-workspace-chip')");
  assert.ok(start > 0, '找不到 workspace chip 绑定');
  const block = ROOM_SRC.slice(start, start + 1400);
  assert.ok(block.includes("attachArchiveHint(workspaceChip, 'meeting'"), '群聊 chip 必须走共用实现');
  // 没有建议时按当前产品约定直接打开工作目录。
  assert.ok(block.includes('openPathInHub'), '无建议时应打开工作目录');

  const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.ok(RENDERER_SRC.includes("attachArchiveHint(a, 'session', session.id"),
    '独立会话 header 的 📁 路径也必须接上同一根线（P1-2 断链点）');
  assert.ok(/workspace-archive-suggestion/.test(RENDERER_SRC),
    'renderer 需要监听建议到达，否则要等下一个 status-event 才点亮');
});

test('建议到达时刷新 header，但不弹任何东西', () => {
  const start = ROOM_SRC.indexOf("window.addEventListener('workspace-archive-suggestion'");
  assert.ok(start > 0, '缺少建议到达的监听');
  const block = ROOM_SRC.slice(start, start + 520);
  assert.ok(block.includes('renderHeader'), '应重画 header 点亮 chip');
  assert.ok(!/open|modal|show/i.test(block.replace(/renderHeader|meetingData|activeMeetingId/g, '')),
    '监听里不允许出现任何打开弹窗的动作');
  assert.ok(block.includes('detail.id !== activeMeetingId'),
    '只对当前正在看的群聊刷新，避免给用户没在看的会话做无意义重绘');
});

test('提示样式存在且是「轻」的（不用动画/不遮挡）', () => {
  assert.ok(CSS_SRC.includes('.mr-workspace-chip.has-archive-hint'), '缺少提示态样式');
  const start = CSS_SRC.indexOf('.mr-workspace-chip.has-archive-hint');
  const block = CSS_SRC.slice(start, start + 700);
  assert.ok(!/animation|@keyframes|position:\s*fixed/.test(block),
    '提示必须是静态轻标记，不许闪烁或浮层遮挡');
});

if (failed > 0) {
  console.error(`archive suggestion: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('All archive suggestion tests passed.');
}
