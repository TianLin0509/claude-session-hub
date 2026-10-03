'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createTurnCardRenderer } = require('../renderer/turn-card-renderer');

function fixture(copyText) {
  const handlers = [];
  let browserWrites = 0;
  const doc = { addEventListener(type, fn) { if (type === 'click') handlers.push(fn); }, querySelectorAll: () => [] };
  createTurnCardRenderer({ document: doc, window: {}, copyText, navigator: { clipboard: {
    writeText() { browserWrites++; return Promise.resolve(); },
  } } });
  const button = { textContent: 'Copy', parentElement: { querySelector: () => ({ textContent: '中文代码 🧪' }) } };
  const target = { closest: selector => selector === '[data-action="code-copy"]' ? button : null };
  return { button, browserWrites: () => browserWrites, async click() {
    handlers.forEach(fn => fn({ target }));
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test('card code copy uses the injected verified writer and preserves Unicode', async () => {
  let actual;
  const f = fixture(async value => { actual = value; return { ok: true }; });
  await f.click();
  assert.equal(actual, '中文代码 🧪');
  assert.equal(f.browserWrites(), 0);
  assert.equal(f.button.textContent, '✓ Copied');
});

test('card code copy surfaces a failed verification', async () => {
  const f = fixture(async () => ({ ok: false, reason: 'clipboard verification mismatch' }));
  await f.click();
  assert.equal(f.browserWrites(), 0);
  assert.equal(f.button.textContent, '复制失败');
});
