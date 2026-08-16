'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function test(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); process.exitCode = 1; }
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
  normalizeLegacyDeepSeekClaudeModel,
} = require('../core/model-options.js');

test('modal model lists cover the five core AI kinds including Kimi K3', () => {
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'kimi']) {
    assert.ok(Array.isArray(MODEL_OPTIONS_BY_KIND[k]) && MODEL_OPTIONS_BY_KIND[k].length > 0,
      `MODEL_OPTIONS_BY_KIND.${k} missing`);
  }
  for (const removed of ['glm', 'gpt', 'qwen']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(MODEL_OPTIONS_BY_KIND, removed),
      `${removed} models should be removed`);
  }
  const modelIds = Object.values(MODEL_OPTIONS_BY_KIND).flat().map(x => x.id).join('\n');
  assert.match(modelIds, /claude-opus-5\[1m\]/);
  assert.match(modelIds, /claude-fable-5/);
  assert.match(modelIds, /claude-opus-4-8\[1m\]/);
  assert.match(modelIds, /gemini-2.5-flash/);
  assert.match(modelIds, /gpt-5.6-sol/);
  assert.match(modelIds, /deepseek-v4-flash/);
  assert.doesNotMatch(modelIds, /deepseek-v4-pro/,
    'V4 Pro is not currently exposed by the official Codex Responses integration');
  assert.match(modelIds, /kimi-code\/k3/);
});

test('default group slots use Claude, Codex, and DeepSeek strongest defaults', () => {
  assert.strictEqual(DEFAULT_MODEL_BY_KIND.claude, 'claude-opus-5[1m]');
  assert.strictEqual(DEFAULT_MODEL_BY_KIND.codex, 'gpt-5.6-sol');
  assert.strictEqual(DEFAULT_MODEL_BY_KIND.deepseek, 'deepseek-v4-flash');
  assert.match(MODAL_JS, /\{\s*kind:\s*'claude'\s*,\s*model:\s*DEFAULT_MODEL_BY_KIND\.claude\s*\}/);
  assert.match(MODAL_JS, /\{\s*kind:\s*'codex'\s*,\s*model:\s*DEFAULT_MODEL_BY_KIND\.codex\s*\}/);
  assert.match(MODAL_JS, /\{\s*kind:\s*'deepseek'\s*,\s*model:\s*DEFAULT_MODEL_BY_KIND\.deepseek\s*\}/);
});

