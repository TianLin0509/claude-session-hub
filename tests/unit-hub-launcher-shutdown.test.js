'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { _private } = require('./helpers/hub-launcher.js');

function fakeHub({ code = 0, signal = null, alive = false } = {}) {
  return {
    label: 'isolated-shutdown-test',
    child: { exitCode: code, signalCode: signal },
    exitCode: () => code,
    exitSignal: () => signal,
    isAlive: () => alive,
    log: () => ['tail marker'],
  };
}

test('clean isolated Hub exit is accepted', () => {
  assert.deepStrictEqual(
    _private.requireCleanHubExit(fakeHub()),
    { code: 0, signal: null, forced: false },
  );
});

test('native crash exit is surfaced instead of being silently swallowed', () => {
  assert.throws(
    () => _private.requireCleanHubExit(fakeHub({ code: 0xC0000409 })),
    error => error.exitCode === 0xC0000409 && /did not exit cleanly/.test(error.message),
  );
});

test('targeted fallback termination is not reported as a graceful pass', () => {
  assert.throws(
    () => _private.requireCleanHubExit(fakeHub(), { forced: true }),
    error => error.forced === true,
  );
});

test('signal-only process exit is recognized as exited', () => {
  assert.equal(_private.hubHasExited(fakeHub({ code: null, signal: 'SIGTERM' })), true);
});
