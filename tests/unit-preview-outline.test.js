'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { marked } = require('marked');

const {
  cleanHeadingText,
  createHeadingSlug,
  extractMarkdownOutline,
  formatPreviewReference,
} = require('../renderer/preview-outline.js');

test('extractMarkdownOutline supports ATX, setext, duplicates and fenced code', () => {
  const source = [
    '# Overview',
    '',
    '## **Architecture** v2',
    '',
    'Architecture',
    '------------',
    '',
    '\x60\x60\x60md',
    '# Not a heading',
    '\x60\x60\x60',
    '',
    '## 中文 标题',
  ].join('\n');
  assert.deepEqual(extractMarkdownOutline(source, marked.lexer(source)), [
    { level: 1, text: 'Overview', line: 1, anchor: 'overview' },
    { level: 2, text: 'Architecture v2', line: 3, anchor: 'architecture-v2' },
    { level: 2, text: 'Architecture', line: 5, anchor: 'architecture' },
    { level: 2, text: '中文 标题', line: 12, anchor: '中文-标题' },
  ]);
});

test('outline follows the same Marked token stream for blockquotes and long fences', () => {
  const source = [
    '> # Quoted',
    '',
    '## Plain',
    '',
    '\x60\x60\x60\x60md',
    '\x60\x60\x60not-a-close',
    '# Still code',
    '\x60\x60\x60',
    '\x60\x60\x60\x60',
    '',
    '### End',
  ].join('\n');
  assert.deepEqual(extractMarkdownOutline(source, marked.lexer(source)), [
    { level: 1, text: 'Quoted', line: 1, anchor: 'quoted' },
    { level: 2, text: 'Plain', line: 3, anchor: 'plain' },
    { level: 3, text: 'End', line: 11, anchor: 'end' },
  ]);
});

test('empty headings stay in alignment metadata but are omitted from the visible outline', () => {
  const source = '#\n## Real';
  const tokens = marked.lexer(source);
  assert.deepEqual(extractMarkdownOutline(source, tokens), [
    { level: 2, text: 'Real', line: 2, anchor: 'real' },
  ]);
  assert.deepEqual(extractMarkdownOutline(source, tokens, { includeEmpty: true }), [
    { level: 1, text: '', line: 1, anchor: null },
    { level: 2, text: 'Real', line: 2, anchor: 'real' },
  ]);
});

test('heading text and slugs remain stable for links and duplicates', () => {
  assert.equal(cleanHeadingText('[API](https://example.com) & **Safety**'), 'API & Safety');
  const used = new Map();
  assert.equal(createHeadingSlug('API & Safety', used), 'api-safety');
  assert.equal(createHeadingSlug('API & Safety', used), 'api-safety-1');
});

test('formatPreviewReference keeps local line and heading anchors readable', () => {
  assert.equal(
    formatPreviewReference('C:\\work\\report.md', { line: 12, anchor: 'risk-control' }),
    'C:\\work\\report.md:12#risk-control',
  );
  assert.equal(
    formatPreviewReference('https://example.com/report#old', { line: 9, anchor: '结论' }),
    'https://example.com/report#结论',
  );
  assert.equal(formatPreviewReference('C:\\work\\app.js', { line: 42 }), 'C:\\work\\app.js:42');
});
