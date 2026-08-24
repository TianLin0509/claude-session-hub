'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { SessionManager } = require('../core/session-manager.js');

function attachFakePty(manager, sessionId) {
  const exitHandlers = [];
  const snapshot = { disposeCalls: 0, dispose() { this.disposeCalls += 1; } };
  const pty = {
    killCalls: 0,
    kill() { this.killCalls += 1; },
    onExit(handler) {
      exitHandlers.push(handler);
      return { dispose() {} };
    },
    emitExit(exitInfo = { exitCode: 0, signal: 0 }) {
      for (const handler of [...exitHandlers]) handler(exitInfo);
    },
  };
  manager.sessions.set(sessionId, {
    info: { id: sessionId, kind: 'powershell', meetingId: 'meeting-1' },
    pty,
    pendingTimers: new Set(),
    terminalSnapshot: snapshot,
    terminalOutputFlushTimer: null,
  });
  // Simulate the one native onExit subscription installed by createSession().
  pty.onExit(exitInfo => manager._handlePtyExit(sessionId, pty, exitInfo));
  return { pty, snapshot };
}

test('graceful shutdown keeps Node alive until the PTY onExit path completes', async () => {
  const manager = new SessionManager();
  const { pty, snapshot } = attachFakePty(manager, 'pty-1');
  let resolved = false;
  let logicalCloseEvents = 0;
  manager.onSessionClosed = () => { logicalCloseEvents += 1; };
  manager.onSessionSuspended = () => { logicalCloseEvents += 1; };

  const drain = manager.disposeGracefully({ warnAfterMs: 1000, logger: { warn() {} } });
  drain.then(() => { resolved = true; });

  assert.equal(pty.killCalls, 1);
  await Promise.resolve();
  assert.equal(resolved, false, 'drain must not resolve merely because kill() returned');

  pty.emitExit();
  const result = await drain;
  assert.equal(result.safeToQuit, true);
  assert.equal(result.drainedPtyCount, 1);
  assert.equal(manager.sessions.size, 0);
  assert.equal(snapshot.disposeCalls, 1);
  assert.equal(logicalCloseEvents, 0, 'app shutdown must preserve persisted session and meeting membership');
});

test('graceful shutdown is idempotent and waits for every live PTY', async () => {
  const manager = new SessionManager();
  const first = attachFakePty(manager, 'pty-1');
  const second = attachFakePty(manager, 'pty-2');
  let resolved = false;

  const drain = manager.disposeGracefully({ warnAfterMs: 1000, logger: { warn() {} } });
  const repeated = manager.disposeGracefully({ warnAfterMs: 1000, logger: { warn() {} } });
  assert.strictEqual(repeated, drain);
  drain.then(() => { resolved = true; });

  first.pty.emitExit();
  await Promise.resolve();
  assert.equal(resolved, false, 'one remaining PTY must keep the shutdown barrier closed');
  second.pty.emitExit();

  const result = await drain;
  assert.equal(result.drainedPtyCount, 2);
  assert.equal(first.pty.killCalls, 1);
  assert.equal(second.pty.killCalls, 1);
});

test('graceful shutdown refuses new PTYs once draining starts', async () => {
  const manager = new SessionManager();
  const result = await manager.disposeGracefully({ warnAfterMs: 0, logger: { warn() {} } });

  assert.equal(result.safeToQuit, true);
  assert.equal(result.drainedPtyCount, 0);
  assert.throws(
    () => manager.createSession('powershell'),
    /Hub is shutting down/,
  );
});

test('missing native onExit reaches a retryable timeout instead of hanging forever', async () => {
  const manager = new SessionManager();
  const fixture = attachFakePty(manager, 'stuck-pty');
  let logicalCloseEvents = 0;
  manager.onSessionClosed = () => { logicalCloseEvents += 1; };
  let logicalSuspendEvents = 0;
  manager.onSessionSuspended = () => { logicalSuspendEvents += 1; };
  const first = manager.disposeGracefully({
    warnAfterMs: 0,
    drainTimeoutMs: 30,
    logger: { warn() {}, error() {} },
  });
  const result = await first;
  assert.equal(result.safeToQuit, false);
  assert.equal(result.error, 'pty_drain_timeout');
  assert.deepStrictEqual(result.pendingSessionIds, ['stuck-pty']);
  assert.equal(manager._isShuttingDown, false);
  fixture.pty.emitExit();
  assert.equal(logicalCloseEvents, 0, 'late shutdown-induced exit must not become a user close');
  assert.equal(logicalSuspendEvents, 1, 'late shutdown-induced exit becomes a retryable dormant session');
  assert.equal(manager.sessions.size, 0);

  const retryManager = new SessionManager();
  const retryFixture = attachFakePty(retryManager, 'retry-pty');
  const timedOut = retryManager.disposeGracefully({
    warnAfterMs: 0,
    drainTimeoutMs: 30,
    logger: { warn() {}, error() {} },
  });
  await timedOut;
  const retry = retryManager.disposeGracefully({
    warnAfterMs: 0,
    drainTimeoutMs: 30,
    logger: { warn() {}, error() {} },
  });
  assert.notStrictEqual(retry, timedOut);
  retryFixture.pty.emitExit();
  assert.equal((await retry).safeToQuit, true);
});

test('partial drain timeout turns completed PTYs dormant and keeps the stuck PTY tracked', async () => {
  const manager = new SessionManager();
  const completed = attachFakePty(manager, 'completed-pty');
  attachFakePty(manager, 'stuck-pty');
  const suspended = [];
  let closed = 0;
  manager.onSessionSuspended = (sessionId, _meetingId, session) => suspended.push({ sessionId, session });
  manager.onSessionClosed = () => { closed += 1; };
  const drain = manager.disposeGracefully({
    warnAfterMs: 0,
    drainTimeoutMs: 30,
    logger: { warn() {}, error() {} },
  });
  completed.pty.emitExit();
  const result = await drain;
  assert.equal(result.safeToQuit, false);
  assert.deepStrictEqual(result.pendingSessionIds, ['stuck-pty']);
  assert.equal(closed, 0);
  assert.deepStrictEqual(suspended.map(item => item.sessionId), ['completed-pty']);
  assert.equal(suspended[0].session.status, 'dormant');
  assert.equal(manager.sessions.has('stuck-pty'), true);
});
