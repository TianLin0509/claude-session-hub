'use strict';

const assert = require('assert');
const { registerGroupchatTurnIpc } = require('../main/ipc/groupchat-turn-handlers.js');

function createFakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, fn) {
      this.handlers.set(channel, fn);
    },
  };
}

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK ${name}`))
    .catch((err) => {
      console.error(`  FAIL ${name}`);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    });
}

console.log('Running groupchat turn IPC contract tests...');

test('registers groupchat turn channel', () => {
  const ipc = createFakeIpc();
  registerGroupchatTurnIpc(ipc, { dispatchGroupChatTurn: async () => ({ status: 'completed' }) });
  assert.ok(ipc.handlers.has('groupchat:turn'));
});

test('delegates meetingId and args to dispatcher', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  registerGroupchatTurnIpc(ipc, {
    dispatchGroupChatTurn: async (meetingId, args) => {
      calls.push([meetingId, args]);
      return { status: 'completed', turnNum: 4 };
    },
  });

  const args = { meetingId: 'm1', userInput: 'hello' };
  const result = await ipc.handlers.get('groupchat:turn')(null, args);

  assert.deepStrictEqual(result, { status: 'completed', turnNum: 4 });
  assert.deepStrictEqual(calls, [['m1', args]]);
});

test('awaits async committee intent before running conductor', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  registerGroupchatTurnIpc(ipc, {
    dispatchGroupChatTurn: async () => {
      calls.push('dispatch');
      return { status: 'completed', turnNum: 4 };
    },
    committeeConductor: {
      isCommitteeCommand: async () => {
        calls.push('route');
        await new Promise(resolve => setTimeout(resolve, 5));
        return true;
      },
      runCommitteeSession: async () => {
        calls.push('committee');
        return { status: 'completed', turnNum: null, meta: { committee: true } };
      },
    },
  });

  const result = await ipc.handlers.get('groupchat:turn')(null, { meetingId: 'm1', userInput: '赛力斯怎么样' });

  assert.deepStrictEqual(result, { status: 'completed', turnNum: null, meta: { committee: true } });
  assert.deepStrictEqual(calls, ['route', 'committee']);
});

test('converts dispatcher exceptions to existing error response', async () => {
  const ipc = createFakeIpc();
  const errors = [];
  registerGroupchatTurnIpc(ipc, {
    dispatchGroupChatTurn: async () => {
      throw new Error('dispatch failed');
    },
    logger: { error: (...args) => errors.push(args) },
  });

  const result = await ipc.handlers.get('groupchat:turn')(null, { meetingId: 'm1' });

  assert.deepStrictEqual(result, { status: 'error', reason: 'dispatch failed', turnNum: null });
  assert.strictEqual(errors.length, 1);
});
