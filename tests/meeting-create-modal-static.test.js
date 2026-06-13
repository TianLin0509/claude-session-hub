'use strict';
// meeting-create-modal Tasks 12-13（2026-05-01）— 静态分析单测：锁住 Modal 关键不变量
// 不启动 Hub。覆盖：
//   1. modal js 里 5 家 AI 的 model 列表都有 ≥1 个 model（不能空）
//   2. 默认 slots = Claude/Opus 4.8 + Codex/gpt-5.5 + DeepSeek v4-pro 1M
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
const {
  MODEL_OPTIONS_BY_KIND,
  DEFAULT_MODEL_BY_KIND,
  normalizeDeepSeekModel,
} = require('../core/model-options.js');

test('modal js has MODELS_BY_KIND with all 5 kinds non-empty', () => {
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'glm']) {
    assert.ok(Array.isArray(MODEL_OPTIONS_BY_KIND[k]) && MODEL_OPTIONS_BY_KIND[k].length > 0,
      `MODEL_OPTIONS_BY_KIND.${k} missing`);
  }
  const modelIds = Object.values(MODEL_OPTIONS_BY_KIND).flat().map(x => x.id).join('\n');
  assert.match(modelIds, /claude-opus-4-8\[1m\]/);
  assert.match(modelIds, /gemini-2.5-flash/);
  assert.match(modelIds, /gpt-5.5/);
  assert.match(modelIds, /deepseek-v4-pro\[1m\]/);
  assert.match(modelIds, /glm-/);
});

test('DEFAULT_SLOTS = strongest (claude opus 4.8 [1M] / codex gpt-5.5 / deepseek v4-pro [1M])', () => {
  // 2026-05-11：道雪指定 AI 群聊默认全用最强模型。
  // slot 2 用 'codex' kind（OpenAI codex CLI 直连订阅）+ 'gpt-5.5'，不再用 PackyAPI 中转的
  // 'gpt' kind（PackyAPI 中转最高到 5.4，'gpt-5.5' 限定 codex kind）。
  // 2026-05-29：道雪指定 Claude 默认升级到 Opus 4.8 1M（4.8 于 2026-05-28 发布）。
  assert.strictEqual(DEFAULT_MODEL_BY_KIND.claude, 'claude-opus-4-8[1m]');
  assert.strictEqual(DEFAULT_MODEL_BY_KIND.codex, 'gpt-5.5');
  assert.strictEqual(DEFAULT_MODEL_BY_KIND.deepseek, 'deepseek-v4-pro[1m]');
  assert.match(MODAL_JS, /\{\s*kind:\s*'claude'\s*,\s*model:\s*DEFAULT_MODEL_BY_KIND\.claude\s*\}/);
  assert.match(MODAL_JS, /\{\s*kind:\s*'codex'\s*,\s*model:\s*DEFAULT_MODEL_BY_KIND\.codex\s*\}/);
  assert.match(MODAL_JS, /\{\s*kind:\s*'deepseek'\s*,\s*model:\s*DEFAULT_MODEL_BY_KIND\.deepseek\s*\}/);
});

test('DeepSeek model defaults and legacy ids normalize to 1M', () => {
  assert.strictEqual(normalizeDeepSeekModel(), 'deepseek-v4-pro[1m]');
  assert.strictEqual(normalizeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro[1m]');
  assert.strictEqual(normalizeDeepSeekModel('deepseek-v4-pro[1m]'), 'deepseek-v4-pro[1m]');
});

test('COMMITTEE_SLOTS = DeepSeek + Claude 4.8 + Codex + Codex + Claude chair', () => {
  assert.match(MODAL_JS, /const COMMITTEE_SLOTS = \[/);
  assert.match(MODAL_JS, /\{\s*kind:\s*'deepseek'\s*,\s*model:\s*'deepseek-v4-pro\[1m\]'\s*\}/);
  // 2026-06-13：Claude slot 改用 DEFAULT_MODEL_BY_KIND.claude 变量引用（当前=Opus 4.8）
  assert.match(MODAL_JS, /\{\s*kind:\s*'claude'\s*,\s*model:\s*DEFAULT_MODEL_BY_KIND\.claude\s*\}/);
  assert.match(MODAL_JS, /\{\s*kind:\s*'codex'\s*,\s*model:\s*'gpt-5\.5'\s*\}/);
  assert.match(MODAL_JS, /消息面官=Claude Opus 4\.8/);
  assert.match(MODAL_JS, /技术面官=Codex GPT-5\.5/);
  assert.ok(!/消息面官=Kimi/.test(MODAL_JS), 'committee preset must not use Kimi as news seat');
  assert.ok(!/技术面官=Qwen/.test(MODAL_JS), 'committee preset must not use Qwen as tech seat');
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

test('new session menu has one Codex CLI option using settings default profile', () => {
  const codexButtons = HTML.match(/class="new-session-option" data-kind="codex"/g) || [];
  assert.strictEqual(codexButtons.length, 1, 'new session menu should expose exactly one Codex CLI option');
  assert.ok(!/new-session-option[^>]*data-kind="codex"[^>]*data-codex-profile/.test(HTML),
    'new Codex sessions must not override the settings default profile');
  assert.ok(!/dataset\.codexProfile\b/.test(RENDERER_JS),
    'renderer new-session click handler should not pass a per-button Codex profile');
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
  assert.match(MODAL_JS, /const\s+slots\s*=\s*Array\.from/);
  assert.match(MODAL_JS, /index:/);
  assert.match(MODAL_JS, /kind:/);
  assert.match(MODAL_JS, /model:/);
});

test('modal supports flexible group chat creation', () => {
  assert.match(MODAL_JS, /mode\s*===\s*['"]group['"]/);
  assert.match(MODAL_JS, /DEFAULT_GROUP_MEMBERS/);
  assert.match(MODAL_JS, /mcm-add-member/);
  assert.match(MODAL_JS, /groupChat:\s*_isGroupChat/);
  assert.match(MODAL_JS, /groupMode:\s*_isGroupChat\s*\?\s*['"]deliberation['"]/);
  assert.match(MODAL_JS, /participants:\s*_isGroupChat\s*\?\s*slots\.map/);
  assert.match(HTML, /id="btn-group-chat"/);
  assert.match(RENDERER_JS, /openMeetingCreateModal\(['"]group['"]\)/);
});

console.log('All passed.');
