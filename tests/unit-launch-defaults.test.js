'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readLaunchDefaults, withLaunchDefaultsInJson } = require('../core/launch-defaults');
const { creationDefaults } = require('../core/session-creation-defaults');

test('save all five choices atomically, keep other providers/settings and legacy model callers', () => {
  const before = { custom: 42, providers: { codex: { subscription_profile: 'default', api_key: 'keep' } },
    models: { defaults: { claude: 'claude-sonnet-5' } }, launch: { extra: true, defaults: { claude: { fastMode: false } } } };
  const selection = { model: 'gpt-6-astra', effort: 'max', mcpProfile: 'browser', codexSpeedTier: 'fast', codexProfile: 'second' };
  const after = withLaunchDefaultsInJson(before, 'codex', selection, { profileIds: ['default', 'second'] });
  const { model, ...tuning } = selection;
  assert.deepEqual(after.launch.defaults.codex, tuning);
  assert.equal(after.models.defaults.codex, model);
  assert.equal(after.models.defaults.claude, before.models.defaults.claude);
  assert.deepEqual(after.launch.defaults.claude, { fastMode: false });
  assert.equal(after.launch.extra, true);
  assert.equal(after.providers, before.providers);
  assert.equal(after.custom, 42);
  assert.equal(before.launch.defaults.codex, undefined);
});

test('invalid effort, speed, account or model fails without partially updating defaults', () => {
  for (const change of [{ effort: 'bad' }, { codexSpeedTier: 'slow' }, { codexProfile: 'removed' }, { model: 'gpt-6; rm x' }]) {
    const before = { models: { defaults: { codex: 'gpt-6-astra' } } };
    assert.throws(() => withLaunchDefaultsInJson(before, 'codex', { model: 'gpt-6-astra', ...change }, { profileIds: ['default'] }));
    assert.deepEqual(before, { models: { defaults: { codex: 'gpt-6-astra' } } });
  }
});

test('read old config and ignore malformed, foreign and unsafe fields', () => {
  assert.deepEqual(readLaunchDefaults({ defaultModels: { codex: 'gpt-6-astra' } }), {});
  assert.deepEqual(readLaunchDefaults({ launchDefaults: { codex: { effort: 'high', codexProfile: '../secret', fastMode: true, codexSpeedTier: 'bad' },
    claude: { fastMode: false, effort: 'ultra' }, qwen: { mcpProfile: 'full' }, unknown: { effort: 'high' } } }),
  { codex: { effort: 'high' }, claude: { fastMode: false }, qwen: {} });
});

test('false Fast and explicit inherit survive persistence and creation; defaults stay per provider', () => {
  const claude = withLaunchDefaultsInJson({}, 'claude', { model: 'claude-sonnet-5', effort: 'medium', mcpProfile: 'none', fastMode: false });
  const saved = withLaunchDefaultsInJson(claude, 'codex', { model: 'gpt-6-astra', effort: 'max', mcpProfile: 'lean', codexSpeedTier: 'inherit', codexProfile: 'second' });
  const config = { defaultModels: saved.models.defaults, launchDefaults: saved.launch.defaults,
    codexSubscriptionProfile: 'default', codexSubscriptionProfiles: [{ id: 'default' }, { id: 'second' }] };
  assert.deepEqual(creationDefaults('claude', config), { model: 'claude-sonnet-5', effort: 'medium', mcpProfile: 'none', fastMode: false });
  assert.deepEqual(creationDefaults('codex', config), { model: 'gpt-6-astra', effort: 'max', mcpProfile: 'lean', codexSpeedTier: 'inherit', codexProfile: 'second', codexAccountScope: 'session' });
  config.codexSubscriptionProfiles = [{ id: 'default' }];
  assert.equal(creationDefaults('codex', config).codexProfile, 'default');
});
