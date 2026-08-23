'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  activeQuestionIndexFromTops,
  normalizeQuestionSummary,
} = require('../renderer/card-question-navigator.js');

assert.equal(
  normalizeQuestionSummary('## 标题\n\n- 请分析 `Round2_Test_Channel.npy` 的结果', 72),
  '标题 请分析 Round2_Test_Channel.npy 的结果',
);
assert.equal(normalizeQuestionSummary('```js\nconsole.log(1)\n```\n下一步怎么办？'), '[代码] 下一步怎么办？');
assert.equal(normalizeQuestionSummary('x'.repeat(100), 20), `${'x'.repeat(19)}…`);
assert.equal(normalizeQuestionSummary('   '), '（空问题）');

assert.equal(activeQuestionIndexFromTops([100, 300, 500], 50), 0);
assert.equal(activeQuestionIndexFromTops([100, 300, 500], 320), 1);
assert.equal(activeQuestionIndexFromTops([100, 300, 500], 999), 2);
assert.equal(activeQuestionIndexFromTops([100, 300, 500], 0, true), 2);
assert.equal(activeQuestionIndexFromTops([], 100), -1);

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles', 'card-view.css'), 'utf8');
assert.match(html, /id="card-question-nav"[^>]*aria-label="问题导航"/);
assert.match(renderer, /document\.getElementById\('card-question-nav'\)[\s\S]*?preserved\.forEach/,
  'terminal panel rebuilds must preserve the navigator node');
assert.match(renderer, /cardQuestionNavigator\.refresh\(\)[\s\S]*?recentTurnCopyController/,
  'view switches must synchronously hide/show the navigator');
assert.match(css, /\.card-question-nav-item:focus-visible/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);

console.log('unit-card-question-navigator OK');
