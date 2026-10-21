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
    outputDelivery: null,
  });
  // Simulate the one native onExit subscription installed by createSession().
  pty.onExit(exitInfo => manager._handlePtyExit(sessionId, pty, exitInfo));
  return { pty, snapshot };
}

test('unexpected group CLI exits keep the logical member and native resume identity', () => {
  for (const kind of ['claude', 'codex', 'gemini', 'kimi', 'deepseek']) {
    const manager = new SessionManager();
    const { pty } = attachFakePty(manager, kind);
    Object.assign(manager.sessions.get(kind).info, { kind, ccSessionId: 'claude-native', codexSid: 'codex-native',
      geminiChatId: 'gemini-native', kimiSid: 'kimi-native' });
    let closed = 0, suspended;
    manager.onSessionClosed = () => closed++;
    manager.onSessionSuspended = (id, meetingId, session, exit) => { suspended = { id, meetingId, session, exit }; };
    pty.emitExit({ exitCode: 1, signal: 0 });
    assert.equal(closed, 0, kind + ': a process exit must not remove a group member');
    assert.equal(suspended.meetingId, 'meeting-1');
    assert.equal(suspended.session.status, 'dormant');
    assert.equal(suspended.session.suspendReason, 'process-exit');
    assert.equal(suspended.session.codexSid, 'codex-native');
    assert.equal(suspended.session.ccSessionId, 'claude-native');
  }
});

test('explicit group member removal still emits the logical close event', () => {
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'member');
  Object.assign(manager.sessions.get('member').info, { kind: 'claude' });
  manager.sessions.get('member').closeRequestedAt = Date.now();
  let closed = 0;
  manager.onSessionClosed = () => closed++;
  manager.onSessionSuspended = () => assert.fail('explicit removal is not suspension');
  pty.emitExit();
  assert.equal(closed, 1);
});

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

test('recoverable close followed immediately by shutdown closes the native PTY only once', async () => {
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'assistant');
  Object.assign(manager.sessions.get('assistant').info, { kind: 'claude', ccSessionId: 'native-assistant' });
  assert.equal(manager.closeSessionRecoverably('assistant').action, 'suspended');
  assert.equal(pty.killCalls, 1);
  // Native onExit is asynchronous: the session still exists while its handle
  // is closing. Re-entering native kill in this interval can corrupt the heap.
  let resolved = false;
  const drain = manager.disposeGracefully({ warnAfterMs: 0 });
  drain.then(() => { resolved = true; });
  await Promise.resolve();
  const prematureCompletion = resolved;
  const killCallsBeforeExit = pty.killCalls;
  pty.emitExit();
  assert.equal((await drain).safeToQuit, true);
  assert.equal(prematureCompletion, false, 'an existing close request still needs its native exit callback');
  assert.equal(killCallsBeforeExit, 1, 'shutdown must join the in-flight close instead of closing its handle again');
});

test('explicit close can supersede suspension without issuing another native close', async () => {
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'assistant');
  Object.assign(manager.sessions.get('assistant').info, { kind: 'claude', ccSessionId: 'native-assistant' });
  assert.equal(manager.closeSessionRecoverably('assistant').ok, true);
  manager.closeSession('assistant');
  manager.closeSession('assistant');
  assert.ok(manager.sessions.get('assistant').closeRequestedAt);
  assert.equal(manager.sessions.get('assistant').suspendRequestedAt, 0);
  const drain = manager.disposeGracefully({ warnAfterMs: 0 });
  const killCallsBeforeExit = pty.killCalls;
  pty.emitExit();
  assert.equal((await drain).safeToQuit, true);
  assert.equal(killCallsBeforeExit, 1);
});

test('a failed native close remains visible and allows a later shutdown request to retry', async () => {
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'assistant');
  Object.assign(manager.sessions.get('assistant').info, { kind: 'claude', ccSessionId: 'native-assistant' });
  pty.kill = function () {
    this.killCalls += 1;
    if (this.killCalls === 1) throw new Error('native close failed');
  };
  const close = manager.closeSessionRecoverably('assistant');
  assert.equal(close.ok, false);
  assert.equal(close.error, 'kill-failed');
  assert.match(close.message, /native close failed/);
  const drain = manager.disposeGracefully({ warnAfterMs: 0 });
  const killCallsBeforeExit = pty.killCalls;
  pty.emitExit();
  const result = await drain;
  assert.equal(result.safeToQuit, true);
  assert.equal(killCallsBeforeExit, 2, 'a thrown close must not be remembered as a successful termination request');
  assert.deepStrictEqual(result.killErrors, []);
});

test('API-backed drivers can retry an asynchronous close failure during shutdown', async () => {
  for (const backend of ['codex-app-server', 'claude-stream-json', 'acp']) {
    const manager = new SessionManager();
    const { pty } = attachFakePty(manager, backend);
    manager.sessions.get(backend).info.runtimeBackend = backend;
    pty.kill = function () {
      if (this.closed) return;
      this.closed = true;
      this.killCalls += 1;
      if (this.killCalls === 1) {
        // Codex native reports this failure after kill() returned; the
        // manager's synchronous catch cannot observe it or clear a marker.
        Promise.resolve().then(() => { this.closed = false; });
      }
    };
    manager.closeSession(backend);
    await Promise.resolve();
    assert.equal(pty.closed, false);
    const drain = manager.disposeGracefully({ warnAfterMs: 0 });
    const killCallsBeforeExit = pty.killCalls;
    pty.emitExit();
    assert.equal((await drain).safeToQuit, true);
    assert.equal(killCallsBeforeExit, 2, backend + ': the driver must be allowed to retry its failed async close');
  }
});

test('PTY-backed CLI providers remain protected even when routed through the ACP backend', async () => {
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'provider');
  manager.sessions.get('provider').info.runtimeBackend = 'acp';
  pty.isCliProvider = true;
  manager.closeSession('provider');
  const drain = manager.disposeGracefully({ warnAfterMs: 0 });
  const killCallsBeforeExit = pty.killCalls;
  pty.emitExit();
  assert.equal((await drain).safeToQuit, true);
  assert.equal(killCallsBeforeExit, 1);
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