test('new DeepSeek sessions normalize to Codex Flash while old Claude sessions keep Pro', () => {
  assert.strictEqual(normalizeDeepSeekModel(), 'deepseek-v4-flash');
  assert.strictEqual(normalizeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-flash');
  assert.strictEqual(normalizeDeepSeekModel('deepseek-v4-flash[1m]'), 'deepseek-v4-flash');
  assert.strictEqual(normalizeLegacyDeepSeekClaudeModel(), 'deepseek-v4-pro[1m]');
  assert.strictEqual(normalizeLegacyDeepSeekClaudeModel('deepseek-v4-pro'), 'deepseek-v4-pro[1m]');
});

test('deleted modal presets and decorative assets stay removed', () => {
  assert.ok(!/COMMITTEE_SLOTS/.test(MODAL_JS), 'committee preset must stay removed');
  assert.ok(!/assets\/pokemon\//.test(MODAL_JS), 'decorative slot avatars must stay removed');
  assert.ok(!fs.existsSync(path.join(ROOT, 'renderer', 'assets', 'pokemon')),
    'decorative avatar asset directory should be removed');
  // 2026-07-29（Kimi）：头像 URL 统一加 -resume 归一（assets 无 *-resume.svg），
  // 断言从"字面 ${kind}"放宽为"ai-logos 约定仍在 + resume 归一存在"。
  assert.match(MODAL_JS, /assets\/ai-logos\//);
  assert.match(MODAL_JS, /replace\(\/-resume\$\/, ''\)/);
});

test('group chat modal exposes task templates before member tuning', () => {
  assert.match(MODAL_JS, /GROUP_TEMPLATES/);
  for (const label of ['通用会诊', '代码/方案评审', '投研圆桌', '决策交接']) {
    assert.ok(MODAL_JS.includes(label), `template label missing: ${label}`);
  }
  assert.match(MODAL_JS, /data-mcm-template/);
  assert.match(MODAL_JS, /function\s+_applyTemplate/);
  assert.match(MODAL_JS, /_applyTemplate\(['"]general['"],\s*\{\s*clearTitle:\s*true\s*\}\)/);
  assert.match(MODAL_CSS, /\.mcm-template-grid\s*\{/);
  assert.match(MODAL_CSS, /\.mcm-template\.selected\s*\{/);
});

test('window.openMeetingCreateModal and closeMeetingCreateModal are exported', () => {
  assert.match(MODAL_JS, /window\.openMeetingCreateModal\s*=\s*openMeetingCreateModal/);
  assert.match(MODAL_JS, /window\.closeMeetingCreateModal\s*=\s*closeMeetingCreateModal/);
});

test('modal js is IIFE-wrapped', () => {
  assert.match(MODAL_JS, /\(function\s*\(\)\s*\{/);
  assert.match(MODAL_JS, /\}\)\(\);?\s*$/);
  const iifeStart = MODAL_JS.indexOf('(function');
  assert.ok(iifeStart > 0, 'IIFE wrapper not found');
  const beforeIife = MODAL_JS.slice(0, iifeStart);
  assert.ok(!/^\s*const\s+ipcRenderer/m.test(beforeIife),
    'ipcRenderer must be inside IIFE to avoid collision with renderer.js');
});

test('index.html includes meeting-create-modal css and js', () => {
  assert.match(HTML, /meeting-create-modal\.css/);
  assert.match(HTML, /<script\s+src="meeting-create-modal\.js"/);
  assert.ok(
    HTML.indexOf('<script src="meeting-create-modal.js"></script>')
      < HTML.indexOf('<script src="renderer.js"></script>'),
    'group-chat launcher must bind before the large renderer bootstrap can fail',
  );
  assert.match(MODAL_JS, /getElementById\(['"]btn-group-chat['"]\)/);
  assert.match(MODAL_JS, /groupChatButton\.addEventListener\(['"]click['"]/);
});

test('new session menu has one Codex CLI option using settings default profile', () => {
  const codexButtons = HTML.match(/class="new-session-option" data-kind="codex"/g) || [];
  assert.strictEqual(codexButtons.length, 1, 'new session menu should expose exactly one Codex CLI option');
  assert.ok(!/new-session-option[^>]*data-kind="codex"[^>]*data-codex-profile/.test(HTML),
    'new Codex sessions must not override the settings default profile');
  assert.ok(!/dataset\.codexProfile\b/.test(RENDERER_JS),
    'renderer new-session click handler should not pass a per-button Codex profile');
});

test('renderer.js createMeetingByMode opens modal', () => {
  const start = RENDERER_JS.indexOf('function createMeetingByMode');
  assert.ok(start > 0, 'createMeetingByMode not found');
  const body = RENDERER_JS.slice(start, start + 600);
  assert.match(body, /openMeetingCreateModal/);
  assert.ok(!/\['claude',\s*'gemini',\s*'codex'\]/.test(body),
    'old hardcoded 3-AI loop must be removed from createMeetingByMode');
});

test('modal CSS defines required shell classes', () => {
  for (const cls of ['.mcm-overlay', '.mcm-dialog', '.mcm-slot', '.mcm-primary', '.mcm-cancel', '.mcm-avatar']) {
    assert.match(MODAL_CSS, new RegExp(cls.replace('.', '\\.') + '\\s*\\{'),
      `CSS class ${cls} missing`);
  }
});

test('modal sends create-meeting IPC with slots payload', () => {
  assert.match(MODAL_JS, /ipcRenderer\.invoke\s*\(\s*['"]create-meeting['"]/);
  assert.match(MODAL_JS, /const\s+slots\s*=\s*Array\.from/);
  assert.match(MODAL_JS, /index:/);
  assert.match(MODAL_JS, /kind:/);
  assert.match(MODAL_JS, /model:/);
});

test('every group member exposes the same provider-specific tuning as new Session', () => {
  for (const selector of [
    'mcm-effort-select',
    'mcm-mcp-select',
    'mcm-fast-checkbox',
    'mcm-codex-tier-select',
  ]) {
    assert.ok(MODAL_JS.includes(selector), `member tuning control missing: ${selector}`);
  }
  assert.match(MODAL_JS, /WorkspaceController\.resolveSessionTuning/,
    'group modal must reuse new-session dynamic tuning definitions');
  assert.match(MODAL_JS, /WorkspaceController\.buildSessionTuningOpts/,
    'group modal must reuse new-session provider-specific payload rules');
  assert.match(MODAL_JS, /WorkspaceController\.loadCodexTuningCatalog/,
    'Codex effort and Fast options must come from its model catalog');
  assert.match(MODAL_JS, /群聊通信所需 MCP 始终保留/);
  assert.match(MODAL_CSS, /\.mcm-member-caption\s*\{/);
  assert.match(MODAL_CSS, /\.mcm-tuning-field\s*\{/);
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
