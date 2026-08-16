const test = require('node:test');
const assert = require('node:assert');
const { marked } = require('marked');
const {
  guardMarkdownLocalPaths,
  restoreMarkdownLocalPaths,
} = require('../renderer/markdown-local-path-guard.js');

function render(source) {
  const guard = guardMarkdownLocalPaths(source);
  return {
    guard,
    html: restoreMarkdownLocalPaths(
      marked.parse(guard.text, { breaks: true, gfm: true }),
      guard,
    ),
  };
}

test('preserves Markdown-sensitive backslashes in plain and inline-code paths', () => {
  const source = 'plain C:\\Vibe\\_scratch\\report.md and `C:\\Vibe\\_scratch\\report.md`';
  const { guard, html } = render(source);
  assert.ok(!guard.text.includes('C:\\Vibe'));
  assert.ok(html.includes('plain C:\\Vibe\\_scratch\\report.md'));
  assert.ok(html.includes('<code>C:\\Vibe\\_scratch\\report.md</code>'));
  assert.ok(!html.includes('Vibe_scratch'));
});

test('preserves a Windows path with spaces as a valid Markdown link destination', () => {
  const { html } = render('[报告](C:\\Vibe\\My Report\\final report.md)');
  assert.ok(html.includes('<a href="C:\\Vibe\\My Report\\final report.md">报告</a>'));
});

test('protects a file URL through Markdown and sanitizer boundaries', () => {
  const source = '[文件](file:///C:/Vibe/My%20Report/report.md)';
  const { guard, html } = render(source);
  assert.ok(!guard.text.includes('file:///'));
  assert.ok(html.includes('<a href="file:///C:/Vibe/My%20Report/report.md">文件</a>'));
});

test('preserves doubled separators for the later click-time repair stage', () => {
  const raw = 'C:\\\\Vibe\\\\_scratch\\\\report.md';
  const { html } = render(`path ${raw}`);
  assert.ok(html.includes(raw));
});

test('preserves Markdown-sensitive backslashes in a directory path without extension', () => {
  const raw = 'C:\\Vibe\\_scratch\\artifacts';
  const { html } = render(`folder ${raw}`);
  assert.ok(html.includes(raw));
  assert.ok(!html.includes('Vibe_scratch'));
});

test('HTML-escapes restored path text after sanitization boundary', () => {
  const { html } = render('C:\\Vibe\\safe&sound\\report.md');
  assert.ok(html.includes('safe&amp;sound'));
  assert.ok(!html.includes('safe&sound'));
});
