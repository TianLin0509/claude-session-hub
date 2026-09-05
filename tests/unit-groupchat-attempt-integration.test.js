'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const groupChatWatcher = require('../core/group-chat-watcher.js');
const pasteTrappedDetector = require('../core/paste-trapped-detector.js');
const groupchat = require('../core/group-chat-orchestrator.js');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher.js');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function harness(sids) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-attempt-int-'));
  const tap = new EventEmitter();
  tap.setMaxListeners(100);
  tap.clearLastTokens = () => {};
  tap.getLastTokens = () => null;
  tap.getStreamingText = () => [];
  tap.clearStreamingBuf = () => {};
  tap.extractLatestTurn = async () => ({ text: '', extractMode: 'no_task_complete_yet' });
  tap.hasCodexUserMessageSince = async () => true;

  const sessionManager = new EventEmitter();
  const sessions = Object.fromEntries(sids.map((sid, index) => [sid, {
    id: sid, kind: 'codex', transcriptKind: 'codex', title: `Codex ${index + 1}`,
    status: 'active', meetingId: 'meeting',
  }]));
  sessionManager.getSession = sid => sessions[sid] || null;
  sessionManager.getSessionBuffer = () => '';
  sessionManager.getGroupChatLastActivity = () => 0;
  sessionManager.getGroupChatOutputBytes = () => 0;
  sessionManager.getGroupChatReady = () => true;
  sessionManager.setGroupChatReady = () => {};
  sessionManager.writeToSession = () => {};

  const meeting = {
    id: 'meeting', groupChat: true, scene: 'general',
    subSessions: sids.slice(),
    slotSpecs: sids.map((_, index) => ({ kind: 'codex', memberId: `m${index + 1}` })),
    participants: sids.map((_, index) => index),
  };
  const ipc = [];
  const deps = {
    cliReadyDetector: {},
    getHubDataDir: () => tmp,
    groupchat,
    isCodexBaseKind: kind => kind === 'codex',
    kindLabels: { codex: 'Codex' },
    logger: { log() {}, warn() {}, error() {} },
    maybeAutoTitleMeetingFromPrompt() {},
    meetingManager: {
      getMeeting: id => id === meeting.id ? meeting : null,
      getAllMeetings: () => [meeting],
    },
    sendToRenderer: (channel, payload) => ipc.push({ channel, payload }),
    sessionManager,
    transcriptTap: tap,
  };
  return { tmp, tap, meeting, sessions, sessionManager, ipc, dispatcher: createGroupChatDispatcher(deps) };
}

const originalSend = groupChatWatcher.sendToPty;
const originalStream = groupChatWatcher.extractStreamingText;
const originalClean = groupChatWatcher.cleanBufLen;
const originalHost = groupChatWatcher.checkHostShellTakeover;
const originalResend = groupChatWatcher.resendCurrentPrompt;
const originalInspect = groupChatWatcher.inspectPromptSubmissionState;
const originalPaste = { start: pasteTrappedDetector.start, tick: pasteTrappedDetector.tick, stop: pasteTrappedDetector.stop };

