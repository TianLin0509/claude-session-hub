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
    closeSessionRecoverably(sessionId, options) {
      calls.push(['closeSessionRecoverably', sessionId, options]);
      return { ok: true, sessionId, action: 'suspended' };
    },
    suspendSession(sessionId, options) {
      calls.push(['suspendSession', sessionId, options]);
      return { ok: true, sessionId };
    },
    suspendIdleSessions(options) {
      calls.push(['suspendIdleSessions', options]);
      return { ok: true, count: 2, requested: ['s1', 's2'] };
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
      if (sessionId === 'claude-source') {
        return {
          id: sessionId,
          kind: 'claude-resume',
          title: 'Claude Design',
          cwd: 'C:\\repo',
          ccSessionId: '11111111-1111-4111-8111-111111111111',
          currentModel: { id: 'opus', displayName: 'Opus' },
        };
      }
      if (sessionId === 'codex-source') {
        return {
          id: sessionId,
          kind: 'codex-resume',
          title: 'Codex Debug',
          cwd: 'C:\\repo',
          codexSid: '22222222-2222-4222-8222-222222222222',
          codexProfile: 'work',
          mcpProfile: 'browser',
          currentModel: { id: 'gpt-5.5', displayName: 'GPT-5.5' },
        };
      }
      if (sessionId === 'codex-generic-source') {
        return {
          id: sessionId,
          kind: 'codex',
          title: 'Codex 2',
          cwd: 'C:\\repo',
          meetingId: 'meeting-source',
          codexSid: '33333333-3333-4333-8333-333333333333',
          currentModel: { id: 'gpt-5.5', displayName: 'GPT-5.5' },
        };
      }
      if (sessionId === 'codex-untitled-source') {
        return {
          id: sessionId,
          kind: 'codex',
          title: 'Codex 3',
          cwd: 'C:\\repo',
          codexSid: '44444444-4444-4444-8444-444444444444',
          currentModel: { id: 'gpt-5.5', displayName: 'GPT-5.5' },
        };
      }
      if (sessionId === 'claude-unbound') {
        return { id: sessionId, kind: 'claude', title: 'Claude New', cwd: 'C:\\repo' };
      }
      return { id: sessionId, kind: 'powershell', cwd: 'C:\\work', meetingId: 'm1' };
    },
    createSession(kind, opts) {
      calls.push(['createSession', kind, opts]);
      const session = { id: opts.id || `created-${kind}`, kind, cwd: opts.cwd, meetingId: opts.meetingId };
      if (opts.title !== undefined) session.title = opts.title;
      return session;
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

  for (const channel of ['close-session', 'delete-session', 'suspend-session', 'suspend-idle-sessions', 'rename-session', 'get-sessions', 'debug:get-session-buffer', 'get-session-buffer-snapshot', 'restart-session', 'fork-session']) {
    assert.ok(ipc.handlers.has(channel), `${channel} should be registered as handle`);
  }
  assert.ok(ipc.handlers.has('create-session'), 'create-session should be registered as handle');
  for (const channel of ['terminal-input', 'terminal-resize', 'focus-session']) {
    assert.ok(ipc.listeners.has(channel), `${channel} should be registered as listener`);
  }
});

test('fork-session creates a standalone Claude branch from the native session id', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const emitted = [];
  const tapped = [];
  registerSessionIpc(ipc, {
    registerSessionForTap: (session) => tapped.push(session),
    sessionManager,
    sendToRenderer: (channel, payload) => emitted.push([channel, payload]),
  });

  const result = ipc.handlers.get('fork-session')(null, 'claude-source');

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    sessionManager.calls.find(call => call[0] === 'createSession'),
    ['createSession', 'claude', {
      title: '分支: Claude Design',
      cwd: 'C:\\repo',
      branchSourceSessionId: 'claude-source',
      branchAutoTitlePending: false,
      autoTitleGenerated: true,
      model: 'opus',
      forkCCSessionId: '11111111-1111-4111-8111-111111111111',
    }],
  );
  assert.deepStrictEqual(tapped, [result.session]);
  assert.deepStrictEqual(emitted, [['session-created', { session: result.session }]]);
});

test('fork-session preserves Codex model and subscription profile', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  const result = ipc.handlers.get('fork-session')(null, 'codex-source');

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    sessionManager.calls.find(call => call[0] === 'createSession'),
    ['createSession', 'codex', {
      title: '分支: Codex Debug',
      cwd: 'C:\\repo',
      branchSourceSessionId: 'codex-source',
      branchAutoTitlePending: false,
      autoTitleGenerated: true,
      model: 'gpt-5.5',
      codexProfile: 'work',
      mcpProfile: 'browser',
      codexForkSid: '22222222-2222-4222-8222-222222222222',
    }],
  );
});

