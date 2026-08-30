'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  buildIsolatedHubEnv,
  gracefulQuit,
  scrubParentControlEnv,
  _verifyCdpPortOwner,
} = require('./helpers/hub-launcher.js');

test('isolated Hub defaults cannot inherit the real home or DeepSeek key', () => {
  const dataDir = path.join(os.tmpdir(), 'hub-launcher-unit', 'hub-e2e-data');
  const env = buildIsolatedHubEnv(dataDir, {}, {
    CLAUDE_HUB_HOME_DIR: 'C:\\Users\\real-user',
    DEEPSEEK_API_KEY: 'real-secret',
    KEEP_ME: 'yes',
  });
  assert.equal(env.CLAUDE_HUB_DATA_DIR, dataDir);
  assert.equal(env.CLAUDE_HUB_HOME_DIR, path.join(dataDir, 'isolated-home'));
  assert.equal(env.CHUXIN_AGENT_LEAGUE_DIR, path.join(dataDir, 'agent-league'));
  assert.equal(env.DEEPSEEK_API_KEY, '');
  assert.equal(env.KEEP_ME, 'yes');
});

test('specialized E2E can explicitly override isolated defaults', () => {
  const env = buildIsolatedHubEnv('C:\\temp\\hub-e2e-data', {
    CLAUDE_HUB_HOME_DIR: 'C:\\temp\\custom-home',
    CHUXIN_AGENT_LEAGUE_DIR: 'C:\\temp\\custom-league',
    CODEX_HOME: 'C:\\temp\\codex-home',
    DEEPSEEK_API_KEY: 'fixture-key',
  }, {}, { allowExternalState: true });
  assert.equal(env.CLAUDE_HUB_HOME_DIR, 'C:\\temp\\custom-home');
  assert.equal(env.CHUXIN_AGENT_LEAGUE_DIR, 'C:\\temp\\custom-league');
  assert.equal(env.CODEX_HOME, 'C:\\temp\\codex-home');
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
  assert.throws(() => buildIsolatedHubEnv(dataDir, {
    CHUXIN_AGENT_LEAGUE_DIR: 'C:\\Users\\real-user\\league',
  }, {}), /requires CHUXIN_AGENT_LEAGUE_DIR inside the test root/);
  assert.throws(() => buildIsolatedHubEnv(dataDir, {
    CODEX_HOME: 'C:\\Users\\real-user\\.codex',
  }, {}), /requires CODEX_HOME inside the test root/);
  assert.throws(() => buildIsolatedHubEnv('C:\\Users\\real-user\\.claude-session-hub', {}, {}),
    /requires dataDir inside a dedicated OS temp subdirectory/);
});

test('hidden E2E window mode is explicit and forces E2E isolation', () => {
  const dataDir = path.join(os.tmpdir(), 'hub-launcher-unit', 'hidden-window');
  const env = buildIsolatedHubEnv(dataDir, {
    CLAUDE_HUB_E2E_WINDOW_MODE: 'visible',
  }, {}, { windowMode: 'hidden' });
  assert.equal(env.CLAUDE_HUB_E2E, '1');
  assert.equal(env.CLAUDE_HUB_E2E_WINDOW_MODE, 'hidden');
  assert.throws(() => buildIsolatedHubEnv(dataDir, {}, {}, { windowMode: 'minimized' }),
    /windowMode must be visible or hidden/);
});

test('isolated Hub strips parent CLI and Hub routing variables', () => {
  const clean = scrubParentControlEnv({
    KEEP_ME: 'yes',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'parent',
    CLAUDE_HUB_PORT: '3456',
    CLAUDE_HUB_TOKEN: 'secret',
    CLAUDE_HUB_SESSION_ID: 'parent-session',
    ARENA_HUB_PORT: '9999',
    AI_TEAM_HUB_CALLBACK_URL: 'http://parent',
    CODEX_THREAD_ID: 'parent-thread',
  });
  assert.deepEqual(clean, { KEEP_ME: 'yes' });

  const dataDir = path.join(os.tmpdir(), 'hub-launcher-unit', 'clean-parent-env');
  const env = buildIsolatedHubEnv(dataDir, {
    CLAUDE_HUB_PORT: 'fixture-port',
  }, {
    CLAUDE_HUB_PORT: 'parent-port',
    CLAUDE_CODE_ENTRYPOINT: 'parent',
  });
  assert.equal(env.CLAUDE_HUB_PORT, 'fixture-port', 'explicit fixture routing remains available');
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
});

test('CDP ownership verification binds the listener to the spawned PID', async () => {
  assert.equal(await _verifyCdpPortOwner(19871, 4242, async () => ({ stdout: '111,4242' })), true);
  assert.equal(await _verifyCdpPortOwner(19871, 4242, async () => ({ stdout: '111,222' })), false);
});

test('gracefulQuit rejects an already-crashed child instead of reporting success', async () => {
  const hub = {
    label: 'crashed-fixture',
    child: { exitCode: 7, signalCode: null },
    isAlive: () => false,
    exitCode: () => 7,
    exitSignal: () => null,
    spawnError: () => null,
    log: () => ['fatal fixture'],
  };
  await assert.rejects(() => gracefulQuit(hub), /exited before teardown: code=7/);
});

test('gracefulQuit rejects an unexpected clean exit before teardown', async () => {
  const hub = {
    label: 'early-clean-fixture',
    child: { exitCode: 0, signalCode: null },
    isAlive: () => false,
    exitCode: () => 0,
    exitSignal: () => null,
    spawnError: () => null,
    log: () => [],
  };
  await assert.rejects(() => gracefulQuit(hub), /exited before teardown was requested/);
  assert.deepStrictEqual(await gracefulQuit(hub, { allowAlreadyExited: true }), {
    exitCode: 0, exitSignal: null, forced: false,
  });
});
