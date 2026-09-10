'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ClaudeNativeSession } = require('../core/claude-native-session');

function session(mode = 'normal') {
  return new ClaudeNativeSession({ executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures/claude-stream.js'), '--fixture=' + mode] });
}

test('closing a crashed recoverable session notifies the later shutdown waiter once without settling its unknown input', async t => {
  const native = session('crash-on-user'); t.after(() => native.close());
  await native.start();
  const crashed = once(native, 'exit');
  await assert.rejects(native.submit('must stay unknown', { clientSubmissionId: 'crashed' }));
  await crashed;
  assert.equal(native.runtime.state, 'unknown');
  assert.equal(native.closed, false, 'crash preserves the logical session for recovery');
  const record = native.records.get('crashed');
  const status = record.status;
  const exits = []; native.onExit(event => exits.push(event));
  await Promise.all([native.close(), native.close()]);
  native.kill();
  await Promise.resolve();
  assert.equal(exits.length, 1, 'a waiter installed after the child crash must still be notified on explicit close');
  assert.equal(exits[0].expected, true);
  assert.equal(native.runtime.state, 'unknown');
  assert.equal(record.status, status, 'resource closure does not claim an engine result');
});

test('live close notifies once after the owned process has exited', async () => {
  const native = session(); await native.start();
  const exits = []; native.onExit(event => exits.push({ event, exitCode: native.client.proc.exitCode }));
  await Promise.all([native.close(), native.close()]);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].event.expected, true);
  assert.equal(exits[0].exitCode, 0);
});

test('closing before launch releases a logical waiter, while an unconfirmed child close cannot', async () => {
  const unstarted = session();
  let exits = 0; let repeated;
  unstarted.onExit(() => { exits++; repeated = unstarted.close(); });
  await unstarted.close(); await unstarted.close();
  assert.equal(exits, 1);
  assert.equal(repeated, unstarted.closePromise);
  assert.equal(unstarted.client, null);
  const failed = session();
  failed.client = { close: async () => { throw new Error('child exit unconfirmed'); } };
  let unsafeExit = false; failed.onExit(() => { unsafeExit = true; });
  await assert.rejects(failed.close(), /child exit unconfirmed/);
  assert.equal(unsafeExit, false);
});

test('a reconnected generation owns a fresh close barrier', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-close-generation-'));
  const native = session();
  native.options.env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  t.after(async () => { await native.client?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await native.start(); await native.close();
  const old = native.client;
  await native.reconnect();
  assert.notEqual(native.client, old);
  let exits = 0; native.onExit(() => exits++);
  await native.close();
  assert.equal(native.client.proc.exitCode, 0);
  assert.equal(exits, 1);
});

test('shutdown during reconnect cannot reopen a writer after logical closure', async t => {
  const native = session(); t.after(() => native.client?.close());
  await native.start();
  const old = native.client, originalClose = old.close.bind(old);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  old.close = () => gate.then(originalClose);
  const reconnect = native.reconnect();
  const closing = native.close();
  release();
  await closing;
  await assert.rejects(reconnect, /closed|关闭/);
  assert.equal(native.client, old, 'no replacement process may be launched');
  assert.equal(old.proc.exitCode, 0);
});
