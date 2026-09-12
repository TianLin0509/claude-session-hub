'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexSharedSession } = require('../core/codex-shared-session');
const { readMetadata } = require('../main/codex-runtime-broker-client');
const { SessionManager, _private:{ sharedCodexRuntimeEnabled } } = require('../core/session-manager');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-unit-'));
const dataDir = path.join(root, 'hub');
const codexHome = path.join(root, 'codex');
const trace = path.join(root, 'native-trace.jsonl');
fs.mkdirSync(dataDir, { recursive:true });
fs.mkdirSync(codexHome, { recursive:true });

test('shared runtime defaults are explicit and keep plain Node tests isolated', () => {
  assert.equal(sharedCodexRuntimeEnabled({ CLAUDE_HUB_CODEX_SHARED_RUNTIME:'1' }), true);
  assert.equal(sharedCodexRuntimeEnabled({ CLAUDE_HUB_CODEX_SHARED_RUNTIME:'0' }), false);
  assert.equal(sharedCodexRuntimeEnabled({ CLAUDE_HUB_E2E:'1' }), false);
});

test('a viewer may close its local view while the shared Codex keeps working', () => {
  const manager = new SessionManager();
  manager.sessions.set('viewer-card', {
    info:{ id:'viewer-card', kind:'codex', runtimeBackend:'codex-app-server', codexSid:'thread-1',
      nativeRuntime:{ state:'running', connection:'connected' } },
    pty:{ control:{ shared:true, role:'viewer' } }, pendingTimers:new Set(),
    startedAt:1, lastInputAt:1, lastOutputAt:1,
  });
  assert.equal(manager._evaluateSuspendEligibility('viewer-card').ok, false);
  assert.equal(manager._evaluateSuspendEligibility('viewer-card', { allowSharedViewerDetach:true }).ok, true);
});

function options(id, resumeId) {
  return {
    id, cwd:__dirname, hubDataDir:dataDir, hubPid:process.pid, hubVersion:'test',
    env:{ ...process.env, CODEX_HOME:codexHome, CLAUDE_HUB_DATA_DIR:dataDir,
      CLAUDE_HUB_NATIVE_FIXTURE_TRACE:trace,
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname, 'fixtures', 'codex-app-server.js') },
    processArgs:[], threadParams:{ cwd:__dirname, model:'fixture-model', approvalPolicy:'never', sandbox:'danger-full-access',
      config:{ model_reasoning_effort:'max' } },
    turnParams:{ model:'fixture-model', effort:'max' },
    resumeId:resumeId || null,
  };
}

async function until(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timeout: ' + message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('shared mode changes preserve the host epoch and reject stale viewer state', async () => {
  const calls = [];
  const client = new (require('events').EventEmitter)();
  client.closed = false;
  client.close = () => { client.closed = true; };
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'attach') return {
      key:'thread-key', threadId:'thread-1', runtime:{ ...require('../core/codex-native-runtime').createNativeRuntime(),
        epoch:9, revision:1, connection:'connected', state:'idle', threadId:'thread-1' },
      control:{ shared:true, role:'controller', controllerEpoch:3, viewerCount:1, transferReady:true },
      transcript:[], blocks:[], finalText:'', contentRevision:0,
    };
    if (method === 'action') return { ok:true };
    if (method === 'detach') return { ok:true };
    throw new Error('unexpected request: ' + method);
  };
  const session = new CodexSharedSession({ ...options('mode-card', 'thread-1'),
    brokerConnector:async () => client });
  try {
    await session.start();
    assert.equal(session.runtime.epoch, 1, 'each Hub view keeps its local epoch');
    await session.configureMode('plan', session.runtime.epoch);
    const action = calls.find(call => call.method === 'action');
    assert.deepEqual(action.params.args, ['plan', 9], 'the broker host epoch must reach the native driver');
    assert.equal(action.params.controllerEpoch, 3);
    await assert.rejects(session.configureMode('default', 0), /旧窗口状态/);
  } finally {
    session.kill();
  }
});

