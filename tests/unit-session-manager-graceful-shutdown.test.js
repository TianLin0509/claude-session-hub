'use strict';

const assert = require('node:assert');
const test = require('node:test');

const { SessionManager } = require('../core/session-manager.js');

function attachFakePty(manager, sessionId) {
  const exitHandlers = [];
  const snapshot = { disposeCalls: 0, dispose() { this.disposeCalls += 1; } };
  const pty = {
    pid: 123456789,
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
  require('../core/pty-process-owner').recordPtySpawn(pty);
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
  let forcedRetries = 0;
  retryManager._forceTerminatePty = async () => { forcedRetries += 1; return 12345; };
  const retry = retryManager.disposeGracefully({
    warnAfterMs: 0,
    drainTimeoutMs: 30,
    logger: { warn() {}, error() {} },
  });
  assert.notStrictEqual(retry, timedOut);
  assert.equal(forcedRetries, 1);
  assert.equal(retryFixture.pty.killCalls, 1, 'retry must not close the same native handle again');
  retryFixture.pty.emitExit();
  assert.equal((await retry).safeToQuit, true);
});

function captureForcedProcessExit(t, error = null) {
  const commands = [];
  t.mock.method(SessionManager.prototype, '_readPtyProcessBirth', async () => 1000);
  t.mock.method(require('child_process'), 'execFile', (command, args, options, callback) => {
    commands.push({ command, args, options });
    queueMicrotask(() => callback(error));
  });
  return commands;
}

test('timeout retry terminates the exact owned process and still waits for native onExit', async (t) => {
  const commands = captureForcedProcessExit(t);
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'stuck');
  pty.pid = 123456789;
  const options = { warnAfterMs: 0, drainTimeoutMs: 100, logger: { warn() {}, error() {} } };
  assert.equal((await manager.disposeGracefully(options)).safeToQuit, false);
  assert.equal(commands.length, 0, 'the initial exit attempt only requests normal PTY shutdown');
  let resolved = false;
  const retry = manager.disposeGracefully(options);
  retry.then(() => { resolved = true; });
  await new Promise(resolve => setImmediate(resolve));
  const resolvedBeforeExit = resolved;
  pty.emitExit();
  const result = await retry;
  assert.equal(resolvedBeforeExit, false, 'taskkill success cannot substitute for the native exit callback');
  assert.equal(result.safeToQuit, true);
  assert.equal(pty.killCalls, 1);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'powershell.exe');
  assert.deepStrictEqual(commands[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  const script = Buffer.from(commands[0].args[3], 'base64').toString('utf16le');
  assert.match(script, /\$heldHandle=\$p\.Handle/);
  assert.match(script, /if \(\$birth -ne 1000\).*termination refused/);
  assert.ok(script.includes('"$env:SystemRoot\\System32\\taskkill.exe" -ArgumentList \'/pid ' + pty.pid + ' /t /f\''));
  assert.ok(script.indexOf('termination refused') < script.indexOf('taskkill.exe'));
  assert.match(script, /if \(-not \$killer\.WaitForExit\(5000\)\) \{ \$killer\.Kill\(\)/);
  assert.ok(script.indexOf('$killer.WaitForExit()') < script.indexOf('$p.Dispose()'));
  assert.ok(script.indexOf('$p.Dispose()') > script.indexOf('taskkill.exe'));
  assert.equal(commands[0].options.windowsHide, true);
  assert.equal(commands[0].options.timeout, undefined, 'the identity holder cannot be killed before taskkill finishes');
  assert.equal(commands[0].options.shell, undefined);
  assert.deepStrictEqual(result.forceRequestedPids, [pty.pid]);
});

test('timeout retry exposes process termination failures without declaring the PTY drained', async (t) => {
  const commands = captureForcedProcessExit(t, new Error('process termination denied'));
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'stuck');
  pty.pid = 123456789;
  const options = { warnAfterMs: 0, drainTimeoutMs: 100, logger: { warn() {}, error() {} } };
  await manager.disposeGracefully(options);
  const result = await manager.disposeGracefully(options);
  assert.equal(result.safeToQuit, false);
  assert.equal(pty.killCalls, 1);
  assert.equal(commands.length, 1);
  assert.deepStrictEqual(result.pendingSessionIds, ['stuck']);
  assert.match(result.killErrors[0].message, /process termination denied/);
  assert.deepStrictEqual(result.forceRequestedPids, []);
  pty.emitExit();
});

test('forced shutdown refuses invalid or replaced process ownership', async (t) => {
  const commands = captureForcedProcessExit(t);
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'stuck');
  const entry = manager.sessions.get('stuck');
  for (const pid of [0, -1, NaN, process.pid]) {
    pty.pid = pid;
    await assert.rejects(manager._forceTerminatePty('stuck', entry), /未强制结束进程/);
  }
  pty.pid = 123456789;
  attachFakePty(manager, 'stuck');
  assert.equal(await manager._forceTerminatePty('stuck', entry), null);
  assert.equal(commands.length, 0);
});

test('timeout retry refuses reused PIDs and unreadable process identity', async (t) => {
  const commands = captureForcedProcessExit(t);
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'stuck');
  pty.pid = 123456789;
  manager.closeSession('stuck');
  const entry = manager.sessions.get('stuck');
  const observedAt = manager._ptyTerminationOwners.get(pty).observedAt;
  for (const birth of [observedAt + 1, NaN, 0]) {
    manager._readPtyProcessBirth = async () => birth;
    await assert.rejects(manager._forceTerminatePty('stuck', entry), /未强制结束进程/);
  }
  manager._readPtyProcessBirth = async () => { throw new Error('birth access denied'); };
  await assert.rejects(manager._forceTerminatePty('stuck', entry), /birth access denied/);
  assert.equal(commands.length, 0, 'unverified process identity must never reach a termination command');
  pty.emitExit();
});

test('process identity is anchored at spawn, not at the later close request', async (t) => {
  const commands = captureForcedProcessExit(t);
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'stuck');
  const owner = require('../core/pty-process-owner').ptyProcessOwner(pty);
  t.mock.method(Date, 'now', () => owner.observedAt + 1000);
  manager.closeSession('stuck');
  assert.strictEqual(manager._ptyTerminationOwners.get(pty), owner);
  manager._readPtyProcessBirth = async () => owner.observedAt + 500;
  await assert.rejects(manager._forceTerminatePty('stuck', manager.sessions.get('stuck')), /已复用/);
  assert.equal(commands.length, 0, 'a PID reused before the first kill must still be rejected');
  pty.emitExit();
});

test('missing native spawn evidence refuses force termination', async (t) => {
  const commands = captureForcedProcessExit(t);
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'stuck');
  const entry = manager.sessions.get('stuck');
  entry.pty = { pid: pty.pid, kill() {} };
  manager.closeSession('stuck');
  await assert.rejects(manager._forceTerminatePty('stuck', entry), /归属已变化/);
  assert.equal(commands.length, 0);
});

test('forced shutdown rechecks session ownership after the asynchronous identity probe', async (t) => {
  const commands = captureForcedProcessExit(t);
  const manager = new SessionManager();
  const { pty } = attachFakePty(manager, 'stuck');
  pty.pid = 123456789;
  manager.closeSession('stuck');
  const entry = manager.sessions.get('stuck');
  manager._readPtyProcessBirth = async () => { attachFakePty(manager, 'stuck'); return 1000; };
  assert.equal(await manager._forceTerminatePty('stuck', entry), null);
  assert.equal(commands.length, 0);
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
