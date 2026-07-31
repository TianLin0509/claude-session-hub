'use strict';

const assert = require('assert');
const {
  buildConfigJsonUpdate,
  toEditableConfig,
  toMaskedConfig,
} = require('../main/ipc/config-handlers.js');
const { DEFAULTS } = require('../core/hub-config.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running config IPC contract tests...');

test('Claude defaults keep subscription active and preload the Fable gateway preset', () => {
  assert.strictEqual(DEFAULTS.claude_backend, 'subscription');
  assert.strictEqual(DEFAULTS.claude_api_base_url, 'http://3.142.133.116:8080');
  assert.strictEqual(DEFAULTS.claude_api_model, 'claude-fable-5');
});

test('masked config exposes only retained public fields and masks secrets', () => {
  const masked = toMaskedConfig({
    proxy: 'http://127.0.0.1:7890',
    claudeBackend: 'api',
    claudeApiKey: 'sk-claude-9999',
    claudeApiBaseUrl: 'https://claude-gateway.example.com',
    claudeApiModel: 'claude-fable-5',
    deepseekApiKey: 'sk-deepseek-1234',
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'default',
    codexSubscriptionProfiles: [{ id: 'default', label: 'Default', home: '' }],
    codexApiKey: 'sk-codex-5555',
    codexApiBaseUrl: 'https://codex.test',
    codexApiModel: 'gpt-5.5',
  });

  assert.strictEqual(masked.claudeApiKey, '***9999');
  assert.strictEqual(masked.claudeApiKeySet, true);
  assert.strictEqual(masked.claudeApiBaseUrl, 'https://claude-gateway.example.com');
  assert.strictEqual(masked.deepseekApiKey, '***1234');
  assert.strictEqual(masked.deepseekApiKeySet, true);
  assert.strictEqual(masked.codexApiKey, '***5555');
  assert.strictEqual(masked.codexApiKeySet, true);
  assert.strictEqual(masked.codexSubscriptionProfiles.length, 1);
  for (const removedField of ['packySessionCookie', 'glmApiKey', 'kimiApiKey', 'qwenApiKey']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(masked, removedField),
      `${removedField} should not be exposed`);
  }
});

test('editable config preserves only retained editable values', () => {
  const editable = toEditableConfig({
    proxy: 'http://127.0.0.1:7890',
    claudeBackend: 'api',
    claudeApiKey: 'sk-claude',
    claudeApiBaseUrl: 'http://3.142.133.116:8080',
    claudeApiModel: 'claude-fable-5',
    deepseekApiKey: 'sk-deepseek',
    codexBackend: 'api',
    codexSubscriptionProfile: 'second',
    codexSubscriptionProfiles: [],
    codexApiKey: 'sk-codex',
    codexApiBaseUrl: 'https://codex.test',
    codexApiModel: 'gpt-5.5',
    uiToolFoldThreshold: 12,
    uiCodeFoldThreshold: 34,
    cardFontSize: 18,
    cardFontFamily: 'serif',
  });

  assert.strictEqual(editable.claudeApiKey, 'sk-claude');
  assert.strictEqual(editable.claudeApiModel, 'claude-fable-5');
  assert.strictEqual(editable.deepseekApiKey, 'sk-deepseek');
  assert.strictEqual(editable.codexApiKey, 'sk-codex');
  assert.strictEqual(editable.uiToolFoldThreshold, 12);
  assert.strictEqual(editable.uiCodeFoldThreshold, 34);
  assert.strictEqual(editable.cardFontSize, 18);
  assert.strictEqual(editable.cardFontFamily, 'serif');
  for (const removedField of ['packySessionCookie', 'glmApiKey', 'gptApiKey', 'kimiApiKey', 'qwenApiKey']) {
    assert.ok(!Object.prototype.hasOwnProperty.call(editable, removedField),
      `${removedField} should not be editable`);
  }
});

test('save payload updates retained fields without deleting unrelated provider data', () => {
  const existing = {
    providers: {
      claude: { backend: 'subscription', base_url: 'https://old.claude', model: 'old-model' },
      deepseek: { api_key: 'old-deepseek' },
      codex: { backend: 'subscription', subscription_profile: 'default' },
      glm: { api_key: 'old-glm' },
      gpt: { api_key: 'old-gpt' },
      kimi: { api_key: 'old-kimi' },
      qwen: { api_key: 'old-qwen' },
      packy: { session_cookie: 'old-cookie' },
      meridian: { url: 'https://meridian.old', token: 'old-token', enabled: true },
    },
    custom: true,
  };
  const merged = buildConfigJsonUpdate(existing, {
    proxy: '',
    claudeBackend: 'api',
    claudeApiKey: 'sk-new-claude',
    claudeApiBaseUrl: 'https://claude-gateway.example.com',
    claudeApiModel: 'claude-opus-packy',
    deepseekApiKey: '',
    codexBackend: 'api',
    codexSubscriptionProfile: 'second',
    codexSubscriptionProfiles: [{ id: 'second', label: 'Second', home: 'C:\\CodexSecond' }],
    codexApiKey: '',
    codexApiBaseUrl: '',
    codexApiModel: '',
  });

  assert.strictEqual(merged.custom, true);
  assert.strictEqual(merged.providers.claude.backend, 'api');
  assert.strictEqual(merged.providers.claude.api_key, 'sk-new-claude');
  assert.strictEqual(merged.providers.claude.base_url, 'https://claude-gateway.example.com');
  assert.strictEqual(merged.providers.claude.model, 'claude-opus-packy');
  assert.ok(!Object.prototype.hasOwnProperty.call(merged.providers.deepseek, 'api_key'));
  assert.strictEqual(merged.providers.codex.backend, 'api');
  assert.strictEqual(merged.providers.codex.subscription_profile, 'second');
  assert.strictEqual(merged.providers.codex.subscription_profiles[0].id, 'second');
  for (const preservedProvider of ['glm', 'gpt', 'kimi', 'qwen', 'packy', 'meridian']) {
    assert.deepStrictEqual(merged.providers[preservedProvider], existing.providers[preservedProvider],
      `${preservedProvider} provider should survive an unrelated settings save`);
  }
});

test('subscription selection preserves the ready-to-switch Fable gateway credentials', () => {
  const merged = buildConfigJsonUpdate({ providers: {} }, {
    claudeBackend: 'subscription',
    claudeApiKey: 'sk-fable-ready',
    claudeApiBaseUrl: 'http://3.142.133.116:8080',
    claudeApiModel: 'claude-fable-5',
    codexBackend: 'subscription',
  });

  assert.strictEqual(merged.providers.claude.backend, 'subscription');
  assert.strictEqual(merged.providers.claude.api_key, 'sk-fable-ready');
  assert.strictEqual(merged.providers.claude.base_url, 'http://3.142.133.116:8080');
  assert.strictEqual(merged.providers.claude.model, 'claude-fable-5');
});

console.log('All config IPC contract tests passed.');