async function run() {
  groupChatWatcher.extractStreamingText = () => ({ text: '', blocks: [], source: 'placeholder' });
  groupChatWatcher.cleanBufLen = () => 0;
  groupChatWatcher.checkHostShellTakeover = () => false;
  groupChatWatcher.resendCurrentPrompt = async () => ({ ok: false, reason: 'must_not_resend' });
  groupChatWatcher.inspectPromptSubmissionState = () => ({ state: 'running_clear' });
  pasteTrappedDetector.start = () => {};
  pasteTrappedDetector.tick = () => 'ok';
  pasteTrappedDetector.stop = () => {};

  {
    const h = harness(['c1']);
    groupChatWatcher.sendToPty = async sid => ({
      ok: true,
      sendStatus: 'ok',
      acknowledgementSource: 'task_started',
      acknowledgementObservedAt: Date.now(),
      acknowledgementTurnId: `turn-${sid}-current`,
      enterAttempts: 1,
    });
    const pending = h.dispatcher.dispatchGroupChatTurn('meeting', { userInput: '只收当前轮' });
    await sleep(40);
    const liveRecovery = await h.dispatcher.recoverPendingAttempts();
    assert.strictEqual(liveRecovery.checked, 0,
      'session-bound recovery must never race a normal attempt created by this Hub process');
    h.tap.emit('turn-complete', {
      hubSessionId: 'c1', turnId: 'turn-c1-old', signalSource: 'task_complete',
      text: '上一轮迟到', completedAt: Date.now(),
    });
    await sleep(20);
    assert.ok(h.dispatcher.getActiveWatchers().get('c1'), 'wrong-turn completion must not settle current watcher');
    h.tap.emit('turn-complete', {
      hubSessionId: 'c1', turnId: 'turn-c1-current', signalSource: 'task_complete',
      text: '当前轮最终答案', completedAt: Date.now(),
    });
    const result = await pending;
    assert.strictEqual(result.results[0].text, '当前轮最终答案');
    assert.ok(result.results[0].attemptId);
    const state = groupchat.getOrchestrator(h.tmp, 'meeting').getState();
    assert.strictEqual(state.turns[0].providerTurnIdBy.c1, 'turn-c1-current');
    assert.strictEqual(state.attempts[result.results[0].attemptId].status, 'completed');
    assert.ok(state.attemptEvents.some(event => event.type === 'attempt_event_rejected'
      && event.reason === 'provider_turn_mismatch'));
  }

  {
    const h = harness(['c1', 'c2']);
    groupChatWatcher.sendToPty = async sid => ({
      ok: true, sendStatus: 'ok', acknowledgementSource: 'task_started',
      acknowledgementTurnId: `turn-${sid}`, enterAttempts: 1,
    });
    const pending = h.dispatcher.dispatchGroupChatTurn('meeting', { userInput: '一人额度不足也别拖死全组' });
    await sleep(40);
    h.tap.emit('turn-complete', {
      hubSessionId: 'c1', turnId: 'turn-c1', signalSource: 'task_complete',
      text: "You've hit your session limit · resets 6am", completedAt: Date.now(),
    });
    h.tap.emit('turn-complete', {
      hubSessionId: 'c2', turnId: 'turn-c2', signalSource: 'task_complete',
      text: '另一位正常回答', completedAt: Date.now(),
    });
    const result = await pending;
    const failed = result.results.find(item => item.sid === 'c1');
    const completed = result.results.find(item => item.sid === 'c2');
    assert.strictEqual(failed.status, 'errored');
    assert.strictEqual(failed.failure.code, 'quota_exceeded');
    assert.strictEqual(failed.failure.autoRetry, false);
    assert.strictEqual(completed.status, 'completed');
    const revisions = h.ipc
      .map(item => Number(item.payload && item.payload.revision))
      .filter(Number.isFinite);
    assert.ok(revisions.length > 5);
    assert.deepStrictEqual(revisions, [...revisions].sort((a, b) => a - b));
    assert.strictEqual(new Set(revisions).size, revisions.length, 'every push must have a unique revision');
    assert.ok(h.ipc.some(item => item.channel === 'groupchat-attempt-changed'
      && item.payload.failure && item.payload.failure.code === 'quota_exceeded'));
  }
}

run().then(() => console.log('groupchat attempt integration: ok')).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  groupChatWatcher.sendToPty = originalSend;
  groupChatWatcher.extractStreamingText = originalStream;
  groupChatWatcher.cleanBufLen = originalClean;
  groupChatWatcher.checkHostShellTakeover = originalHost;
  groupChatWatcher.resendCurrentPrompt = originalResend;
  groupChatWatcher.inspectPromptSubmissionState = originalInspect;
  pasteTrappedDetector.start = originalPaste.start;
  pasteTrappedDetector.tick = originalPaste.tick;
  pasteTrappedDetector.stop = originalPaste.stop;
});
