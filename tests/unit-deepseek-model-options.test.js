'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_MODEL_BY_KIND,
  deepseekDisplayName,
  modelOptionsFor,
  normalizeDeepSeekModel,
  canonicalDeepSeekModelId,
} = require('../core/model-options.js');

// 2026-10-13：Codex 版 DeepSeek 走官方 API，默认 V4.1 Flash（官方名 deepseek-flash），Pro 照常可选。
test('DeepSeek Codex options expose V4.1 Flash (default) and V4 Pro', () => {
  assert.deepEqual(modelOptionsFor('deepseek').map(option => option.id), [
    'deepseek-flash',
    'deepseek-v4-pro',
  ]);
  assert.equal(DEFAULT_MODEL_BY_KIND.deepseek, 'deepseek-flash');
  assert.equal(modelOptionsFor('deepseek')[0].label, 'DeepSeek V4.1 Flash · Codex (1M)');
});

test('DeepSeek model normalization preserves supported Responses models and maps the old Flash name', () => {
  assert.equal(normalizeDeepSeekModel('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(normalizeDeepSeekModel('deepseek-flash'), 'deepseek-flash');
  assert.equal(normalizeDeepSeekModel('deepseek-v4-flash'), 'deepseek-flash');
  assert.equal(normalizeDeepSeekModel('deepseek-v4-flash[1m]'), 'deepseek-flash');
  assert.equal(normalizeDeepSeekModel(), 'deepseek-flash');
  assert.equal(normalizeDeepSeekModel('unknown'), 'deepseek-flash');
  assert.equal(deepseekDisplayName('deepseek-v4-pro'), 'DS V4 Pro · Codex 1M');
  assert.equal(deepseekDisplayName('deepseek-flash'), 'DS V4.1 Flash · Codex 1M');
  assert.equal(deepseekDisplayName('deepseek-v4-flash'), 'DS V4.1 Flash · Codex 1M');
});

test('canonicalDeepSeekModelId only renames the old Flash name and keeps unknown values for validation', () => {
  assert.equal(canonicalDeepSeekModelId('deepseek-v4-flash'), 'deepseek-flash');
  assert.equal(canonicalDeepSeekModelId('deepseek-v4-flash[1m]'), 'deepseek-flash');
  assert.equal(canonicalDeepSeekModelId('deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(canonicalDeepSeekModelId('deepseek-flash'), 'deepseek-flash');
  assert.equal(canonicalDeepSeekModelId('made-up'), 'made-up');
});

test('DSH legacy harness defaults to the Token Plan V4.1 Flash name', () => {
  assert.equal(DEFAULT_MODEL_BY_KIND['deepseek-acp'], 'deepseek-v4.1-flash');
  assert.equal(modelOptionsFor('deepseek-acp')[0].id, 'deepseek-v4.1-flash');
  assert.ok(modelOptionsFor('deepseek-acp').some(option => option.id === 'deepseek-v4-pro'), 'Pro stays selectable');
});

test('new Codex-runtime DeepSeek sessions (assistant, league, study) resolve to V4.1 Flash', () => {
  const { resolveDefaultModel } = require('../core/default-model-preference.js');
  assert.equal(resolveDefaultModel('deepseek', {}), 'deepseek-flash');
  // 用户以前存过旧名作默认值：启动时 normalizeDeepSeekModel 把它换成新名 deepseek-flash。
  assert.equal(normalizeDeepSeekModel(resolveDefaultModel('deepseek', { defaultModels: { deepseek: 'deepseek-v4-flash' } })), 'deepseek-flash');
  assert.equal(resolveDefaultModel('deepseek', { defaultModels: { deepseek: 'deepseek-v4-pro' } }), 'deepseek-v4-pro');
  assert.equal(resolveDefaultModel('deepseek-acp', {}), 'deepseek-v4.1-flash');
});
