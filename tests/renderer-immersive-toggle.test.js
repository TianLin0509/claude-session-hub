'use strict';
// Task 9（2026-05-01）单测：沉浸/调试模式切换契约。
//
// 锁定不变量（静态分析）：
// 1. button id=meeting-room-mode-toggle，class=mr-immersive-toggle（不是 mr-mode-btn——会和"圆桌/投研"撞）
// 2. #mr-shell-area wrapper 存在（包裹 mr-terminals + mr-toolbar + 输入区）
// 3. _toggleMeetingMode / _applyMeetingMode / _restoreMeetingMode 三个函数定义
// 4. CSS 含 .mr-immersive-toggle.active + #meeting-room-panel.immersive #mr-shell-area
// 5. main.js 含 ipcMain.handle('save-immersive-mode') + ipcMain.handle('get-immersive-mode')
// 6. state-store.js load() normalize immersiveByMeeting 字段
// 7. main.js stateStore.save 调用都带 immersiveByMeeting

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running immersive/debug mode toggle tests...');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf-8');
const JS = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-room.js'), 'utf-8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-room.css'), 'utf-8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
const STATE_STORE = fs.readFileSync(path.join(ROOT, 'core', 'state-store.js'), 'utf-8');

test('index.html 不再含 #mr-shell-area wrapper（fix：toolbar/input 必须固定底部）', () => {
  assert.ok(!/id="mr-shell-area"/.test(HTML),
    'mr-shell-area wrapper 已移除（包装会破坏 panel flex column 布局，导致 toolbar/input 错位）');
  // mr-terminals + mr-toolbar + mr-input-row 必须仍存在，且都是 panel 直接子级
  assert.match(HTML, /id="mr-terminals"/);
  assert.match(HTML, /id="mr-toolbar"/);
  assert.match(HTML, /id="mr-input-row"/);
});

test('meeting-room.js renderHeader 注入 immersive button（id+class 正确）', () => {
  // renderHeader 模板里含 id="meeting-room-mode-toggle" + class="mr-immersive-toggle"
  assert.match(JS, /id="meeting-room-mode-toggle"/);
  assert.match(JS, /class="mr-immersive-toggle"/);
});

test('button class 严禁复用 mr-mode-btn（与圆桌/投研 toggle 冲突）', () => {
  // immersive button 的代码段不含 mr-mode-btn class
  // 找到 immersive button 的字面量上下文
  const idx = JS.indexOf('id="meeting-room-mode-toggle"');
  assert.ok(idx > 0);
  // 取该 button 起止：往回搜 <button，往前搜 </button>
  const btnOpen = JS.lastIndexOf('<button', idx);
  const btnClose = JS.indexOf('</button>', idx);
  assert.ok(btnOpen >= 0 && btnClose > idx);
  const btnHtml = JS.slice(btnOpen, btnClose + 9);
  assert.ok(!/mr-mode-btn/.test(btnHtml), `immersive button must NOT carry mr-mode-btn class. Got: ${btnHtml}`);
});

