'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireLock,
  acquireLockAsync,
  releaseLock,
  releaseLockAsync,
} = require('../core/file-lock.js');

test('async lock contention yields to the event loop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lock-async-'));
  const lockPath = path.join(dir, 'state.lock');
  const held = acquireLock(lockPath, { retries: 0 });
  assert.ok(held);
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 2);
  const contested = await acquireLockAsync(lockPath, { retries: 5, retryDelayMs: 10 });
  clearInterval(timer);
  assert.equal(contested, null);
  assert.ok(ticks > 0, 'lock retry must not busy-wait the caller thread');
  releaseLock(held, lockPath);

  const acquired = await acquireLockAsync(lockPath, { retries: 0 });
  assert.ok(acquired);
  await releaseLockAsync(acquired, lockPath);
  assert.equal(fs.existsSync(lockPath), false);
});
