'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  registerWorkbenchOperationsIpc,
} = require('../main/ipc/workbench-operations-handlers.js');

function fakeIpc() {
  return {
    handlers: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
  };
}

test('workbench operations IPC exposes the complete read/review/checkpoint contract', async () => {
  const ipc = fakeIpc();
  const calls = [];
  const service = {};
  for (const method of [
    'overview', 'diff', 'setReviewDecision', 'createCheckpoint',
    'restoreCheckpoint', 'lineProvenance', 'timeline',
  ]) {
    service[method] = async payload => { calls.push([method, payload]); return { method }; };
  }
  registerWorkbenchOperationsIpc(ipc, { service, logger: { warn() {} } });
  assert.deepStrictEqual([...ipc.handlers.keys()], [
    'workbench:get-overview',
    'workbench:get-diff',
    'workbench:set-review-decision',
    'workbench:create-checkpoint',
    'workbench:restore-checkpoint',
    'workbench:get-line-provenance',
    'workbench:get-timeline',
  ]);
  const result = await ipc.handlers.get('workbench:get-diff')(null, { repoRoot: 'C:\\repo' });
  assert.deepStrictEqual(result, { method: 'diff' });
  assert.deepStrictEqual(calls, [['diff', { repoRoot: 'C:\\repo' }]]);
});

test('workbench operations IPC returns a bounded public error instead of leaking internals', async () => {
  const ipc = fakeIpc();
  registerWorkbenchOperationsIpc(ipc, {
    service: {
      overview: async () => { throw new Error('C:\\secret\\token.txt failed'); },
      diff: async () => {}, setReviewDecision: async () => {}, createCheckpoint: async () => {},
      restoreCheckpoint: async () => {}, lineProvenance: async () => {}, timeline: async () => {},
    },
    logger: { warn() {} },
  });
  assert.deepStrictEqual(await ipc.handlers.get('workbench:get-overview')(null, {}), {
    ok: false,
    error: 'operation_failed',
  });
});
