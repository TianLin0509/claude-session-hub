'use strict';

const assert = require('assert');
const { registerSessionIpc } = require('../main/ipc/session-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
    on(channel, fn) {
      this.listeners.set(channel, fn);
    },
  };
}

function createFakeSessionManager() {
  const calls = [];
  const sessions = [{ id: 's1', title: 'Session 1' }];
  return {
    calls,
    closeSession(sessionId) {
      calls.push(['closeSession', sessionId]);
    },
    writeToSession(sessionId, data) {
      calls.push(['writeToSession', sessionId, data]);
    },
    resizeSession(sessionId, cols, rows) {
      calls.push(['resizeSession', sessionId, cols, rows]);
    },
    setFocusedSession(sessionId) {
      calls.push(['setFocusedSession', sessionId]);
    },
    markRead(sessionId) {
      calls.push(['markRead', sessionId]);
    },
    renameSession(sessionId, title, opts) {
      calls.push(['renameSession', sessionId, title, opts]);
      return { id: sessionId, title, userRenamed: opts.userRenamed };
    },
    getAllSessions() {
      calls.push(['getAllSessions']);
      return sessions;
    },
    getSessionBuffer(sessionId) {
      calls.push(['getSessionBuffer', sessionId]);
      return `buffer:${sessionId}`;
    },
    getSession(sessionId) {
      calls.push(['getSession', sessionId]);
      if (sessionId === 'missing') return null;
      return { id: sessionId, kind: 'powershell', cwd: 'C:\\work', meetingId: 'm1' };
    },
    createSession(kind, opts) {
      calls.push(['createSession', kind, opts]);
      return { id: opts.id, kind, cwd: opts.cwd, meetingId: opts.meetingId };
    },
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

console.log('Running session IPC contract tests...');

test('registers expected session channels', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  for (const channel of ['close-session', 'rename-session', 'get-sessions', 'debug:get-session-buffer', 'restart-session']) {
    assert.ok(ipc.handlers.has(channel), `${channel} should be registered as handle`);
  }
  assert.ok(ipc.handlers.has('create-session'), 'create-session should be registered as handle');
  for (const channel of ['terminal-input', 'terminal-resize', 'focus-session']) {
    assert.ok(ipc.listeners.has(channel), `${channel} should be registered as listener`);
  }
});

test('create-session preserves legacy and object payloads', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const emitted = [];
  const tapped = [];
  registerSessionIpc(ipc, {
    registerSessionForTap: (session) => tapped.push(session),
    sessionManager,
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
  });

  const legacy = ipc.handlers.get('create-session')(null, 'powershell');
  const objectPayload = ipc.handlers.get('create-session')(null, { kind: 'codex', opts: { cwd: 'C:\\repo' } });
  const fallback = ipc.handlers.get('create-session')(null, null);

  assert.strictEqual(legacy.kind, 'powershell');
  assert.strictEqual(objectPayload.kind, 'codex');
  assert.strictEqual(fallback.kind, 'powershell');
  assert.deepStrictEqual(
    sessionManager.calls.filter(call => call[0] === 'createSession'),
    [
      ['createSession', 'powershell', {}],
      ['createSession', 'codex', { cwd: 'C:\\repo' }],
      ['createSession', 'powershell', {}],
    ]
  );
  assert.strictEqual(tapped.length, 3);
  assert.strictEqual(emitted.length, 3);
  assert.strictEqual(emitted[0][0], 'session-created');
});

test('rename-session returns updated session and emits session-updated', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const emitted = [];
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: (channel, payload) => emitted.push([channel, payload]) });

  const updated = ipc.handlers.get('rename-session')(null, { sessionId: 's1', title: 'New', userRenamed: true });

  assert.deepStrictEqual(updated, { id: 's1', title: 'New', userRenamed: true });
  assert.deepStrictEqual(emitted, [['session-updated', { session: updated }]]);
});

test('terminal-resize drops invalid and duplicate sizes', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });
  const resize = ipc.listeners.get('terminal-resize');

  resize(null, { sessionId: 's1', cols: 80, rows: 24 });
  resize(null, { sessionId: 's1', cols: 80, rows: 24 });
  resize(null, { sessionId: 's1', cols: 100, rows: 30 });
  resize(null, { sessionId: 's1', cols: 0, rows: 30 });
  resize(null, { sessionId: 123, cols: 90, rows: 30 });

  assert.deepStrictEqual(
    sessionManager.calls.filter(call => call[0] === 'resizeSession'),
    [
      ['resizeSession', 's1', 80, 24],
      ['resizeSession', 's1', 100, 30],
    ]
  );
});

test('close-session clears resize cache and closes session', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const registered = registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  ipc.listeners.get('terminal-resize')(null, { sessionId: 's1', cols: 80, rows: 24 });
  assert.ok(registered.lastResizeBySid.has('s1'));

  ipc.handlers.get('close-session')(null, 's1');

  assert.ok(!registered.lastResizeBySid.has('s1'));
  assert.deepStrictEqual(sessionManager.calls.at(-1), ['closeSession', 's1']);
});

test('focus, input, get-sessions, debug buffer delegate unchanged', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  ipc.listeners.get('terminal-input')(null, { sessionId: 's1', data: 'abc' });
  ipc.listeners.get('focus-session')(null, { sessionId: 's1' });
  const sessions = ipc.handlers.get('get-sessions')();
  const buffer = ipc.handlers.get('debug:get-session-buffer')(null, 's1');

  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(buffer, 'buffer:s1');
  assert.deepStrictEqual(sessionManager.calls, [
    ['writeToSession', 's1', 'abc'],
    ['setFocusedSession', 's1'],
    ['markRead', 's1'],
    ['getAllSessions'],
    ['getSessionBuffer', 's1'],
  ]);
});

test('restart-session closes, recreates, registers tap, and emits session-created', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const emitted = [];
  const tapped = [];
  registerSessionIpc(ipc, {
    registerSessionForTap: (session) => tapped.push(session),
    sessionManager,
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
  });

  const fresh = ipc.handlers.get('restart-session')(null, 's1');
  const missing = ipc.handlers.get('restart-session')(null, 'missing');

  assert.deepStrictEqual(fresh, { id: 's1', kind: 'powershell', cwd: 'C:\\work', meetingId: 'm1' });
  assert.strictEqual(missing, null);
  assert.deepStrictEqual(
    sessionManager.calls.filter(call => ['getSession', 'closeSession', 'createSession'].includes(call[0])),
    [
      ['getSession', 's1'],
      ['closeSession', 's1'],
      ['createSession', 'powershell', { id: 's1', cwd: 'C:\\work', meetingId: 'm1' }],
      ['getSession', 'missing'],
    ]
  );
  assert.deepStrictEqual(tapped, [fresh]);
  assert.deepStrictEqual(emitted, [['session-created', { session: fresh }]]);
});

console.log('All session IPC contract tests passed.');
