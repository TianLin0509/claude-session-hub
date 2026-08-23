'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MODEL_BY_KIND,
  deepseekDisplayName,
  modelOptionsFor,
  normalizeDeepSeekModel,
} = require('../core/model-options.js');

test('DeepSeek new-session options expose Pro and Flash with Flash as default', () => {
  assert.deepEqual(modelOptionsFor('deepseek').map(option => option.id), [
    'deepseek-v4-pro',
    'deepseek-v4-flash',
  ]);
  assert.equal(DEFAULT_MODEL_BY_KIND.deepseek, 'deepseek-v4-flash');
});

test('DeepSeek model normalization preserves supported Responses models', () => {
  assert.equal(normalizeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(normalizeDeepSeekModel('deepseek-v4-flash[1m]'), 'deepseek-v4-flash');
  assert.equal(normalizeDeepSeekModel('unknown'), 'deepseek-v4-flash');
  assert.equal(deepseekDisplayName('deepseek-v4-pro'), 'DS V4 Pro · Codex 1M');
});
