'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionOpenOwnership } = require('../core/session-open-ownership');

function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-alias-writer-'));
  const living = new Set([101, 102, 201, 202]);
  const a = new SessionOpenOwnership({ directory, pid: 101, isAlive: pid => living.has(pid) });
  const b = new SessionOpenOwnership({ directory, pid: 102, isAlive: pid => living.has(pid) });
  t.after(() => { a.close(); b.close(); });
  const row = key => a.db.prepare('SELECT * FROM open_owners WHERE key=?').get(key);
  return { a, b, living, row };
}

test('native alias added after PID binding inherits that writer and its original observation time', t => {
  const h = harness(t), lease = h.a.claim('branch');
  h.a.bindPid(lease, 201);
  const observedAt = Date.now() - 1000;
  h.a.db.prepare('UPDATE open_owners SET observed_at=? WHERE nonce=?').run(observedAt, lease.nonce);
  h.a.add(lease, ['native:child']);
  h.a.bindPid(lease, 201); // normal refresh fast path: the PID has not changed
  assert.equal(h.row('native:child').server_pid, 201);
  assert.equal(h.row('native:child').observed_at, observedAt, 'adding an alias must not make a reused PID appear older than it is');
  assert.equal(h.row('hub:branch').nonce, h.row('native:child').nonce);
});

test('Hub exit does not free a late native alias while its writer survives; final exit allows recovery', t => {
  const h = harness(t), lease = h.a.claim('branch');
  h.a.bindPid(lease, 201); h.a.add(lease, ['native:child']);
  h.living.delete(101);
  assert.throws(() => h.b.claim('duplicate-child', ['native:child']), error => error.code === 'SESSION_OCCUPIED');
  assert.equal(h.b.owner('duplicate-child'), null, 'failed multikey claim rolls back the new Hub card');
  h.living.delete(201);
  const next = h.b.claim('resumed-child', ['native:child']);
  h.a.release(lease);
  assert.equal(h.row('native:child').session, 'resumed-child', 'stale nonce cannot release the recovered writer');
  h.b.release(next);
});

test('unbound aliases bind together, and later aliases follow the replacement writer PID', t => {
  const h = harness(t), lease = h.a.claim('fresh', ['native:first']);
  assert.equal(h.row('native:first').server_pid, null);
  h.a.bindPid(lease, 201);
  assert.equal(h.row('native:first').server_pid, 201);
  h.a.bindPid(lease, 202);
  h.a.add(lease, ['native:second']);
  assert.equal(h.row('native:first').server_pid, 202);
  assert.equal(h.row('native:second').server_pid, 202);
  assert.throws(() => h.b.claim('same-native', ['native:second']), error => error.code === 'SESSION_OCCUPIED');
});
