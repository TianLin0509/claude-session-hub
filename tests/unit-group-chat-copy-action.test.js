'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readCssWithImports } = require('./helpers/read-css-with-imports.js');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
const css = readCssWithImports(path.join(root, 'renderer', 'meeting-room.css'));

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

test('group chat messages render a hover copy button beside the bubble', () => {
  const idx = js.indexOf('function _renderGroupChatMessage');
  assert.ok(idx > 0, '_renderGroupChatMessage must exist');
  const body = js.slice(idx, idx + 2600);
  assert.ok(body.includes('class="mr-gc-bubble-row"'), 'message bubble must be wrapped with a side action row');
  assert.ok(body.includes('data-gc-copy-message="1"'), 'message must render a copy action button');
  assert.ok(body.includes('复制此条消息'), 'copy action must have an accessible Chinese label/title');
});

test('group chat copy button is bound to clipboard copy from bubble text', () => {
  const idx = js.indexOf("panel.querySelectorAll('[data-gc-copy-message]')");
  assert.ok(idx > 0, 'copy button event binding must exist');
  const body = js.slice(idx, idx + 1600);
  assert.ok(/navigator\.clipboard\.writeText\(text\)/.test(body), 'copy handler must write the bubble text to clipboard');
  assert.ok(/querySelector\(['"]\.mr-gc-bubble['"]\)/.test(body), 'copy handler must read text from the rendered bubble');
  assert.ok(/btn\.classList\.add\(['"]copied['"]\)/.test(body), 'copy handler must show a copied state');
});

test('group chat copy button stays hidden until message hover or keyboard focus', () => {
  assert.ok(css.includes('.mr-gc-copy-btn'), 'copy button must have CSS');
  assert.ok(/\.mr-gc-copy-btn\s*\{[\s\S]*?opacity:\s*0/.test(css), 'copy button must be hidden by default');
  assert.ok(/\.mr-gc-msg:hover\s+\.mr-gc-copy-btn/.test(css), 'copy button must appear on message hover');
  assert.ok(/\.mr-gc-msg:focus-within\s+\.mr-gc-copy-btn/.test(css), 'copy button must appear on keyboard focus');
});

console.log('Running unit-group-chat-copy-action contract tests...');
console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
