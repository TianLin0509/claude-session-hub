'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { buildHubInstanceEnv, launchHubInstance } = require('../core/hub-instance-launcher.js');

test('new Hub preserves isolation and strips parent control/Node-mode environment without mutating it', () => {
  const source = {
    CLAUDE_HUB_DATA_DIR: 'test-data', CLAUDE_HUB_HOME_DIR: 'test-home', CODEX_HOME: 'test-codex',
    DEEPSEEK_API_KEY: '', Path: 'some-path', CLAUDE_HUB_E2E: '1',
    electron_run_as_node: '1', CLAUDECODE: '1', CLAUDE_HUB_PORT: '123', CLAUDE_HUB_TOKEN: 'secret',
    CLAUDE_HUB_SESSION_ID: 'old', CODEX_THREAD_ID: 'old', CODEX_SESSION_ID: 'old',
    AI_TEAM_HUB_CALLBACK_URL: 'old', CLAUDE_CODE_ENTRYPOINT: 'old', ARENA_HUB_TASK_ID: 'old',
  };
  assert.deepEqual(buildHubInstanceEnv(source), {
    CLAUDE_HUB_DATA_DIR: 'test-data', CLAUDE_HUB_HOME_DIR: 'test-home', CODEX_HOME: 'test-codex',
    DEEPSEEK_API_KEY: '', Path: 'some-path', CLAUDE_HUB_E2E: '1',
  });
  assert.equal(source.CLAUDE_HUB_TOKEN, 'secret');
});

for (const isPackaged of [false, true]) {
  test(`${isPackaged ? 'packaged' : 'source'} launch uses one root argument and independent process`, async () => {
    const appRoot = path.resolve('fixture Hub app');
    const execPath = path.resolve('fixture electron', 'Hub.exe');
    const child = new EventEmitter();
    child.pid = 12345;
    let unref = false;
    child.unref = () => { unref = true; };
    let call;
    const pending = launchHubInstance({ appRoot, execPath, isPackaged, env: {}, spawnImpl: (...args) => { call = args; return child; } });
    let settled = false;
    pending.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'must wait for OS spawn acknowledgement');
    child.emit('spawn');
    assert.deepEqual(await pending, { pid: 12345 });
    assert.equal(call[0], execPath);
    assert.deepEqual(call[1], isPackaged ? [] : [appRoot]);
    assert.equal(call[2].cwd, isPackaged ? path.dirname(execPath) : appRoot);
    assert.equal(call[2].detached, true);
    assert.equal(call[2].stdio, 'ignore');
    assert.equal(call[2].windowsHide, true);
    assert.equal(call[2].shell, undefined);
    assert.equal(unref, true);
  });
}

test('synchronous and asynchronous spawn errors reach the caller', async () => {
  const options = { appRoot: '.', execPath: process.execPath };
  await assert.rejects(launchHubInstance({ ...options, spawnImpl: () => { throw new Error('spawn denied'); } }), /spawn denied/);
  const child = new EventEmitter();
  const pending = launchHubInstance({ ...options, spawnImpl: () => child });
  const rejection = assert.rejects(pending, /ENOENT/);
  child.emit('error', new Error('ENOENT'));
  await rejection;
});
