'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _renameWithRetryAsync,
  _renameWithRetrySync,
} = require('../core/state-store.js')._private;

test('sync state replace retries transient Windows rename failures while holding the lock', () => {
  let calls = 0;
  const sleeps = [];
  const retriesUsed = _renameWithRetrySync('tmp', 'state.json', {
    retries: 4,
    retryDelayMs: 7,
    sleep: ms => sleeps.push(ms),
    rename: () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    },
  });
  assert.equal(retriesUsed, 2);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [7, 7]);
});

test('async state replace retries transient Windows rename failures', async () => {
  let calls = 0;
  const sleeps = [];
  const retriesUsed = await _renameWithRetryAsync('tmp', 'state.json', {
    retries: 3,
    retryDelayMs: 5,
    sleep: async ms => { sleeps.push(ms); },
    rename: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    },
  });
  assert.equal(retriesUsed, 1);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [5]);
});

test('state replace never retries non-transient filesystem errors', () => {
  let calls = 0;
  assert.throws(() => _renameWithRetrySync('tmp', 'state.json', {
    retries: 10,
    sleep: () => assert.fail('non-transient errors must not sleep'),
    rename: () => {
      calls += 1;
      throw Object.assign(new Error('bad path'), { code: 'ENOENT' });
    },
  }), /bad path/);
  assert.equal(calls, 1);
});
