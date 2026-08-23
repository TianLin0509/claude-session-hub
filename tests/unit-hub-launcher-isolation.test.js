'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { buildIsolatedHubEnv } = require('./helpers/hub-launcher.js');

test('isolated Hub defaults cannot inherit the real home or DeepSeek key', () => {
  const dataDir = path.join(os.tmpdir(), 'hub-launcher-unit', 'hub-e2e-data');
  const env = buildIsolatedHubEnv(dataDir, {}, {
    CLAUDE_HUB_HOME_DIR: 'C:\\Users\\real-user',
    DEEPSEEK_API_KEY: 'real-secret',
    KEEP_ME: 'yes',
  });
  assert.equal(env.CLAUDE_HUB_DATA_DIR, dataDir);
  assert.equal(env.CLAUDE_HUB_HOME_DIR, path.join(dataDir, 'isolated-home'));
  assert.equal(env.DEEPSEEK_API_KEY, '');
  assert.equal(env.KEEP_ME, 'yes');
});

test('specialized E2E can explicitly override isolated defaults', () => {
  const env = buildIsolatedHubEnv('C:\\temp\\hub-e2e-data', {
    CLAUDE_HUB_HOME_DIR: 'C:\\temp\\custom-home',
    DEEPSEEK_API_KEY: 'fixture-key',
  }, {}, { allowExternalState: true });
  assert.equal(env.CLAUDE_HUB_HOME_DIR, 'C:\\temp\\custom-home');
  assert.equal(env.DEEPSEEK_API_KEY, 'fixture-key');
});

test('ordinary E2E cannot override safety-critical isolation variables', () => {
  const dataDir = path.join(os.tmpdir(), 'hub-launcher-unit', 'hub-data');
  assert.throws(() => buildIsolatedHubEnv(dataDir, {
    CLAUDE_HUB_HOME_DIR: 'C:\\Users\\real-user',
  }, {}), /requires CLAUDE_HUB_HOME_DIR inside the test root/);
  assert.throws(() => buildIsolatedHubEnv(dataDir, {
    DEEPSEEK_API_KEY: 'real-secret',
  }, {}), /forbids a non-empty DEEPSEEK_API_KEY/);
  assert.throws(() => buildIsolatedHubEnv(dataDir, {
    CLAUDE_HUB_DATA_DIR: 'C:\\Users\\real-data',
  }, {}), /forbids overriding CLAUDE_HUB_DATA_DIR/);
  assert.throws(() => buildIsolatedHubEnv('C:\\Users\\real-user\\.claude-session-hub', {}, {}),
    /requires dataDir inside a dedicated OS temp subdirectory/);
});
