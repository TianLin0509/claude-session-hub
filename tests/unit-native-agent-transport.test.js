'use strict';

// Answered server requests must not re-open permission UI in the same epoch.
require('node:test').test('duplicate answered permission request stays resolved; changed payload is rejected', async () => {
  const { ClaudeStreamClient } = require('../main/claude-stream-client');
  const assert = require('node:assert/strict');
  const client = new ClaudeStreamClient(); let opened = 0;
  client.write = async () => {}; client.on('request', () => opened++);
  const request = { type: 'control_request', request_id: 'permission',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'one' } } };
  client.receive(request); await client.respond('permission', { behavior: 'deny', message: 'denied' });
  client.receive(request); assert.equal(opened, 1);
  assert.throws(() => client.receive({ ...request, request: { ...request.request, input: { command: 'two' } } }), /reused/);
});
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const { ClaudeStreamClient, streamArgs } = require('../main/claude-stream-client');

function client(mode = 'normal', overrides = {}) {
  return new ClaudeStreamClient({ executable: process.execPath,
    commandArgs: [path.join(__dirname, 'fixtures', 'claude-stream.js'), '--fixture=' + mode],
    controlTimeoutMs: 2000, initializeTimeoutMs: 2000, closeTimeoutMs: 500, ...overrides });
}

test('close waits for exit evidence when Windows kill races an already exited child', async () => {
  const c = new ClaudeStreamClient({ closeTimeoutMs: 1 });
  const proc = new EventEmitter();
  Object.assign(proc, { exitCode: null, signalCode: null, stdin: { end() {} },
    kill() { setImmediate(() => { proc.exitCode = 0; proc.emit('close', 0); }); return false; } });
  c.proc = proc;
  await c.close();
  assert.equal(proc.exitCode, 0);
});

test('SDK args preserve explicit settings and never invoke a shell or bare mode', () => {
  const args = streamArgs(['--model', 'chosen-model', '--effort', 'max', '--settings', 'path with spaces.json']);
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('stdio'));
  assert.ok(args.includes('path with spaces.json'));
  assert.ok(!args.includes('--bare'));
  assert.ok(!args.includes('--system-prompt'));
  assert.throws(() => streamArgs(['--output-format=text']), /owned by the transport/);
});

test('real pipes preserve long multiline Unicode and concurrent frame boundaries', async t => {
  const c = client('echo-only');
  t.after(() => c.close());
  assert.equal((await c.start()).test, true);
  const seen = [];
  c.on('message', m => seen.push(m));
  const payloads = Array.from({ length: 12 }, (_, i) => ({ type: 'user', uuid: 'user-' + i,
    message: { role: 'user', content: ('\r\n- 中文 🧪 `code` "quote" ' + i).repeat(600) } }));
  const done = new Promise(resolve => c.on('message', () => { if (seen.length === payloads.length) resolve(); }));
  await Promise.all(payloads.map(m => c.write(m)));
  await done;
  assert.deepEqual(seen.map(m => ({ type: m.type, uuid: m.uuid, message: m.message })), payloads);
});

test('control requests correlate separately and explicit rejection propagates', async t => {
  const c = client(); t.after(() => c.close()); await c.start();
  const responses = await Promise.all([c.control({ subtype: 'set_model', model: 'A' }), c.control({ subtype: 'set_model', model: 'B' })]);
  assert.deepEqual(responses.map(r => r.requested.model), ['A', 'B']);
  await assert.rejects(c.control({ subtype: 'fixture-error' }), { code: 'CLAUDE_CONTROL_REJECTED' });
  assert.equal(c.pending.size, 0);
});

test('permission response uses the request ID exactly once', async t => {
  const c = client('approval'); t.after(() => c.close()); await c.start();
  const incoming = once(c, 'request');
  await c.write({ type: 'user', uuid: 'a', message: { role: 'user', content: 'try' } });
  const [request] = await incoming;
  assert.equal(request.request.tool_name, 'Bash');
  const reply = new Promise(resolve => c.on('message', m => { if (m.subtype === 'fixture_response') resolve(m.reply); }));
  await c.respond(request.request_id, { behavior: 'deny', message: 'No' });
  assert.equal((await reply).response.response.behavior, 'deny');
  await assert.rejects(c.respond(request.request_id, {}), { code: 'CLAUDE_STALE_REQUEST' });
});

test('control timeout is visible and late response does not resurrect a request', async t => {
  const c = client(); t.after(() => c.close()); await c.start();
  const diagnostic = new Promise(resolve => c.on('diagnostic', d => { if (d.type === 'late-response') resolve(d); }));
  await assert.rejects(c.control({ subtype: 'fixture-timeout' }, 20), { code: 'CLAUDE_CONTROL_TIMEOUT' });
  await diagnostic;
  assert.equal(c.pending.size, 0);
});

for (const mode of ['malformed', 'truncated', 'exit-before-init', 'no-init']) {
  test('startup failure is propagated and child is closed: ' + mode, async t => {
    const c = client(mode, { initializeTimeoutMs: mode === 'no-init' ? 80 : 2000 });
    t.after(() => c.close());
    await assert.rejects(c.start(), /Claude|Invalid/);
    assert.equal(c.closed, true);
    assert.equal(c.pending.size, 0);
  });
}

test('spawn failure is reported without an unhandled error', async () => {
  const c = client('normal', { executable: path.join(__dirname, 'does-not-exist.exe') });
  await assert.rejects(c.start(), { code: 'CLAUDE_PROCESS_ERROR' });
  await c.close();
});

test('explicit isolated environment does not reintroduce removed parent settings', async t => {
  const old = process.env.HUB_NATIVE_TEST_PARENT_ONLY;
  process.env.HUB_NATIVE_TEST_PARENT_ONLY = 'test';
  t.after(() => { if (old === undefined) delete process.env.HUB_NATIVE_TEST_PARENT_ONLY; else process.env.HUB_NATIVE_TEST_PARENT_ONLY = old; });
  const env = { ...process.env }; delete env.HUB_NATIVE_TEST_PARENT_ONLY;
  const c = client('normal', { env }); t.after(() => c.close());
  await c.start();
  assert.equal((await c.control({ subtype: 'fixture-env' })).inherited, false);
});
