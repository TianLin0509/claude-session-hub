'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClaudeNativeSession } = require('../core/claude-native-session');

function session(reply = {}) {
  const native = new ClaudeNativeSession({ id: 's1', kind: 'claude', cwd: process.cwd(),
    launchArgs: ['--model', 'claude-opus-5[1m]', '--permission-mode', 'default'],
    settingsFile: null, sessionId: '11111111-2222-3333-4444-555555555555' });
  native.ready = Promise.resolve();
  native.controls = [];
  native.client = { control: async request => { native.controls.push(request); return reply[request.subtype] ?? {}; } };
  native.runtime.connection = 'connected';
  return native;
}

test('the Hub keeps the three commands whose result it also displays', async () => {
  const native = session({ set_permission_mode: { mode: 'plan' } });
  const plan = await native.slash('/plan');
  assert.equal(plan.mode, 'native-command');
  assert.match(plan.commandOutput, /计划/);
  assert.equal(native.runtime.permissionMode, 'plan');
  // A relaunch has to carry the confirmed mode.
  assert.deepEqual(native.options.launchArgs, ['--model', 'claude-opus-5[1m]', '--permission-mode', 'plan']);

  await native.slash('/model claude-sonnet-5');
  assert.deepEqual(native.options.launchArgs.slice(0, 2), ['--model', 'claude-sonnet-5']);

  const fast = await native.slash('/fast on');
  assert.match(fast.commandOutput, /Fast/);
  assert.equal(native.runtime.fastMode, true);
  assert.deepEqual(native.controls.map(c => c.subtype),
    ['set_permission_mode', 'set_model', 'apply_flag_settings']);
});

test('every other command is the engine\'s own and reports its real output', async () => {
  const native = session();
  const sent = [];
  native.submit = async text => {
    sent.push(text);
    const record = { submissionId: 'c1', status: 'accepted', ack: Promise.resolve(null) };
    native.records.set('c1', record);
    setTimeout(() => { record.status = 'completed'; record.commandOutput = '## Context Usage'; }, 10);
    return { clientSubmissionId: 'c1', sendStatus: 'accepted' };
  };
  const result = await native.slash('/context');
  assert.deepEqual(sent, ['/context']);
  assert.equal(result.commandOutput, '## Context Usage');
  assert.deepEqual(native.controls, [], 'a forwarded command must not touch the control channel');
});

test('a command the engine never finishes is reported as unconfirmed, not as success', async () => {
  const native = session();
  native.options.commandTimeoutMs = 60;
  native.submit = async () => {
    native.records.set('c2', { submissionId: 'c2', status: 'accepted', ack: Promise.resolve(null) });
    return { clientSubmissionId: 'c2', sendStatus: 'accepted' };
  };
  const result = await native.slash('/doctor');
  assert.equal(result.ok, false);
  assert.equal(result.sendStatus, 'stuck');
});

test('a failed command raises instead of printing an empty success', async () => {
  const native = session();
  native.submit = async () => {
    const record = { submissionId: 'c3', status: 'accepted', ack: Promise.resolve(null) };
    native.records.set('c3', record);
    setTimeout(() => { record.status = 'failed'; }, 5);
    return { clientSubmissionId: 'c3', sendStatus: 'accepted' };
  };
  await assert.rejects(() => native.slash('/nope'), /命令未完成：failed/);
});

test('the echo check stays strict for prompts and accepts only the same command envelope', () => {
  const native = session();
  const content = [{ type: 'text', text: 'ask something' }];
  const { createHash } = require('crypto');
  // Same canonical form the driver hashes: object keys sorted, arrays in order.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(content.map(block => ({ text: block.text, type: block.type })))).digest('hex');
  const prompt = { commandName: null, fingerprint };
  // An ordinary prompt must still match byte for byte.
  assert.equal(native.echoMatches({ message: { content } }, prompt), true);
  assert.equal(native.echoMatches({ message: { content: [{ type: 'text', text: 'other' }] } }, prompt), false);

  // A command echo is the engine's own envelope, not the text we sent.
  const command = { commandName: '/context', fingerprint: 'unused' };
  const envelope = text => ({ message: { content: [{ type: 'text', text }] } });
  assert.equal(native.echoMatches(envelope('<command-name>/context</command-name>\n<command-args></command-args>'), command), true);
  assert.equal(native.echoMatches(envelope('<command-name>context</command-name>'), command), true);
  // A different command, or no envelope at all, is still a mismatch.
  assert.equal(native.echoMatches(envelope('<command-name>/compact</command-name>'), command), false);
  assert.equal(native.echoMatches(envelope('just text'), command), false);
});

test('effort only moves when the engine confirms that exact level', async () => {
  const native = session();
  const outputs = [];
  let reply = '';
  native.slash = async text => { outputs.push(text); return { commandOutput: reply }; };
  reply = 'Set effort level to high (this session only): Comprehensive implementation';
  const applied = await native.setEffort('HIGH');
  assert.equal(applied.effort, 'high');
  assert.equal(native.runtime.effort, 'high');
  assert.deepEqual(outputs, ['/effort high']);
  // The launch flag follows, so a reconnect keeps the level.
  assert.deepEqual(native.options.launchArgs.slice(-2), ['--effort', 'high']);

  // The engine answers an unsupported level with an ordinary message, not an
  // error; taking that as success would leave the chip lying.
  reply = 'Invalid argument: banana. Valid options are: low, medium, high, xhigh, max, ultracode, auto';
  await assert.rejects(() => native.setEffort('max'), /Invalid argument/);
  assert.equal(native.runtime.effort, 'high');
  await assert.rejects(() => native.setEffort('banana'), /思考档无效/);

  // ultracode and auto are valid commands but not valid launch flags, so the
  // args must not be rewritten with something the next launch would reject.
  reply = 'Set effort level to ultracode (this session only)';
  await native.setEffort('ultracode');
  assert.deepEqual(native.options.launchArgs.slice(-2), ['--effort', 'high']);
  assert.equal(native.runtime.effort, 'ultracode');
});
