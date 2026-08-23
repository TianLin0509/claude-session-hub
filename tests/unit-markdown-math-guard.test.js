'use strict';

const assert = require('node:assert/strict');
const { marked } = require('marked');
const {
  guardMarkdownMath,
  restoreMarkdownMath,
  _collectMarkdownCodeSpans,
  _collectMathSpans,
} = require('../renderer/markdown-math-guard.js');

const screenshotShape = [
  '每一条分别计算余弦相似度：',
  '',
  '\\[',
  '\\cos(\\widehat{PAS},PAS)',
  '=',
  '\\frac{\\widehat{PAS}\\cdot PAS}',
  '{\\|\\widehat{PAS}\\|\\|PAS\\|+10^{-300}}',
  '\\]',
  '',
  '如果间隔是 \\(\\Delta f\\)，继续。',
].join('\n');

const guarded = guardMarkdownMath(screenshotShape);
assert.equal(guarded.entries.length, 2, 'display and inline backslash math must both be guarded');
assert.equal(guarded.text.includes('\\cos'), false);

const markdownHtml = marked.parse(guarded.text, { breaks: true, gfm: true });
assert.equal(markdownHtml.includes('<h1>'), false, 'formula = line must not become a setext heading');
const restored = restoreMarkdownMath(markdownHtml, guarded);
assert.match(restored, /\\\[\n\\cos\(\\widehat\{PAS\},PAS\)/);
assert.match(restored, /\\\(\\Delta f\\\)/);

const multilineDollar = guardMarkdownMath('before\n\n$$a_b\n=\n\\frac{1}{2}$$\n\nafter');
assert.equal(multilineDollar.entries.length, 1);
const dollarHtml = restoreMarkdownMath(marked.parse(multilineDollar.text, { breaks: true }), multilineDollar);
assert.equal(dollarHtml.includes('<h1>'), false);
assert.match(dollarHtml, /\$\$a_b\n=\n\\frac\{1\}\{2\}\$\$/);

const unsafe = guardMarkdownMath('\\[\\text{a < b & c}\\]');
const unsafeRestored = restoreMarkdownMath(`<p>${unsafe.text}</p>`, unsafe);
assert.match(unsafeRestored, /a &lt; b &amp; c/);
assert.equal(unsafeRestored.includes('a < b'), false, 'restoration must not reintroduce raw HTML');

const codeSource = [
  '`inline \\(not math\\)` and \\(x+y\\)',
  '',
  '```text',
  '\\[not math\\]',
  '```',
].join('\n');
assert.equal(_collectMarkdownCodeSpans(codeSource).length, 2);
const codeGuard = guardMarkdownMath(codeSource);
assert.equal(codeGuard.entries.length, 1, 'math-looking delimiters inside code must stay outside the guard');
assert.equal(codeGuard.entries[0].raw, '\\(x+y\\)');

assert.equal(_collectMathSpans('unclosed \\[ formula').length, 0);
assert.deepEqual(guardMarkdownMath('plain text'), { text: 'plain text', entries: [] });

console.log('unit-markdown-math-guard OK');
