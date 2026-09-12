'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  activeQuestionIndexFromTops,
  answerTargetFromTops,
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
assert.equal(answerTargetFromTops([70, 390, 1800], 390, 2000, 'up'), 0);
assert.equal(answerTargetFromTops([70, 390, 1800], 390, 2000, 'down'), 2);
assert.equal(answerTargetFromTops([70, 390, 1800], 700, 2000, 'up'), 1);
assert.equal(answerTargetFromTops([70, 390, 1800], 0, 1500, 'up'), -1);
assert.equal(answerTargetFromTops([70, 390, 1800], 1500, 1500, 'down'), -1);
assert.equal(answerTargetFromTops([], 0, 1500, 'down'), -1);

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles', 'card-view.css'), 'utf8');
const navigator = fs.readFileSync(path.join(root, 'renderer', 'card-question-navigator.js'), 'utf8');
assert.match(html, /id="card-question-nav"[^>]*aria-label="问题导航"/);
assert.match(renderer, /document\.getElementById\('card-question-nav'\)[\s\S]*?preserved\.forEach/,
  'terminal panel rebuilds must preserve the navigator node');
assert.match(renderer, /cardQuestionNavigator\.refresh\(\)[\s\S]*?cardMultiSelectController\.setVisible/,
  'view switches must synchronously hide/show the navigator');
assert.match(css, /\.card-question-nav-item:focus-visible/);
assert.match(css, /\.card-question-nav-dot/);
assert.match(css, /\.card-question-nav\.dense/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.doesNotMatch(navigator, /label\.textContent\s*=\s*['"]你['"]/,
  'question markers must not render the same hard-coded Chinese avatar');
assert.match(navigator, /label\.textContent\s*=\s*`Q\$\{index \+ 1\}`/);
assert.match(navigator, /`问题 \$\{entry\.index \+ 1\} \/ \$\{entries\.length\}`/);

assert.match(navigator, /button\.tabIndex\s*=\s*-1/);
assert.match(navigator, /button\.tabIndex\s*=\s*active \? 0 : -1/);

console.log('unit-card-question-navigator OK');
