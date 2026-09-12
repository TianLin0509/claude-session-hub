'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerPromptSubmitIpc } = require('../main/ipc/prompt-submit-handlers');
const { ClaudeNativeSession } = require('../core/claude-native-session');

function nativeSession(controls, reply = { mode: 'plan' }) {
  const session = new ClaudeNativeSession({ id: 's1', kind: 'claude', cwd: process.cwd(),
    launchArgs: ['--model', 'claude-opus-5[1m]', '--permission-mode', 'default'],
    sessionId: '11111111-2222-3333-4444-555555555555' });
  session.ready = Promise.resolve();
  session.client = { control: async request => { controls.push(request); return reply; } };
  return session;
}

test('Claude permission mode is switched over the protocol and stored as the engine confirmed it', async () => {
  const controls = [];
  const native = nativeSession(controls);
  const stored = { id: 's1', nativeConfig: { permissionMode: 'default', addDirs: ['C:\work'] } };
  const updates = [];
  const manager = { getNativeClaude: () => native, getSession: () => stored,
    updateSessionMeta: (_id, fields) => Object.assign(stored, fields),
    on() {}, getAllSessions: () => [], getSession_: null };
  const handlers = new Map();
  registerPromptSubmitIpc({ handle: (channel, fn) => handlers.set(channel, fn) },
    { sessionManager: manager, transcriptTap: { on() {} }, sendToRenderer: (_c, p) => updates.push(p) });
  const call = mode => handlers.get('claude-native:set-permission-mode')({}, { sessionId: 's1', mode });

  const result = await call('plan');
  assert.deepEqual(result, { ok: true, result: { permissionMode: 'plan' } });
  assert.deepEqual(controls, [{ subtype: 'set_permission_mode', mode: 'plan' }]);
  // A relaunch must carry the confirmed mode, and unrelated resume config stays.
  assert.deepEqual(native.options.launchArgs, ['--model', 'claude-opus-5[1m]', '--permission-mode', 'plan']);
  assert.deepEqual(stored.nativeConfig, { permissionMode: 'plan', addDirs: ['C:\work'] });
  assert.equal(native.runtime.permissionMode, 'plan');
  assert.equal(updates.length, 1);

  // An unsupported value never reaches the transport.
  const rejected = await call('banana');
  assert.equal(rejected.ok, false);
  assert.equal(controls.length, 1);
});

test('a busy Claude session refuses the switch instead of racing the current turn', async () => {
  const controls = [];
  const native = nativeSession(controls);
  native.active = { submissionId: 'x' };
  await assert.rejects(() => native.setPermissionMode('plan'), /切换工作方式/);
  assert.deepEqual(controls, []);
});
