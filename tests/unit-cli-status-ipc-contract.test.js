'use strict';

const assert = require('assert');
const { isCliReady, registerCliStatusIpc } = require('../main/ipc/cli-status-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function createDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    cliReadyDetector: {
      markReady(sessionId) {
        calls.push(['markReady', sessionId]);
      },
      isReady(sessionId, kind, buffer) {
        calls.push(['isReady', sessionId, kind, buffer]);
        return buffer.includes('READY');
      },
    },
    sessionManager: {
      getSession(sessionId) {
        calls.push(['getSession', sessionId]);
        if (sessionId === 'missing') return null;
        return { id: sessionId, kind: 'codex' };
      },
      getGroupChatReady(sessionId) {
        calls.push(['getGroupChatReady', sessionId]);
        return sessionId === 'fast';
      },
      getSessionBuffer(sessionId) {
        calls.push(['getSessionBuffer', sessionId]);
        return sessionId === 'ready' ? 'READY marker' : 'not yet';
      },
    },
    ...overrides,
  };
}

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

console.log('Running CLI status IPC contract tests...');

test('registers ring buffer and ready status channels', () => {
  const ipc = createFakeIpc();
  const deps = createDeps();
  registerCliStatusIpc(ipc, deps);

  assert.ok(ipc.handlers.has('get-ring-buffer'));
  assert.ok(ipc.handlers.has('cli-ready-status'));
  assert.strictEqual(ipc.handlers.get('get-ring-buffer')(null, 'ready'), 'READY marker');
});

test('cli-ready-status returns false for missing args or unknown session', () => {
  const deps = createDeps();

  assert.strictEqual(isCliReady(null, deps), false);
  assert.strictEqual(isCliReady('missing', deps), false);
  assert.ok(!deps.calls.some(call => call[0] === 'isReady'));
});

test('group chat ready fast path marks detector and returns true', () => {
  const deps = createDeps();

  assert.strictEqual(isCliReady('fast', deps), true);
  assert.ok(deps.calls.some(call => call[0] === 'markReady' && call[1] === 'fast'));
  assert.ok(!deps.calls.some(call => call[0] === 'isReady'));
});

test('normal path checks buffer through cli ready detector', () => {
  const deps = createDeps();

  assert.strictEqual(isCliReady('ready', deps), true);
  assert.deepStrictEqual(deps.calls.at(-1), ['isReady', 'ready', 'codex', 'READY marker']);
});

console.log('All CLI status IPC contract tests passed.');
