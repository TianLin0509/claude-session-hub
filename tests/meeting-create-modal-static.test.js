'use strict';
// meeting-create-modal Tasks 12-13（2026-05-01）— 静态分析单测：锁住 Modal 关键不变量
// 不启动 Hub。覆盖：
//   1. modal js 里 5 家 AI 的 model 列表都有 ≥1 个 model（不能空）
//   2. 默认 slots = Claude/Opus 4.7 + Gemini/2.5 Flash + Codex/gpt-5.5（保持现状）
//   3. SLOT_AVATARS 三个路径都指向 renderer/assets/pokemon/*.png（皮卡丘/小火龙/杰尼龟）
//   4. window.openMeetingCreateModal / window.closeMeetingCreateModal 都暴露
//   5. modal 必须 IIFE 包裹（防 ipcRenderer/sessions 等顶层 const 重复声明）
//   6. index.html 引用 meeting-create-modal.css + .js
//   7. renderer.js createMeetingByMode 已改为弹 Modal（不再循环 add-meeting-sub）

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('Running meeting-create-modal static tests...');

const ROOT = path.join(__dirname, '..');
const MODAL_JS = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-create-modal.js'), 'utf-8');
const MODAL_CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'meeting-create-modal.css'), 'utf-8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf-8');
const RENDERER_JS = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf-8');

test('modal js has MODELS_BY_KIND with all 5 kinds non-empty', () => {
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'glm']) {
    const re = new RegExp(`${k}:\\s*\\[`);
    assert.ok(re.test(MODAL_JS), `MODELS_BY_KIND.${k} missing`);
  }
  // explicit known-good models
  assert.match(MODAL_JS, /'claude-opus-4-7\[1m\]'/);
  assert.match(MODAL_JS, /'gemini-2.5-flash'/);
  assert.match(MODAL_JS, /'gpt-5.5'/);
  assert.match(MODAL_JS, /'deepseek-v4-pro'/);
  assert.match(MODAL_JS, /'glm-/);
});

test('DEFAULT_SLOTS preserves old implicit behavior (Claude/Gemini/Codex defaults)', () => {
  assert.match(MODAL_JS, /kind:\s*'claude'[\s\S]{0,80}claude-opus-4-7\[1m\]/);
  assert.match(MODAL_JS, /kind:\s*'gemini'[\s\S]{0,80}gemini-2.5-flash/);
  assert.match(MODAL_JS, /kind:\s*'codex'[\s\S]{0,80}gpt-5.5/);
});

test('SLOT_AVATARS = pikachu / charmander / squirtle (slot-bound, not kind-bound)', () => {
  assert.match(MODAL_JS, /'assets\/pokemon\/pikachu\.png'/);
  assert.match(MODAL_JS, /'assets\/pokemon\/charmander\.png'/);
  assert.match(MODAL_JS, /'assets\/pokemon\/squirtle\.png'/);
  // Asset files actually exist
  for (const f of ['pikachu', 'charmander', 'squirtle']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'renderer', 'assets', 'pokemon', `${f}.png`)),
      `${f}.png missing on disk`,
    );
  }
});

test('window.openMeetingCreateModal + closeMeetingCreateModal exported', () => {
  assert.match(MODAL_JS, /window\.openMeetingCreateModal\s*=\s*openMeetingCreateModal/);
  assert.match(MODAL_JS, /window\.closeMeetingCreateModal\s*=\s*closeMeetingCreateModal/);
});

test('modal js is IIFE-wrapped (no top-level const ipcRenderer collision)', () => {
  // 必须以 (function () { 开头某处
  assert.match(MODAL_JS, /\(function\s*\(\)\s*\{/);
  // 必须以 \}\)\(\); 收尾
  assert.match(MODAL_JS, /\}\)\(\);?\s*$/);
  // 顶层 const 不会暴露：MODELS_BY_KIND / DEFAULT_SLOTS / SLOT_AVATARS 都在 IIFE 里
  // （验证方法：const/let 出现位置全在 (function 之后）
  const iifeStart = MODAL_JS.indexOf('(function');
  assert.ok(iifeStart > 0, 'IIFE wrapper not found');
  const beforeIife = MODAL_JS.slice(0, iifeStart);
  assert.ok(!/^\s*const\s+ipcRenderer/m.test(beforeIife),
    'ipcRenderer must be inside IIFE to avoid collision with renderer.js');
});

test('index.html includes meeting-create-modal css + js', () => {
  assert.match(HTML, /meeting-create-modal\.css/);
  assert.match(HTML, /<script\s+src="meeting-create-modal\.js"/);
});

test('renderer.js createMeetingByMode opens modal (no longer loops add-meeting-sub)', () => {
  const start = RENDERER_JS.indexOf('function createMeetingByMode');
  assert.ok(start > 0, 'createMeetingByMode not found');
  // 取后续 ~600 字符作为 function body 上下文（足够覆盖一个 wrapper 实现）
  const body = RENDERER_JS.slice(start, start + 600);
  assert.match(body, /openMeetingCreateModal/);
  // 不再含老的 add-meeting-sub 三家循环
  assert.ok(!/\['claude',\s*'gemini',\s*'codex'\]/.test(body),
    'old hardcoded 3-AI loop must be removed from createMeetingByMode');
});

test('modal CSS defines .mcm-overlay / .mcm-dialog / .mcm-slot / .mcm-primary', () => {
  for (const cls of ['.mcm-overlay', '.mcm-dialog', '.mcm-slot', '.mcm-primary', '.mcm-cancel', '.mcm-avatar']) {
    assert.match(MODAL_CSS, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'),
      `CSS class ${cls} missing`);
  }
});

test('modal sends create-meeting IPC with slots[] payload', () => {
  // ipcRenderer.invoke('create-meeting', { mode, scene, slots })
  assert.match(MODAL_JS, /ipcRenderer\.invoke\s*\(\s*['"]create-meeting['"]/);
  // 提交时构造 slots 数组（包含 index/kind/model）
  assert.match(MODAL_JS, /slots\.push\s*\(\s*\{/);
  assert.match(MODAL_JS, /index:/);
  assert.match(MODAL_JS, /kind:/);
  assert.match(MODAL_JS, /model:/);
});

console.log('All passed.');
