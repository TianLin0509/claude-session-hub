'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { adaptSource, COMPOSER, PROFILE } = require('../core/chatgpt-selector-compat');
test('old tool selectors cover the observed modern DOM without modifying prompt literals', () => {
  const prompt = "Keep #prompt-textarea and page.locator('#prompt-textarea') verbatim";
  const source = `async page => { const prompt=${JSON.stringify(prompt)}; return [page.locator('#prompt-textarea'),page.getByTestId('send-button'),prompt]; }`;
  const adapted = new Function('return (' + adaptSource(source) + ')')();
  return adapted({ locator: s => s }).then(value => {
    assert.equal(value[0], COMPOSER);
    assert.match(value[1], /aria-label="Send"/);
    assert.equal(value[2], prompt);
  });
});
test('website probes and nested image-tool selectors also recognize both layouts', () => {
  const source = `() => [document.querySelector('[data-testid="accounts-profile-button"]'),document.querySelector('#prompt-textarea [data-inline-selection-pill]')]`;
  const adapted = new Function('document', 'return (' + adaptSource(source) + ')()');
  assert.deepEqual(adapted({ querySelector: s => s }), [PROFILE, COMPOSER + ' [data-inline-selection-pill]']);
});
