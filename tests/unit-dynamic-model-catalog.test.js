'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildClaudeModelSnapshot,
  humanizeClaudeModelId,
} = require('../core/claude-model-catalog.js');
const {
  buildCodexModelOptions,
  buildCodexTuningSnapshot,
} = require('../core/codex-model-catalog.js');
const {
  clearRuntimeModelOptions,
  modelOptionsFor,
  setRuntimeModelOptions,
} = require('../core/model-options.js');

test('Claude account cache promotes Fable 5.1 while stable aliases remain available', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-model-catalog-'));
  try {
    fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({
      additionalModelOptionsCache: {
        value: 'claude-fable-5-1[1m]',
        label: 'Fable',
        description: 'Fable 5.1 for long-running tasks',
      },
    }), 'utf8');
    const snapshot = buildClaudeModelSnapshot({ configDir: root, homeDir: root });
    assert.equal(snapshot.catalogLoaded, true);
    assert.equal(snapshot.source, 'claude-cli-cache');
    assert.equal(snapshot.models[0].id, 'claude-fable-5-1[1m]');
    assert.equal(snapshot.models[0].label, 'Fable 5.1 (1M context)');
    assert.ok(snapshot.models.some(model => model.id === 'fable'));
    assert.ok(snapshot.models.some(model => model.id === 'opus'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(humanizeClaudeModelId('claude-sonnet-5'), 'Sonnet 5');
});

test('Codex visible model list comes from CLI order and excludes hidden helpers', () => {
  const options = buildCodexModelOptions([
    { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', priority: 2, hidden: false },
    { id: 'codex-auto-review', displayName: 'Review helper', priority: 1, hidden: true },
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', priority: 1, hidden: false },
  ]);
  assert.deepEqual(options.map(option => option.id), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.equal(options[0].source, 'codex-app-server');
});

test('live Codex model capabilities merge with cache-only context metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-model-catalog-'));
  try {
    fs.writeFileSync(path.join(root, 'models_cache.json'), JSON.stringify({ models: [{
      slug: 'gpt-5.6-sol',
      visibility: 'list',
      max_context_window: 872000,
      effective_context_window_percent: 95,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }],
    }] }), 'utf8');
    const snapshot = buildCodexTuningSnapshot([], {
      configDir: root,
      models: [{
        id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', hidden: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'max' }],
        serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Priority' }],
      }],
    });
    assert.equal(snapshot.source, 'codex-app-server');
    assert.deepEqual(snapshot.models.map(model => model.id), ['gpt-5.6-sol']);
    assert.equal(snapshot.byModel['gpt-5.6-sol'].maxContextWindow, 872000);
    assert.equal(snapshot.byModel['gpt-5.6-sol'].estimatedMaxEffectiveContextWindow, 828400);
    assert.equal(snapshot.byModel['gpt-5.6-sol'].supportsFast, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderer runtime catalog replaces stale static options without mutating fallback', () => {
  const before = modelOptionsFor('codex').map(option => option.id);
  try {
    setRuntimeModelOptions('codex', [
      { id: 'gpt-5.6-sol', label: 'Sol' },
      { id: 'gpt-5.6-terra', label: 'Terra' },
    ]);
    assert.deepEqual(modelOptionsFor('codex').map(option => option.id), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  } finally {
    clearRuntimeModelOptions('codex');
  }
  assert.deepEqual(modelOptionsFor('codex').map(option => option.id), before);
});
