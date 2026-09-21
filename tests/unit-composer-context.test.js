'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composerContextRing, buildSessionStatusSummary } = require('../core/session-status-summary');
const { createComposerContext } = require('../renderer/composer-context');

function documentFixture() {
  return { createElement() { return {
    children: [], attributes: {}, style: { setProperty() {} }, dataset: {},
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); },
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
  }; } };
}

test('context number is remaining, ring severity is used, unknown never becomes 100%', () => {
  const indicator = createComposerContext(documentFixture());
  for (const [used, remaining, level] of [[19, '81%', 'ok'], [0, '100%', 'ok'], [100, '0%', 'danger'], [92, '8%', 'danger']]) {
    indicator.update(composerContextRing({contextPct: used}), 'Codex 1');
    assert.equal(indicator.element.hidden, false);
    assert.equal(indicator.element.children[0].textContent, remaining);
    assert.equal(indicator.element.children[1].dataset.level, level);
    assert.match(indicator.element.attributes['aria-label'], new RegExp('Codex 1，上下文剩余 '+remaining));
  }
  for (const unknown of [null, undefined, '', NaN, 'unknown']) {
    const state = {contextPct: unknown};
    indicator.update(composerContextRing(state));
    assert.equal(indicator.element.hidden, true);
    assert.equal(indicator.element.children[0].textContent, '');
    assert.equal(indicator.element.attributes.title, undefined);
    assert.equal(buildSessionStatusSummary(state).contextLeft, null);
  }
});