test('_toggleMeetingMode / _applyMeetingMode / _restoreMeetingMode 三个函数都定义', () => {
  assert.match(JS, /function\s+_toggleMeetingMode\s*\(/);
  assert.match(JS, /function\s+_applyMeetingMode\s*\(/);
  assert.match(JS, /function\s+_restoreMeetingMode\s*\(/);
});

test('_toggleMeetingMode 调 ipcRenderer.invoke save-immersive-mode', () => {
  const start = JS.indexOf('function _toggleMeetingMode');
  const end = JS.indexOf('function _applyMeetingMode', start);
  assert.ok(start > 0 && end > start);
  const body = JS.slice(start, end);
  assert.match(body, /ipcRenderer\.invoke\s*\(\s*['"]save-immersive-mode['"]/);
});

test('_restoreMeetingMode 调 ipcRenderer.invoke get-immersive-mode', () => {
  const start = JS.indexOf('function _restoreMeetingMode');
  // 找下一个函数或 closeMeetingPanel/getActiveMeetingId
  const cands = ['function getActiveMeetingId', 'function closeMeetingPanel', '\n  function '];
  let end = JS.length;
  for (const c of cands) {
    const i = JS.indexOf(c, start + 30);
    if (i > 0 && i < end) end = i;
  }
  const body = JS.slice(start, end);
  assert.match(body, /ipcRenderer\.invoke\s*\(\s*['"]get-immersive-mode['"]/);
});

test('openMeeting 调 _restoreMeetingMode', () => {
  const start = JS.indexOf('function openMeeting');
  const end = JS.indexOf('function closeMeetingPanel', start);
  assert.ok(start > 0 && end > start);
  const body = JS.slice(start, end);
  assert.match(body, /_restoreMeetingMode\s*\(/);
});

test('CSS 含 .mr-immersive-toggle.active + 沉浸只隐藏 .mr-terminals + cards 抢占空间', () => {
  assert.match(CSS, /\.mr-immersive-toggle\s*\{/);
  assert.match(CSS, /\.mr-immersive-toggle\.active\s*\{/);
  // 沉浸模式只 hide .mr-terminals，不能 hide toolbar / input-row
  assert.match(CSS, /#meeting-room-panel\.immersive\s+\.mr-terminals/);
  // cards 区（.mr-rt-panel）在沉浸模式下抢占空间
  assert.match(CSS, /#meeting-room-panel\.immersive\s+\.mr-rt-panel/);
  // 兜底：CSS 不能再含 #mr-shell-area 选择器
  assert.ok(!/#mr-shell-area/.test(CSS), '#mr-shell-area selector 已移除');
});

test('沉浸 CSS 不能影响 .mr-toolbar / .mr-input-row（toolbar/input 必须固定底部）', () => {
  // grep `#meeting-room-panel.immersive` 全部规则，看是否有 .mr-toolbar 或 .mr-input-row 的选择器
  const rules = CSS.match(/#meeting-room-panel\.immersive\s+\S+/g) || [];
  const violators = rules.filter(r => /\.mr-toolbar|\.mr-input-row|\.mr-input-soft-alert/.test(r));
  assert.strictEqual(violators.length, 0,
    `沉浸模式下严禁影响 toolbar/input：发现违规规则 ${violators.join(', ')}`);
});

test('main.js 含 IPC handlers save/get-immersive-mode', () => {
  assert.match(MAIN, /ipcMain\.handle\s*\(\s*['"]save-immersive-mode['"]/);
  assert.match(MAIN, /ipcMain\.handle\s*\(\s*['"]get-immersive-mode['"]/);
});

test('main.js 所有 stateStore.save 都带 immersiveByMeeting 字段', () => {
  // 找所有 stateStore.save( 调用，每个调用块内必须有 immersiveByMeeting
  const re = /stateStore\.save\s*\(\s*\{([^}]*?)\}/gs;
  let m, count = 0, lacking = [];
  while ((m = re.exec(MAIN))) {
    count += 1;
    if (!/immersiveByMeeting/.test(m[1])) {
      lacking.push(m[0].slice(0, 120));
    }
  }
  assert.ok(count >= 4, `expected ≥4 stateStore.save calls, got ${count}`);
  assert.strictEqual(lacking.length, 0, `${lacking.length} stateStore.save calls missing immersiveByMeeting:\n${lacking.join('\n')}`);
});

test('state-store.js load() normalize immersiveByMeeting 字段', () => {
  assert.match(STATE_STORE, /immersiveByMeeting/);
  // defaultState 也含
  const start = STATE_STORE.indexOf('function defaultState');
  const end = STATE_STORE.indexOf('}', STATE_STORE.indexOf('return', start));
  const body = STATE_STORE.slice(start, end);
  assert.match(body, /immersiveByMeeting/);
});

console.log('All passed.');
