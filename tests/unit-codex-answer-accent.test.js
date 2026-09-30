'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findAnswerRanges, accentLines } = require('../renderer/codex-answer-accent');

test('answer accents follow visible Codex replies but stop before prompts and status rows', () => {
  const lines = [
    '› 用户问题',
    '',
    '• 这是回答',
    '  第一段正文',
    '  第二段正文',
    '  11:35 AM',
    '› Ask Codex to do anything',
    '• 下一轮回答',
    '  - 列表',
    '  Warnings · 1 of 2 · Startup',
  ];
  assert.deepEqual(findAnswerRanges(lines, 0, lines.length), [
    { first: 2, rows: 3 }, { first: 7, rows: 2 },
  ]);
  assert.deepEqual(findAnswerRanges(lines, 3, 4), [{ first: 0, rows: 2 }]);
  assert.deepEqual(findAnswerRanges(lines, 5, 2), []);
});

test('semantic answer accents keep ordinary prose neutral', () => {
  const lines = ['• 完成', '  普通正文', '  // 注释', '  function greet() {',
    '  - const color = "red";', '  + const color = "green";', '› 下一条'];
  const ranges = findAnswerRanges(lines, 0, lines.length);
  assert.deepEqual(accentLines(lines, 0, ranges), [
    { row: 0, color: '#e6bb7c' },
    { row: 2, color: '#80c6c1' },
    { row: 3, color: '#9cc9e7' },
    { row: 4, color: '#dc8585' },
    { row: 5, color: '#86cda5' },
  ]);
});

test('multi-line diff runs color every changed row', () => {
  const lines = ['• 修改', '-old A', '-old B', '+new A', '+new B', '普通正文', '› 下一条'];
  assert.deepEqual(accentLines(lines, 0, findAnswerRanges(lines, 0, lines.length)), [
    { row: 0, color: '#e6bb7c' },
    { row: 1, color: '#dc8585' }, { row: 2, color: '#dc8585' },
    { row: 3, color: '#86cda5' }, { row: 4, color: '#86cda5' },
  ]);
});

test('prose headings and list items receive subtle warm emphasis', () => {
  const lines = ['• 结论', '# 背景', '正文保持原样。', '- 第一点', '2. 第二点', '› 下一条'];
  assert.deepEqual(accentLines(lines, 0, findAnswerRanges(lines, 0, lines.length)), [
    { row: 0, color: '#e6bb7c' },
    { row: 1, color: '#d6ae77' }, { row: 3, color: '#d6ae77' }, { row: 4, color: '#d6ae77' },
  ]);
});
