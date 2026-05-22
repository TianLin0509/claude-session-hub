const test = require('node:test');
const assert = require('node:assert');
const { highlightMatch } = require('../renderer/past-session-modals.js');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

test('highlightMatch escapes text and wraps case-insensitive hit', () => {
  assert.strictEqual(
    highlightMatch('Open <Report.md>', 'report', escapeHtml),
    'Open &lt;<mark>Report</mark>.md&gt;'
  );
});

test('highlightMatch returns escaped text when query is empty', () => {
  assert.strictEqual(highlightMatch('<script>', '', escapeHtml), '&lt;script&gt;');
});
