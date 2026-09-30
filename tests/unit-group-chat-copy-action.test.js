'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles', 'groupchat-journal.css'), 'utf8');

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name);
    console.error('    ' + (e.message || e));
  }
}

test('group chat messages render an accessible copy action in the card header', () => {
  const idx = js.indexOf('function _renderGroupChatMessage');
  assert.ok(idx > 0, '_renderGroupChatMessage must exist');
  // 窗口覆盖整个 _renderGroupChatMessage 函数体（到下一个函数前），避免函数体量增长时漏断言。
  const end = js.indexOf('\n  function ', idx + 20);
  const body = js.slice(idx, end > idx ? end : idx + 4500);
  assert.ok(body.includes('class="mr-gc-bubble-row"'), 'message bubble must be wrapped with a side action row');
  assert.ok(body.includes('data-gc-copy-message="1"'), 'message must render a copy action button');
  assert.ok(body.includes('journal.actions({copy:copyAction'), 'message must pass the copy action to the shared header');
  assert.ok(body.includes('复制此条消息'), 'copy action must have an accessible Chinese label/title');
});

test('group chat copy button is bound to clipboard copy from bubble text', () => {
  const idx = js.indexOf('async function _handleGcMessageCopy');
  assert.ok(idx > 0, 'copy button delegated handler must exist');
  const body = js.slice(idx, idx + 1600);
  assert.ok(/await clipboardController\.copyText\(text,/.test(body), 'copy handler must use the shared verified clipboard writer');
  assert.ok(/result\?\.ok === false/.test(body), 'a rejected write must not show copied feedback');
  assert.ok(/querySelector\(['"]\.mr-gc-bubble['"]\)/.test(body), 'copy handler must read text from the rendered bubble');
  assert.ok(/btn\.classList\.add\(['"]copied['"]\)/.test(body), 'copy handler must show a copied state');
  assert.ok(js.includes("panel.addEventListener('click'"), 'group chat panel must use delegated click binding');
  assert.ok(js.includes("_closestInPanel(ev.target, '[data-gc-copy-message]', panel)"), 'delegated click handler must route copy buttons');
});

test('journal header copy action remains visible without hover', () => {
  assert.ok(/\.gc-journal-actions > button,[^{]+\{[^}]*opacity:1;[^}]*pointer-events:auto/.test(css), 'header actions must be visible and clickable');
});

console.log('Running unit-group-chat-copy-action contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
