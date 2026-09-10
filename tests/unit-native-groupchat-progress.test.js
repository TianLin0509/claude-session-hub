'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const groupchat = require('../core/group-chat-orchestrator');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher');
const { SessionManager } = require('../core/session-manager');
const { buildHomeSnapshot } = require('../renderer/home-workbench');

test('public native members stay inside their meeting in sidebar/home consumers', () => {
  for (const kind of ['claude', 'codex']) {
    const info = { id: 'member', kind, meetingId: 'meeting', status: 'running',
      runtimeBackend: kind === 'codex' ? 'codex-app-server' : 'claude-stream-json',
      nativeRuntime: { state: 'waiting', connection: 'connected', epoch: 1, revision: 5, requests: [] } };
    const view = SessionManager.prototype._toPublic(info);
    assert.equal(view.meetingId, 'meeting');
    const home = buildHomeSnapshot({ sessions: new Map([[view.id, view]]),
      meetings: { meeting: { id: 'meeting', groupChat: true, subSessions: ['member'] } } });
    assert.equal(home.items.length, 1, 'a member must not appear again as an independent session');
    assert.equal(home.metrics.waiting, 1);
  }
});

test('native group progress follows its exact turn, never polls PTY, and removes listeners on completion', { timeout: 10000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-progress-'));
  const native = new EventEmitter(), tap = new EventEmitter(), manager = new EventEmitter();
  const session = { id: 's', kind: 'codex', title: 'Codex 1', status: 'running', meetingId: 'm' };
  const meeting = { id: 'm', groupChat: true, scene: 'general', subSessions: ['s'], participants: [0], slotSpecs: [{ kind: 'codex', memberId: 'm1' }] };
  const ipc = []; let outcome = null, ptyReads = 0, releaseFirstRead;
  native.runtime = { state: 'waiting', connection: 'connected', turnId: 'turn-current', epoch: 1, revision: 5 };
  native.start = async () => {};
  native.send = async (_text, opts) => ({ ok: true, sendStatus: 'ok', clientSubmissionId: opts.clientSubmissionId,
    acknowledgementSource: 'codex-app-server', acknowledgementTurnId: 'turn-current' });
  native.readOutcome = async id => {
    if (!releaseFirstRead) return new Promise(resolve => { releaseFirstRead = resolve; });
    return id === 'turn-current' ? outcome : null;
  };
  native.blocks = () => [{ type: 'text', text: '原生输出片段' }];
  manager.getNativeCodex = () => native;
  manager.getSession = () => session;
  manager.getSessionBuffer = () => { ptyReads++; throw new Error('Native group entered PTY output polling'); };
  manager.getGroupChatReady = () => true;
  manager.setGroupChatReady = () => {};
  for (const key of ['clearLastTokens', 'clearStreamingBuf']) tap[key] = () => {};
  tap.getLastTokens = () => null;
  const dispatcher = createGroupChatDispatcher({ sessionManager: manager, transcriptTap: tap, groupchat,
    getHubDataDir: () => root, cliReadyDetector: {}, isCodexBaseKind: () => true,
    logger: { log() {}, warn() {} }, maybeAutoTitleMeetingFromPrompt() {},
    meetingManager: { getMeeting: () => meeting, getAllMeetings: () => [meeting] },
    sendToRenderer: (channel, payload) => ipc.push({ channel, payload }) });
  const pending = dispatcher.dispatchGroupChatTurn('m', { userInput: '本轮准确身份' });
  t.after(async () => {
    for (const watcher of dispatcher.getActiveWatchers().values()) watcher.supersede();
    await pending;
    groupchat._private.resetCache(); fs.rmSync(root, { recursive: true, force: true });
  });
  const deadline = Date.now() + 2000;
  while (!dispatcher.getActiveWatchers().size) {
    assert.ok(Date.now() < deadline, 'native watcher must attach');
    await new Promise(resolve => setImmediate(resolve));
  }
  const orch = groupchat.getOrchestrator(root, 'm');
  const latest = () => Object.values(orch.getState().attempts).at(-1);
  assert.equal(latest().status, 'waiting', 'approval may arrive before send response / watcher registration');
  native.runtime = { ...native.runtime, state: 'running', turnId: 'old-turn', revision: 6 };
  native.emit('state'); native.emit('items');
  assert.equal(latest().status, 'waiting', 'another turn cannot downgrade current approval');
  native.runtime = { ...native.runtime, turnId: 'turn-current', state: 'waiting', revision: 7 };
  native.emit('state'); native.emit('items');
  assert.equal(latest().status, 'waiting');
  assert.ok(ipc.some(row => row.channel === 'groupchat-partial-update' && row.payload.status === 'waiting'));
  assert.equal(ptyReads, 0);
  outcome = { hubSessionId: 's', turnId: 'turn-current', threadId: 'thread', source: 'codex-app-server',
    signalSource: 'codex-app-server', status: 'completed', text: '准确结束', completedAt: Date.now(), finality: 'provider_final' };
  native.runtime = { ...native.runtime, state: 'completed', revision: 8 };
  native.emit('state');
  // Completion arrives while a read of the earlier unfinished turn is in flight.
  releaseFirstRead(null);
  let timer;
  const result = await Promise.race([pending, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Completion during outcome read was lost')), 2000);
  })]).finally(() => clearTimeout(timer));
  assert.equal(result.results[0].status, 'completed');
  assert.equal(result.results[0].text, '准确结束');
  assert.equal(native.listenerCount('state'), 0);
  assert.equal(native.listenerCount('items'), 0);
  assert.equal(ptyReads, 0);
});
