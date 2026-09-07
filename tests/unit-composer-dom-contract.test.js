'use strict';
// Composer DOM 契约（T1 冷杉 v2）。
//
// 这里守三件「一改就会静默坏掉」的事：
//   1. 文本框还是原来那个节点（id/class/contenteditable/占位符/历史/几何锁全靠它）；
//   2. 底栏节点顺序 —— 顺序错了就不是那张设计稿，而且发送键会跑到中间；
//   3. 思考档 chip 在不支持的 CLI 上不渲染（不能靠记忆断言，判据必须是纯函数）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'styles.css'));
const { composerThinkingChip, composerContextRing } = require('../core/session-status-summary.js');

const mountStart = renderer.indexOf('function mountFloatingInput');
assert.ok(mountStart > 0, '定位不到 mountFloatingInput');
const mount = renderer.slice(mountStart, renderer.indexOf('function updateFloatingBarState', mountStart));

test('文本框仍是原来那个节点，属性一个都没丢', () => {
  assert.match(mount, /inputBox\.className = 'floating-input-box'/);
  assert.match(mount, /inputBox\.contentEditable = 'true'/);
  assert.match(mount, /inputBox\.setAttribute\('data-placeholder'/);
  // 历史召回与草稿都挂在这个节点上，换节点等于静默丢功能。
  assert.match(mount, /historyCursor/);
  assert.match(mount, /saveFloatingInputDraft\(sessionId, inputBox\)/);
});

test('composer 三段结构：状态行 → 文本框 → 底栏，且仍装在 fi-content-stack 里', () => {
  assert.match(mount, /composer\.append\(statusRow, quickReplyRow, composerRow, composerRail\)/);
  assert.match(mount, /composerRow\.append\(inputBox\)/);
  // 几何锁契约（unit-floating-input-geometry-contract）依赖这一层，不能被拆掉。
  assert.match(mount, /contentStack\.className = 'fi-content-stack'/);
  assert.match(mount, /contentStack\.append\(composer\)/);
});

test('底栏节点顺序固定：附件 · 模型 · 思考档 · 拉取/分支 ｜ 预算环 · 提示 · 停止/发送', () => {
  const railAppend = mount.match(/composerRail\.append\(([\s\S]*?)\);/);
  assert.ok(railAppend, '定位不到底栏的 append');
  const order = railAppend[1].split(',').map(part => part.trim()).filter(Boolean);
  assert.deepEqual(order, [
    'attachBtn', 'modelChip', 'thinkingChip', 'bridgeToolbar',
    'railSpacer', 'ctxRing', 'sendHint', 'stopBtn', 'sendBtn',
  ]);
});

test('模型选择器是接现成的，不是重造一个', () => {
  assert.match(mount, /attachModelPickerHandler\(modelChip, sessionId\)/);
  assert.ok(!/model-picker-menu/.test(mount), 'composer 不得自己再画一个模型选择器');
});

test('思考档 chip 在不支持的 CLI 上不渲染', () => {
  for (const kind of ['gemini', 'kimi', 'powershell']) {
    assert.equal(composerThinkingChip({ kind }).visible, false, `${kind} 不该出现思考档 chip`);
  }
  // Codex：档位按模型走，读不到目录就不渲染，不假装有。
  assert.equal(composerThinkingChip({ kind: 'codex', effort: 'xhigh' }, {}).visible, false);
  const codex = composerThinkingChip({ kind: 'codex', effort: 'xhigh' }, {
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  });
  assert.equal(codex.visible, true);
  assert.equal(codex.interactive, true);
  // Claude：有档位但 Hub 没有会话内改档的通路，只显示不可点。
  const claude = composerThinkingChip({ kind: 'claude', effort: 'max' });
  assert.deepEqual(
    { visible: claude.visible, interactive: claude.interactive, label: claude.label },
    { visible: true, interactive: false, label: 'max' },
  );
});

test('上下文预算环的三档颜色阈值：<70 蓝 / 70-90 琥珀 / >90 红', () => {
  assert.equal(composerContextRing({ contextPct: 12 }).level, 'ok');
  assert.equal(composerContextRing({ contextPct: 69 }).level, 'ok');
  assert.equal(composerContextRing({ contextPct: 70 }).level, 'warn');
  assert.equal(composerContextRing({ contextPct: 90 }).level, 'warn');
  assert.equal(composerContextRing({ contextPct: 91 }).level, 'danger');
  assert.equal(composerContextRing({}).visible, false);
});

test('发送路径没被动过：仍是那条闭环，停止键仍是既有的中断按钮', () => {
  assert.match(mount, /ipcRenderer\.invoke\('session:send-prompt'/);
  assert.match(mount, /stopBtn\.className = 'floating-input-stop'/);
  assert.match(mount, /data: '\\x03'/);
  // 停止键的可见性判据必须还是那条「PTY 字节活动不足以亮出 Ctrl+C」的规则。
  assert.match(renderer, /function composerStopAllowed\(session, runtimeTruth\)/);
  assert.match(renderer, /CONFIDENCE_AUTHORITATIVE, CONFIDENCE_STRONG, CONFIDENCE_SEMANTIC/);
});

test('快捷答复只填进输入框，绝不自动发送', () => {
  const handler = mount.slice(
    mount.indexOf("quickReplyRow.addEventListener('click'"),
    mount.indexOf('// 附件：'),
  );
  assert.ok(handler.length > 100, '定位不到快捷答复的点击处理');
  assert.match(handler, /inputBox\.focus\(\)/);
  assert.ok(!/sendInput\(\)/.test(handler), '快捷答复不得替用户按下发送');
});

test('composer 的样式独立成文件并挂进清单，没有碰 base.css', () => {
  const manifest = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
  assert.match(manifest, /@import url\('\.\/styles\/composer\.css'\);/);
  for (const cls of [
    '.composer-status', '.composer-rail', '.composer-chip', '.composer-model',
    '.composer-thinking', '.composer-ctx', '.composer-hint', '.composer-quick-reply',
  ]) {
    assert.ok(css.includes(cls), `composer 缺样式：${cls}（没样式等于没做）`);
  }
  const base = fs.readFileSync(path.join(root, 'renderer', 'styles', 'base.css'), 'utf8');
  assert.ok(!base.includes('.composer-rail'), 'A 车道不得往 base.css 里写东西');
});

test('新增样式只用本轮允许的六档字号', () => {
  const composerCss = fs.readFileSync(path.join(root, 'renderer', 'styles', 'composer.css'), 'utf8');
  const allowed = new Set(['10', '11', '11.5', '12.5', '13.5', '15']);
  for (const match of composerCss.matchAll(/font-size:\s*([0-9.]+)px/g)) {
    assert.ok(allowed.has(match[1]), `composer.css 出现规范外字号：${match[1]}px`);
  }
});
