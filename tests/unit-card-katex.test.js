'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createTurnCardRenderer } = require(path.join(__dirname, '..', 'renderer', 'turn-card-renderer.js'));

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
for (const rel of [
  'renderer/vendor/katex/katex.min.css',
  'renderer/vendor/katex/katex.min.js',
  'renderer/vendor/katex/contrib/auto-render.min.js',
  'renderer/vendor/katex/LICENSE',
]) {
  assert.ok(fs.statSync(path.join(root, rel)).size > 0, `${rel} must be packaged locally`);
}
assert.ok(html.includes('vendor/katex/katex.min.css'));
assert.ok(html.includes('vendor/katex/katex.min.js'));
assert.ok(html.includes('vendor/katex/contrib/auto-render.min.js'));
assert.ok(!html.includes('cdn.jsdelivr.net/npm/katex'), 'formula rendering must not depend on the network');

function makeRenderer(renderMathInElement) {
  const doc = {
    addEventListener() {},
    querySelector() { return null; },
  };
  return createTurnCardRenderer({
    document: doc,
    window: { _sessionTurns: new Map() },
    navigator: {},
    CSS: {},
    marked: { parse: String },
    DOMPurify: { sanitize: String },
    formatAbsoluteTime: String,
    normalizeMarkdownPathBreaks: String,
    escapeHtml: String,
    renderMathInElement,
  });
}

let calls = 0;
let receivedOptions = null;
const renderer = makeRenderer((_body, options) => {
  calls += 1;
  receivedOptions = options;
});
const body = { dataset: {} };
const card = { querySelector(selector) { return selector === '.turn-body' ? body : null; } };
assert.strictEqual(renderer.postProcessCardMath(card), true);
assert.strictEqual(renderer.postProcessCardMath(card), false, 'the same card must not be rendered twice');
assert.strictEqual(calls, 1);
assert.deepStrictEqual(receivedOptions.delimiters.map(item => item.left), ['$$', '\\[', '\\(', '$']);
assert.strictEqual(receivedOptions.trust, false);
assert.strictEqual(receivedOptions.throwOnError, false);
assert.ok(receivedOptions.ignoredTags.includes('code'));
assert.ok(receivedOptions.ignoredTags.includes('pre'));

const failing = makeRenderer(() => { throw new Error('bad formula'); });
const failingBody = { dataset: {} };
const originalWarn = console.warn;
console.warn = () => {};
try {
  assert.strictEqual(failing.postProcessCardMath({ querySelector: () => failingBody }), false);
  assert.strictEqual(failingBody.dataset.mathRendered, undefined, 'failed math may be retried after a rerender');
} finally {
  console.warn = originalWarn;
}

console.log('unit-card-katex.test.js OK');