test('two Hub adapters share one native writer and transfer only after confirmed stop', async () => {
  process.env.AI_HUB_CODEX_BROKER_TEST = '1';
  const a = new CodexSharedSession(options('card-a'));
  let b, lazy;
  try {
    await a.start();
    assert.equal(a.control.role, 'controller');
    assert(a.threadId);
    const nativePid = a.pid;

    b = new CodexSharedSession(options('card-b', a.threadId));
    await b.start();
    assert.equal(b.control.role, 'viewer');
    assert.equal(b.pid, nativePid, 'both adapters must report the same app-server pid');
    assert.equal(b.threadId, a.threadId);

    const first = await a.send('fixture:hold', { clientSubmissionId:'shared-hold' });
    await until(() => b.runtime.state === 'running', 'viewer sees running');
    await assert.rejects(b.requestControl(), /工作中/);
    await assert.rejects(b.send('must-not-send', { clientSubmissionId:'blocked' }), /只能查看/);

    const nativeCommands = () => fs.readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line))
      .filter(m=>m.method).map(m=>m.method);
    const beforeDisconnect = nativeCommands();
    const oldClient = a.client;
    a.client.socket.destroy();
    await until(() => a.client && a.client!==oldClient && a.runtime.connection==='connected'
      && a.runtime.state==='running','window resubscribes to the existing running turn');
    assert.equal(a.pid,nativePid);
    assert.equal(a.threadId,first.threadId);
    assert.equal(a.runtime.turnId,first.turnId);
    assert.equal(b.runtime.state,'running');
    assert.deepEqual(nativeCommands(),beforeDisconnect,'observer reconnect must send no commands to Codex');
    await a.reconnect();
    await b.reconnect();
    assert.deepEqual(nativeCommands(),beforeDisconnect,'UI connection checks must only read broker snapshots');

    await a.interrupt();
    await until(() => a.runtime.state === 'interrupted' && b.runtime.state === 'interrupted', 'both see interrupted');
    // Replies and cross-window broadcasts travel on different sockets. Make
    // their independent delivery deterministic instead of relying on load.
    const deliverNotification=a.onNotification;
    a.onNotification=message=>{
      if(message.method==='control' && message.params.control.role==='viewer') {
        a.onNotification=deliverNotification;
        setTimeout(()=>deliverNotification(message),80);
      } else deliverNotification(message);
    };
    const control = await b.requestControl();
    assert.equal(control.role, 'controller');
    assert.equal(b.threadId, first.threadId);
    await assert.rejects(a.send('late-owner', { clientSubmissionId:'late' }), /只能查看|已经变化/);
    await until(() => a.control.role === 'viewer','old window receives the independent control broadcast');

    const second = await b.send('共享下一轮', { clientSubmissionId:'shared-next' });
    await until(() => a.runtime.state === 'completed' && b.runtime.state === 'completed', 'both see completion');
    assert.equal(second.threadId, first.threadId);
    assert.equal(a.finalText(), '原生回答 ✅');
    assert.equal(b.finalText(), '原生回答 ✅');
    assert.deepEqual(a.readTranscript({ limit:Infinity }), b.readTranscript({ limit:Infinity }));
    assert(b.readTranscript({limit:Infinity,turnId:first.turnId}).some(card=>card.role==='user'),
      'incremental updates must preserve every previous turn');
    const latest = b.readTranscript({ limit:Infinity, latestTurn:true, turnId:second.turnId });
    assert(latest.some(card => card.role === 'user'));
    assert(latest.some(card => card.role === 'assistant'));

    lazy = new CodexSharedSession({ ...options('lazy-card'), lazyStart:true, resumeId:null });
    await lazy.start();
    assert.equal(lazy.runtime.connection, 'unstarted');
    assert.equal(lazy.control.role, 'controller');
    await lazy.send('fixture:empty', { clientSubmissionId:'lazy-first' });
    await until(() => lazy.runtime.state === 'completed', 'lazy shared first send');
    assert(lazy.threadId);

    const metadata = readMetadata(dataDir);
    assert(metadata && metadata.pid > 0);
    await b.client.request('shutdown-test', {}, 3000);
    await until(() => !readMetadata(dataDir), 'broker metadata removed', 5000);
  } finally {
    a.kill();
    b?.kill();
    lazy?.kill();
    delete process.env.AI_HUB_CODEX_BROKER_TEST;
    const metadata = readMetadata(dataDir);
    if (metadata?.pid) {
      try { process.kill(metadata.pid, 'SIGTERM'); } catch {}
    }
  }
});
