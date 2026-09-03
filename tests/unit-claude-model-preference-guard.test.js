'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  captureClaudeModelPreference,
  claudePreferenceMatchesTarget,
  restoreClaudeModelPreference,
} = require('../core/claude-model-preference-guard.js');

function withSettings(initial, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-model-pref-'));
  const settingsPath = path.join(root, 'settings.json');
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');
    fn(settingsPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('restores the prior Claude default after an in-session model switch', () => {
  withSettings({ model: 'claude-opus-5', effortLevel: 'max' }, settingsPath => {
    const snapshot = captureClaudeModelPreference('claude-fable-5-1[1m]', { settingsPath });
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'claude-fable-5-1[1m]', effortLevel: 'max' }), 'utf8');
    const result = restoreClaudeModelPreference(snapshot);
    assert.equal(result.restored, true);
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(saved.model, 'claude-opus-5');
    assert.equal(saved.effortLevel, 'max');
  });
});

test('removes a temporary default when no default existed before', () => {
  withSettings({ effortLevel: 'high' }, settingsPath => {
    const snapshot = captureClaudeModelPreference('fable', { settingsPath });
    fs.writeFileSync(settingsPath, JSON.stringify({ effortLevel: 'high', model: 'fable' }), 'utf8');
    assert.equal(restoreClaudeModelPreference(snapshot).status, 'removed-temporary-default');
    const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(saved, 'model'), false);
  });
});

test('compare-and-swap does not overwrite a concurrent user model change', () => {
  withSettings({ model: 'opus' }, settingsPath => {
    const snapshot = captureClaudeModelPreference('fable', { settingsPath });
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'sonnet' }), 'utf8');
    const result = restoreClaudeModelPreference(snapshot);
    assert.equal(result.restored, false);
    assert.equal(result.status, 'changed-externally');
    assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).model, 'sonnet');
  });
});

test('latest-family aliases also match the exact model persisted by Claude Code', () => {
  assert.equal(claudePreferenceMatchesTarget('claude-fable-5-1[1m]', 'fable'), true);
  assert.equal(claudePreferenceMatchesTarget('claude-opus-5', 'opus'), true);
  assert.equal(claudePreferenceMatchesTarget('claude-sonnet-5', 'fable'), false);
});
