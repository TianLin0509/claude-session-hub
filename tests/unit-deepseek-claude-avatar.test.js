'use strict';
// 2026-10-12：DeepSeek 跑在 Claude Code 上时，回答卡片的头像要用 DeepSeek 自己的画像，
// 不能因为记录是 Claude 格式就显示成 Claude。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTurnCardRenderer } = require('../renderer/turn-card-renderer');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderAssistantFor(sessionKind) {
  const html = [];
  const doc = {
    addEventListener() {},
    createElement() { return { set innerHTML(v) { html.push(v); }, get firstElementChild() { return null; } }; },
  };
  const view = createTurnCardRenderer({
    document: doc, window: {}, navigator: {}, state: { _sessionTurns: new Map() }, escapeHtml: esc,
    marked: { parse: s => '<p>' + esc(s) + '</p>' }, DOMPurify: { sanitize: s => s }, formatAbsoluteTime: () => '',
    normalizeMarkdownPathBreaks: s => s,
    getActiveSessionId: () => 's1', getSessionContext: () => ({ id: 's1', kind: sessionKind }),
  });
  // 卡片解析器对 Claude 格式记录一律给出 kind: 'claude'
  const turn = { id: 't1', role: 'assistant', kind: 'claude', model: 'deepseek-flash', text: 'OK', ts: Date.now() };
  try { view.mountTurnCard({ insertBefore() {}, querySelector() { return null; } }, turn); } catch { /* 假 DOM 不支持后处理，只取渲染出的 HTML */ }
  return html.join('');
}

test('DeepSeek 跑在 Claude Code 上的回答卡片用 DeepSeek 头像', () => {
  for (const kind of ['deepseek-claude', 'deepseek-claude-resume', 'deepseek']) {
    const html = renderAssistantFor(kind);
    assert.match(html, /ai-avatars\/cel-v2\/deepseek\.png/, kind);
    assert.doesNotMatch(html, /cel-v2\/claude\.png/, kind);
  }
});

test('Claude 会话的回答卡片仍是 Claude 头像', () => {
  const html = renderAssistantFor('claude');
  assert.match(html, /ai-avatars\/cel-v2\/claude\.png/);
});
