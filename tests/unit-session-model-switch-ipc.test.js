'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { registerSessionIpc } = require('../main/ipc/session-handlers.js');

function setup(session) {
  const handlers = new Map();
  const listeners = new Map();
  const messages = [];
  const ipcMain = {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
  const sessionManager = {
    getSession: id => id === session.id ? session : null,
    updateSessionMeta(id, fields) {
      if (id !== session.id) return undefined;
      Object.assign(session, fields);
      return { ...session };
    },
  };
  registerSessionIpc(ipcMain, {
    sessionManager,
    sendToRenderer: (...args) => messages.push(args),
  });
  return { handler: handlers.get('confirm-session-model-switch'), messages, session };
}

test('confirmed Codex switch updates model and compatible effort', async () => {
  const fixture = setup({ id: 'codex-1', kind: 'codex', effort: 'max' });
  const result = await fixture.handler({}, {
    sessionId: 'codex-1', modelId: 'gpt-5.5', displayName: 'GPT-5.5', effort: 'xhigh',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.session.currentModel, { id: 'gpt-5.5', displayName: 'GPT-5.5' });
  assert.equal(fixture.session.effort, 'xhigh');
  assert.equal(fixture.messages[0][0], 'session-updated');
});

test('provider mismatch cannot rewrite model metadata', async () => {
  const fixture = setup({ id: 'claude-1', kind: 'claude' });
  const result = await fixture.handler({}, { sessionId: 'claude-1', modelId: 'gpt-5.6-sol' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid-model');
  assert.equal(fixture.session.currentModel, undefined);
});
