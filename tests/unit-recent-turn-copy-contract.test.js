'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('renderer/index.html');
const renderer = read('renderer/renderer.js');
const css = read('renderer/styles/card-view.css');

const copyModule = read('renderer/recent-turn-copy.js');

// 轮数选项不再写死在 HTML 里 —— 上限 = 当前对话的完整轮数，由 JS 重建。
// 静态 HTML 只保留一个 1 轮做首帧兜底。
assert.match(html, /id="recent-turn-copy-count"[\s\S]{0,200}<option value="1">1 轮<\/option>/);
assert.doesNotMatch(
  html,
  /id="recent-turn-copy-count"[\s\S]{0,400}<option value="3">/,
  '写死到 3 轮就是这次要修的问题，别写回去',
);
assert.match(html, /id="recent-turn-copy-total"/, 'UI 上要显示当前最多能复制多少轮');
assert.match(copyModule, /function refreshRoundOptions\(\)/, '选项必须按实际轮数重建');
assert.match(
  copyModule,
  /countSelect\.addEventListener\('focus', onSelectOpened\)/,
  '卡片是异步挂载的，只在 setVisible 时刷会让刚开会话时上限停在 0/1',
);
assert.match(css, /\.recent-turn-copy-total/);
assert.match(renderer, /createRecentTurnCopyController\(\{/);
assert.match(renderer, /extractVisibleCardText,/,
  'multi-round copy must reuse visible pure-text extraction instead of raw markdown');
assert.match(renderer, /document\.getElementById\('recent-turn-copy'\)/,
  'copy toolbar must survive terminal-panel rebuilds');
assert.match(renderer, /setVisible\(mode === 'card' && !!activeSessionId\)/,
  'copy toolbar must only appear in card view with an active session');
assert.match(css, /\.recent-turn-copy\[hidden\]\s*\{\s*display:\s*none/);

console.log('recent turn copy integration contract ok');