test('fork-session uses the owning meeting name instead of a generic Codex member name', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const meetingManager = {
    getMeeting: (id) => id === 'meeting-source'
      ? { id, title: '通道重构与多阵子驱动' }
      : null,
  };
  registerSessionIpc(ipc, { meetingManager, sessionManager, sendToRenderer: () => {} });

  const result = ipc.handlers.get('fork-session')(null, 'codex-generic-source');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    sessionManager.calls.find(call => call[0] === 'createSession'),
    ['createSession', 'codex', {
      title: '分支: 通道重构与多阵子驱动',
      cwd: 'C:\\repo',
      branchSourceSessionId: 'codex-generic-source',
      branchAutoTitlePending: false,
      autoTitleGenerated: true,
      model: 'gpt-5.5',
      codexForkSid: '33333333-3333-4333-8333-333333333333',
    }],
  );
});

test('fork-session trusts the current renderer title over a stale generic backend title', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  const result = ipc.handlers.get('fork-session')(null, {
    sourceSessionId: 'codex-generic-source',
    sourceTitle: '用户当前看到的原始会话名',
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(
    sessionManager.calls.find(call => call[0] === 'createSession')[2].title,
    '分支: 用户当前看到的原始会话名',
  );
});

test('a truly unnamed standalone parent uses a pending placeholder, never Codex 3', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  const result = ipc.handlers.get('fork-session')(null, 'codex-untitled-source');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    sessionManager.calls.find(call => call[0] === 'createSession'),
    ['createSession', 'codex', {
      title: '分支: 待命名',
      cwd: 'C:\\repo',
      branchSourceSessionId: 'codex-untitled-source',
      branchAutoTitlePending: true,
      autoTitleGenerated: false,
      model: 'gpt-5.5',
      codexForkSid: '44444444-4444-4444-8444-444444444444',
    }],
  );
});

test('fork-session rejects unsupported or not-yet-bound sessions without spawning', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  const missing = ipc.handlers.get('fork-session')(null, 'missing');
  const unsupported = ipc.handlers.get('fork-session')(null, 's1');
  const unbound = ipc.handlers.get('fork-session')(null, 'claude-unbound');

  assert.strictEqual(missing.error, 'session-not-found');
  assert.strictEqual(unsupported.error, 'unsupported-kind');
  assert.strictEqual(unbound.error, 'native-session-id-missing');
  assert.strictEqual(sessionManager.calls.some(call => call[0] === 'createSession'), false);
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

test('close-session clears resize cache and recoverably suspends; delete is explicit', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const registered = registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  ipc.listeners.get('terminal-resize')(null, { sessionId: 's1', cols: 80, rows: 24 });
  assert.ok(registered.lastResizeBySid.has('s1'));

  const closed = ipc.handlers.get('close-session')(null, 's1');

  assert.strictEqual(closed.action, 'suspended');
  assert.ok(!registered.lastResizeBySid.has('s1'));
  assert.deepStrictEqual(sessionManager.calls.at(-1), [
    'closeSessionRecoverably', 's1', { reason: 'user-close' },
  ]);

  const deleted = ipc.handlers.get('delete-session')(null, 's1');
  assert.strictEqual(deleted.action, 'deleted');
  assert.deepStrictEqual(sessionManager.calls.at(-1), ['closeSession', 's1']);
});

test('suspend handlers clear resize cache and delegate conservative idle policy', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  const registered = registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  ipc.listeners.get('terminal-resize')(null, { sessionId: 's1', cols: 80, rows: 24 });
  const single = ipc.handlers.get('suspend-session')(null, 's1');
  assert.strictEqual(single.ok, true);
  assert.ok(!registered.lastResizeBySid.has('s1'));

  const bulk = ipc.handlers.get('suspend-idle-sessions')(null, { idleMs: 12345 });
  assert.strictEqual(bulk.count, 2);
  assert.deepStrictEqual(sessionManager.calls.filter(call => call[0].startsWith('suspend')), [
    ['suspendSession', 's1', { reason: 'user-suspend' }],
    ['suspendIdleSessions', { idleMs: 12345 }],
  ]);
});

test('focus, input, get-sessions, debug buffer delegate unchanged', () => {
  const ipc = createFakeIpc();
  const sessionManager = createFakeSessionManager();
  registerSessionIpc(ipc, { sessionManager, sendToRenderer: () => {} });

  ipc.listeners.get('terminal-input')(null, { sessionId: 's1', data: 'abc' });
  ipc.listeners.get('focus-session')(null, { sessionId: 's1' });
  const sessions = ipc.handlers.get('get-sessions')();
  const buffer = ipc.handlers.get('debug:get-session-buffer')(null, 's1');
  const snapshot = ipc.handlers.get('get-session-buffer-snapshot')(null, 's1');

  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(buffer, 'buffer:s1');
  assert.deepStrictEqual(snapshot, { text: 'buffer:s1', seq: 0 });
  assert.deepStrictEqual(sessionManager.calls, [
    ['writeToSession', 's1', 'abc'],
    ['setFocusedSession', 's1'],
    ['markRead', 's1'],
    ['getAllSessions'],
    ['getSessionBuffer', 's1'],
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
