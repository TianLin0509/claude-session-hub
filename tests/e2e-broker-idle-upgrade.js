'use strict';
// Real local broker + real native transports using deterministic CLI fixtures.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict');
const { CodexSharedSession } = require('../core/codex-shared-session');
const { ClaudeSharedSession } = require('../core/claude-shared-session');
const { BrokerConnection, connectBroker, readMetadata, PROTOCOL_VERSION } = require('../main/codex-runtime-broker-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-upgrade-e2e-')), dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const store = path.join(root, 'store.json'), trace = path.join(root, 'trace.jsonl'); fs.writeFileSync(store, '[]');
process.env.AI_HUB_CODEX_BROKER_TEST = '1';
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { const end = Date.now() + 20000; while (!fn()) { if (Date.now() > end) throw Error('timeout: ' + label + ' ' + JSON.stringify({codex:a.runtime,claude:b.runtime})); await pause(30); } }
const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HUB_DATA_DIR: dataDir,
  CLAUDE_HUB_NATIVE_FIXTURE_STORE: store, CLAUDE_HUB_NATIVE_FIXTURE_TRACE: trace,
  CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.resolve(__dirname, 'fixtures/codex-app-server.js') };
const a = new CodexSharedSession({ id: 'codex-upgrade', cwd: root, hubDataDir: dataDir, env,
  processArgs: [], threadParams: { cwd: root, model: 'fixture-model', approvalPolicy: 'never', sandbox: 'danger-full-access' },
  turnParams: { model: 'fixture-model' } });
const settings = path.join(root, 'settings.json'); fs.writeFileSync(settings, '{"fastMode":false}');
const b = new ClaudeSharedSession({ id: 'claude-upgrade', cwd: root, hubDataDir: dataDir, env, ownership: true,
  settingsFile: settings, executable: process.execPath, commandArgs: [path.resolve(__dirname, 'fixtures/claude-stream.js'), '--fixture=hold'],
  launchArgs: ['--permission-mode', 'acceptEdits', '--settings', settings] });
(async () => {
  let requesting;
  try {
    await a.start(); await b.start();
    await a.send('fixture:hold', { clientSubmissionId: 'codex-before-upgrade' });
    await b.submit('hold through upgrade', { clientSubmissionId: 'claude-before-upgrade' });
    await until(() => ['starting','running'].includes(a.runtime.state) && ['starting','running'].includes(b.runtime.state), 'both running');
    const old = readMetadata(dataDir), threadId = a.threadId, claudeId = b.sessionId;
    const socket = await new Promise((resolve, reject) => { const value = net.createConnection(old.pipe); value.once('connect', () => resolve(value)); value.once('error', reject); });
    requesting = new BrokerConnection(socket);
    const hello = await requesting.request('hello', { token: old.token, protocolVersion: PROTOCOL_VERSION,
      runtimeBuild: { version: '99.0.0', fingerprint: 'simulated-future-build' } });
    assert.equal(hello.upgrade.status, 'pending');
    await pause(200); assert.equal(readMetadata(dataDir).serviceId, old.serviceId);
    assert(['starting','running'].includes(a.runtime.state)); assert(['starting','running'].includes(b.runtime.state));
    // Only the test's explicit stop ends these fixture turns.
    await a.interrupt(); await until(() => a.runtime.state === 'interrupted', 'Codex stopped');
    await pause(100); assert.equal(readMetadata(dataDir).serviceId, old.serviceId, 'Claude still owns work');
    await b.interrupt();
    await until(() => readMetadata(dataDir)?.serviceId !== old.serviceId && a.runtime.connection === 'connected' && b.runtime.connection === 'connected'
      && a.serviceId !== old.serviceId && b.serviceId !== old.serviceId, 'both reconnect to new broker');
    assert.equal(a.threadId, threadId); assert.equal(b.sessionId, claudeId);
    assert(b.records.has('claude-before-upgrade'), 'Claude receipt survives broker replacement');
    assert(a.readTranscript({ limit: Infinity }).some(t => t.text?.includes('fixture:hold')), 'original Codex prompt survives replacement');
    assert.equal(fs.readFileSync(trace, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)).filter(row => row.method === 'turn/start').length, 1, 'reconnect never resends the prompt');
    console.log('PASS real broker upgrade: waits for both providers, confirmed writer release, reconnects original identities and history');
  } finally {
    requesting?.close(); a.kill(); await b.close(); await pause(150);
    if (readMetadata(dataDir)) { const client = await connectBroker({ dataDir }); await client.request('shutdown-test'); client.close(); }
    delete process.env.AI_HUB_CODEX_BROKER_TEST;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
