'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { marked } = require('marked');
const { parseCardMarkdown } = require('../renderer/card-markdown');
const { guardMarkdownLocalPaths, restoreMarkdownLocalPaths } = require('../renderer/markdown-local-path-guard');

function render(text) {
  const guard = guardMarkdownLocalPaths(text);
  return restoreMarkdownLocalPaths(parseCardMarkdown(marked, guard.text), guard);
}

test('card image syntax displays a clickable destination instead of an inline image', () => {
  for (const target of ['C:\\图片\\_草稿\\图 A.png', './artifacts/chart.png', 'chart.png',
    'file:///C:/images/chart.png', 'https://example.test/chart.png']) {
    const html = render(`![结果图](<${target}>)`);
    assert(!html.includes('<img'), html);
    assert(html.includes(`<a href="${target}">${target}</a>`), html);
  }
});

test('reference images and progress text use links; code samples remain literal', () => {
  const html = render('进度：![图][chart]\n\n[chart]: ./chart.png\n\n`![示例](./code.png)`');
  assert(html.includes('<a href="./chart.png">./chart.png</a>'), html);
  assert(html.includes('<code>![示例](./code.png)</code>'), html);
  assert(!html.includes('<img'), html);
});

test('card rendering leaves normal Markdown image previews unchanged', () => {
  const text = '![图](./chart.png)';
  assert(!render(text).includes('<img'));
  assert(marked.parse(text).includes('<img'));
});

test('image labels are escaped and inline data never becomes a huge visible path', () => {
  assert(render('![图](<https://example.test/a.png?a=1&b=2>)').includes('>https://example.test/a.png?a=1&amp;b=2</a>'));
  const html = render('![内嵌图片](data:image/png;base64,aGVsbG8=)');
  assert(html.includes('>内嵌图片</button>'), html);
  assert(html.includes('data-action="card-open-image"'), html);
  assert(!html.includes('<img'), html);
});

test('linked images retain their destination without nested anchors', () => {
  const html = render('[![图](./chart.png)](https://example.test/report)');
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert(html.includes('<a href="https://example.test/report">./chart.png</a>'), html);
});
