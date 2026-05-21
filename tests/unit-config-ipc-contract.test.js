'use strict';

const assert = require('assert');
const {
  buildConfigJsonUpdate,
  toEditableConfig,
  toMaskedConfig,
} = require('../main/ipc/config-handlers.js');

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

test('masked config preserves public fields and masks secrets', () => {
  const masked = toMaskedConfig({
    proxy: 'http://127.0.0.1:7890',
    deepseekApiKey: 'sk-deepseek-1234',
    glmApiKey: '',
    glmBaseUrl: 'https://glm.test',
    glmModel: 'glm-model',
    gptApiKey: 'sk-gpt-abcdef',
    gptBaseUrl: 'https://gpt.test',
    gptModel: 'gpt-model',
    kimiApiKey: '',
    kimiBaseUrl: 'https://kimi.test',
    kimiModel: 'kimi-model',
    qwenApiKey: 'sk-qwen-9999',
    qwenBaseUrl: 'https://qwen.test',
    qwenModel: 'qwen-model',
    codexBackend: 'subscription',
    codexSubscriptionProfile: 'default',
    codexSubscriptionProfiles: [{ id: 'default', label: 'Default', home: '' }],
    codexApiKey: 'sk-codex-5555',
    codexApiBaseUrl: 'https://codex.test',
    codexApiModel: 'gpt-5.5',
  });

  assert.strictEqual(masked.deepseekApiKey, '***1234');
  assert.strictEqual(masked.deepseekApiKeySet, true);
  assert.strictEqual(masked.glmApiKey, '');
  assert.strictEqual(masked.glmApiKeySet, false);
  assert.strictEqual(masked.codexApiKey, '***5555');
  assert.strictEqual(masked.codexApiKeySet, true);
  assert.strictEqual(masked.codexSubscriptionProfiles.length, 1);
});

test('editable config preserves raw editable values', () => {
  const editable = toEditableConfig({
    proxy: 'http://127.0.0.1:7890',
    deepseekApiKey: 'sk-deepseek',
    glmApiKey: 'sk-glm',
    glmBaseUrl: 'https://glm.test',
    glmModel: 'glm-model',
    gptApiKey: 'sk-gpt',
    gptBaseUrl: 'https://gpt.test',
    gptModel: 'gpt-model',
    kimiApiKey: '',
    kimiBaseUrl: 'https://kimi.test',
    kimiModel: 'kimi-model',
    qwenApiKey: '',
    qwenBaseUrl: 'https://qwen.test',
    qwenModel: 'qwen-model',
    codexBackend: 'api',
    codexSubscriptionProfile: 'second',
    codexSubscriptionProfiles: [],
    codexApiKey: 'sk-codex',
    codexApiBaseUrl: 'https://codex.test',
    codexApiModel: 'gpt-5.5',
    packySessionCookie: 'session=abc',
    uiToolFoldThreshold: 12,
    uiCodeFoldThreshold: 34,
  });

  assert.strictEqual(editable.deepseekApiKey, 'sk-deepseek');
  assert.strictEqual(editable.codexApiKey, 'sk-codex');
  assert.strictEqual(editable.packySessionCookie, 'session=abc');
  assert.strictEqual(editable.uiToolFoldThreshold, 12);
  assert.strictEqual(editable.uiCodeFoldThreshold, 34);
});

test('save payload keeps existing provider data and removes blank secrets', () => {
  const existing = {
    providers: {
      glm: { extra: 'keep', api_key: 'old-glm' },
      packy: { session_cookie: 'old-cookie' },
    },
    custom: true,
  };
  const merged = buildConfigJsonUpdate(existing, {
    proxy: '',
    deepseekApiKey: '',
    glmApiKey: '',
    glmBaseUrl: 'https://glm.new',
    glmModel: 'glm-new',
    gptApiKey: 'sk-gpt',
    gptBaseUrl: '',
    gptModel: '',
    kimiApiKey: '',
    kimiBaseUrl: '',
    kimiModel: '',
    qwenApiKey: '',
    qwenBaseUrl: '',
    qwenModel: '',
    codexBackend: 'api',
    codexSubscriptionProfile: 'second',
    codexSubscriptionProfiles: [{ id: 'second', label: 'Second', home: 'C:\\CodexSecond' }],
    codexApiKey: '',
    codexApiBaseUrl: '',
    codexApiModel: '',
    packySessionCookie: '',
  });

  assert.strictEqual(merged.custom, true);
  assert.strictEqual(merged.providers.glm.extra, 'keep');
  assert.strictEqual(merged.providers.glm.base_url, 'https://glm.new');
  assert.ok(!Object.prototype.hasOwnProperty.call(merged.providers.glm, 'api_key'));
  assert.strictEqual(merged.providers.gpt.api_key, 'sk-gpt');
  assert.ok(!Object.prototype.hasOwnProperty.call(merged.providers.packy, 'session_cookie'));
  assert.strictEqual(merged.providers.codex.backend, 'api');
  assert.strictEqual(merged.providers.codex.subscription_profile, 'second');
  assert.strictEqual(merged.providers.codex.subscription_profiles[0].id, 'second');
});

console.log('All config IPC contract tests passed.');
