'use strict';
/**
 * [查看本轮 prompt] + [幕次折叠] 单测（2026-06-28 道雪）——群聊通用功能。
 * 验证：① 普通群聊 completeTurn 从 _activePrompts 把该 AI 实际收到的 prompt 落进 message.sourcePrompt；
 *       ② 投委会 appendCommitteeSpeeches 把 item.prompt 落进 message.sourcePrompt；
 *       ③ 前端 meeting-room.js 渲染查看按钮 / 弹窗 / 幕次折叠的契约（静态检查）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-prompt-peek-'));
const groupchat = require('../core/group-chat-orchestrator.js');
const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));
const committeeCss = fs.readFileSync(path.join(root, 'renderer', 'committee-ui.css'), 'utf8');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name); console.error('    ' + (e.stack || e.message)); }
}

const members = [
  { sid: 's-claude', index: 0, memberId: 'm1', kind: 'claude', model: 'opus', displayName: 'Claude' },
  { sid: 's-codex', index: 1, memberId: 'm2', kind: 'codex', model: 'gpt', displayName: 'Codex' },
];
const bySid = Object.fromEntries(members.map(m => [m.sid, m]));
function fresh() {
  const meetingId = `gc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return groupchat.getOrchestrator(tmp, meetingId);
}

console.log('--- 查看本轮 prompt + 幕次折叠 ---');

// ── 后端：普通群聊 ──
test('普通群聊：completeTurn 把 recordTurnPrompt 的 prompt 各自落进 message.sourcePrompt（不串）', () => {
  const orch = fresh();
  const { turnNum } = orch.beginTurn('明天买什么');
  const claudePrompt = '你是Claude(systemPrompt整套规则)\n\n## 用户\n明天买什么\n\n请发言。';
  const codexPrompt = '## 新增发言\nClaude：买A\n\n## 用户\n明天买什么\n\n请发言。';
  orch.recordTurnPrompt(turnNum, 's-claude', claudePrompt);
  orch.recordTurnPrompt(turnNum, 's-codex', codexPrompt);
  orch.completeTurn(turnNum, '明天买什么', [
    { sid: 's-claude', status: 'completed', text: '买 A' },
    { sid: 's-codex', status: 'completed', text: '买 B' },
  ], bySid);
  const msgs = orch.getState().messages.filter(m => m.role === 'assistant');
  assert.strictEqual(msgs.find(m => m.sid === 's-claude').sourcePrompt, claudePrompt, 'Claude 消息存其收到的 prompt');
  assert.strictEqual(msgs.find(m => m.sid === 's-codex').sourcePrompt, codexPrompt, 'Codex 消息存其收到的 prompt（各存各的）');
});

test('普通群聊：未 recordTurnPrompt 时 sourcePrompt 落空串（不抛错、不污染既有字段）', () => {
  const orch = fresh();
  const { turnNum } = orch.beginTurn('问题');
  orch.completeTurn(turnNum, '问题', [{ sid: 's-claude', status: 'completed', text: '答' }], bySid);
  assert.strictEqual(orch.getState().messages.find(m => m.role === 'assistant').sourcePrompt, '', '无存档 prompt 时为空串');
});

// ── 后端：投委会 ──
test('投委会：appendCommitteeSpeeches 把 item.prompt 落进 message.sourcePrompt', () => {
  const orch = fresh();
  const reviewPrompt = '【点评幕】把标的名换成 6 位代码调 screener_score 拿追涨/蓄势分...';
  orch.appendCommitteeSpeeches(
    [{ sid: 's-codex', speaker: 'Codex', content: '点评原文', prompt: reviewPrompt }],
    { act: '点评' }
  );
  const msg = orch.getState().messages.find(m => m.committeeAct === '点评');
  assert.ok(msg, '点评幕发言进 messages');
  assert.strictEqual(msg.sourcePrompt, reviewPrompt, '委员消息存其本幕实际收到的 prompt');
});

test('投委会：appendCommitteeSpeeches 无 prompt 字段时 sourcePrompt 落空串（旧数据兼容）', () => {
  const orch = fresh();
  orch.appendCommitteeSpeeches([{ sid: 's-codex', speaker: 'Codex', content: '无 prompt 发言' }], { act: '建库' });
  assert.strictEqual(orch.getState().messages.find(m => m.committeeAct === '建库').sourcePrompt, '', '无 prompt 字段时为空串');
});

// ── 前端：查看 prompt 按钮 + 弹窗（静态契约）──
test('前端：仅 AI 气泡 + 有 sourcePrompt 才渲染查看 prompt 按钮', () => {
  assert.ok(js.includes('data-gc-view-prompt='), '渲染 data-gc-view-prompt 按钮');
  assert.ok(/!isUser && message\.sourcePrompt/.test(js), '按钮条件：仅 AI 且有存档 prompt');
  assert.ok(js.includes('mr-gc-prompt-btn'), '按钮带 mr-gc-prompt-btn class');
});

test('前端：handler + 弹窗函数存在，从 _gcPanelState 缓存按 message.id 取 sourcePrompt', () => {
  assert.ok(js.includes('function _handleGcViewPrompt'), 'handler 存在');
  assert.ok(js.includes('function _showGcPromptModal'), '弹窗函数存在');
  const h = js.slice(js.indexOf('function _handleGcViewPrompt'), js.indexOf('function _handleGcViewPrompt') + 600);
  assert.ok(/_gcPanelState\[meeting\.id\]/.test(h), 'handler 从 _gcPanelState 缓存取');
  assert.ok(/\.find\(m => m && m\.id === msgId\)/.test(h), '按 message.id 定位消息');
  assert.ok(js.includes("_closestInPanel(ev.target, '[data-gc-view-prompt]', panel)"), '事件委托 route 查看按钮');
});

test('前端：弹窗 markdown 渲染 + 自建 overlay（非浏览器原生 dialog）+ Esc 关闭', () => {
  const body = js.slice(js.indexOf('function _showGcPromptModal'), js.indexOf('function _showGcPromptModal') + 2200);
  assert.ok(body.includes('_renderMarkdown(prompt)'), 'markdown 渲染 prompt');
  assert.ok(body.includes('mr-gc-prompt-modal-overlay'), '自建 overlay');
  assert.ok(/Escape/.test(body), 'Esc 关闭');
  assert.ok(!/\b(alert|confirm)\s*\(/.test(body), '不用浏览器原生 alert/confirm');
});

// ── 前端：幕次折叠（静态契约）──
test('前端：幕次分隔条可点击折叠（toggle + _gcCollapsedActs + 隐藏本幕气泡 + 折叠计数）', () => {
  assert.ok(js.includes('const _gcCollapsedActs = {}'), '折叠状态容器存在');
  assert.ok(js.includes('data-gc-act-toggle='), '分隔条带 toggle 属性');
  assert.ok(js.includes("_closestInPanel(ev.target, '[data-gc-act-toggle]', panel)"), '事件委托 route 折叠');
  assert.ok(/const hidden = !!\(actKey && _collapsedSet\.has\(actKey\)\)/.test(js), '折叠时隐藏本幕气泡本体');
  assert.ok(js.includes('mr-gc-act-sep-count'), '折叠后显示「N 条已折叠」计数');
});

// ── CSS 契约 ──
test('CSS：查看按钮默认隐藏 + hover 显示；弹窗 overlay 有样式；分隔条可点击', () => {
  assert.ok(/\.mr-gc-prompt-btn\s*\{[\s\S]*?opacity:\s*0/.test(css), '查看按钮默认隐藏');
  assert.ok(/\.mr-gc-msg:hover\s+\.mr-gc-prompt-btn/.test(css), 'hover 显示查看按钮');
  assert.ok(css.includes('.mr-gc-prompt-modal-overlay'), '弹窗 overlay 有样式');
  assert.ok(/\.mr-gc-act-sep\s*\{[\s\S]*?cursor:\s*pointer/.test(committeeCss), '分隔条可点击 cursor');
});

console.log(`\n${failed === 0 ? 'OK 全绿' : 'FAIL ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
