'use strict';

const assert = require('assert');
const { registerGroupchatRecoveryIpc } = require('../main/ipc/groupchat-recovery-handlers.js');

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

console.log('Running groupchat recovery IPC contract tests...');

test('registers recovery channels', () => {
  const ipc = createFakeIpc();
  registerGroupchatRecoveryIpc(ipc, { getActiveWatchers: () => new Map() });

  assert.ok(ipc.handlers.has('groupchat-skip-participant'));
  assert.ok(ipc.handlers.has('groupchat-resend-participant'));
});

test('skip participant validates sid and active watcher', async () => {
  const ipc = createFakeIpc();
  const calls = [];
  const watchers = new Map([
    ['s1', { skip: () => calls.push(['skip', 's1']) }],
  ]);
  registerGroupchatRecoveryIpc(ipc, { getActiveWatchers: () => watchers });

  const missing = await ipc.handlers.get('groupchat-skip-participant')(null, {});
  const inactive = await ipc.handlers.get('groupchat-skip-participant')(null, { sid: 'missing' });
  const ok = await ipc.handlers.get('groupchat-skip-participant')(null, { sid: 's1' });

  assert.deepStrictEqual(missing, { ok: false, reason: 'missing sid' });
  assert.deepStrictEqual(inactive, { ok: false, reason: 'not_active' });
  assert.deepStrictEqual(ok, { ok: true });
  assert.deepStrictEqual(calls, [['skip', 's1']]);
});

test('resend participant keeps existing unsupported response', async () => {
  const ipc = createFakeIpc();
  registerGroupchatRecoveryIpc(ipc, { getActiveWatchers: () => new Map() });

  const result = await ipc.handlers.get('groupchat-resend-participant')();

  assert.deepStrictEqual(result, {
    ok: false,
    reason: 'unsupported',
    detail: 'group chat uses resend-prompt, manual extract, and skip recovery actions',
  });
});
