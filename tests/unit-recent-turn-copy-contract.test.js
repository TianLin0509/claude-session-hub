'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('renderer/index.html');
const renderer = read('renderer/renderer.js');
const css = read('renderer/styles/card-view.css');

assert.match(html, /id="recent-turn-copy"[\s\S]{0,500}<option value="1">1 轮<\/option>[\s\S]{0,180}<option value="2">2 轮<\/option>[\s\S]{0,180}<option value="3">3 轮<\/option>/);
assert.match(renderer, /createRecentTurnCopyController\(\{/);
assert.match(renderer, /extractVisibleCardText,/,
  'multi-round copy must reuse visible pure-text extraction instead of raw markdown');
assert.match(renderer, /document\.getElementById\('recent-turn-copy'\)/,
  'copy toolbar must survive terminal-panel rebuilds');
assert.match(renderer, /setVisible\(mode === 'card' && !!activeSessionId\)/,
  'copy toolbar must only appear in card view with an active session');
assert.match(css, /\.recent-turn-copy\[hidden\]\s*\{\s*display:\s*none/);

console.log('recent turn copy integration contract ok');
