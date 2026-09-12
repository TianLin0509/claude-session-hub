'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CodexNativeSession } = require('../core/codex-native-session');
const { CodexAppServerClient } = require('../main/codex-app-server-client');
const { configureMode, turnCollaborationMode } = require('../core/codex-native-mode');
const { persistNativeRuntime } = require('../core/codex-native-runtime');
async function until(fn) {
  const end = Date.now() + 4000;
  while (!fn()) { if (Date.now() > end) throw Error('timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
test('native plan command creates no turn, preserves model/effort, and default reset reaches next turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-mode-'));
  const trace = path.join(root, 'trace.jsonl');
  const native = new CodexNativeSession({ id: 'mode', cwd: root,
    env: { CODEX_HOME: root, CLAUDE_HUB_DATA_DIR: path.join(root, 'hub') },
    threadParams: { model: 'fixture-model' }, turnParams: { model: 'fixture-model', effort: 'max' },
    clientFactory: () => new CodexAppServerClient({ cwd: root, timeoutMs: 2000,
      launch: { command: process.execPath, args: [path.join(__dirname, 'fixtures/codex-app-server.js')],
        env: { ...process.env, CLAUDE_HUB_NATIVE_FIXTURE_TRACE: trace } } }) });
  t.after(async () => { const client = native.entry?.client; native.kill(); await until(() => !native.entry);
    await client?.waitForExit(); fs.rmSync(root, { recursive: true, force: true }); });
  const calls = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal((await native.send('/plan')).mode, 'native-command');
  assert.equal(native.receipts.size, 0);
  assert.ok(!calls().some(c => c.method === 'turn/start'));
  await native.send('test plan', { clientSubmissionId: 'a' }); await until(() => native.runtime.state === 'completed');
  let params = calls().findLast(c => c.method === 'turn/start').params;
  assert.deepEqual(params.collaborationMode, { mode: 'plan', settings: { model: 'fixture-model', reasoning_effort: 'max', developer_instructions: null } });
  const restored = persistNativeRuntime({ kind: 'codex', nativeRuntime: native.runtime });
  assert.equal(turnCollaborationMode({ runtime: restored, options: native.options }).collaborationMode.mode, 'plan');
  await native.send('/plan off');
  await native.send('test default', { clientSubmissionId: 'b' }); await until(() => native.runtime.state === 'completed');
  params = calls().findLast(c => c.method === 'turn/start').params;
  assert.equal(params.collaborationMode.mode, 'default');
  assert.equal(params.model, 'fixture-model'); assert.equal(params.effort, 'max');
  assert.ok(!calls().some(c => /config\/.*write/.test(c.method || '')));
});

test('mode changes reject busy, stale, unknown and unsupported cases without applying presets', async () => {
  const applied = [];
  const session = { runtime: { state: 'running', epoch: 2 }, start: async () => {},
    checkSendable() {}, apply: value => applied.push(value), entry: { client: { request: async () => ({ data: [] }) } } };
  await assert.rejects(configureMode(session, 'plan', {}), /当前轮次/);
  session.runtime.state = 'completed';
  await assert.rejects(configureMode(session, 'plan', {}, 1), /旧连接/);
  await assert.rejects(configureMode(session, 'plan', {}), /不支持/);
  session.checkSendable = () => { throw Error('unknown submission'); };
  await assert.rejects(configureMode(session, 'plan', {}), /unknown submission/);
  assert.deepEqual(applied, []);
  assert.deepEqual(turnCollaborationMode({ runtime: {} }), {});
});

test('a mode-list response cannot configure a replaced connection or newly started turn', async () => {
  let resolve;
  const session = { runtime: { state: 'completed', epoch: 1 }, start: async () => {}, checkSendable() {},
    apply() { assert.fail('must not apply stale mode'); }, entry: { client: { request: () => new Promise(r => { resolve = r; }) } } };
  const pending = configureMode(session, 'plan', {}); await until(() => resolve);
  session.runtime.state = 'running'; resolve({ data: [{ mode: 'plan' }] });
  await assert.rejects(pending, /当前轮次/);
});
