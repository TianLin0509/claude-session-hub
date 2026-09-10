'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const groupchat = require('../core/group-chat-orchestrator.js');
const groupChatWatcher = require('../core/group-chat-watcher.js');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher.js');

function make(extractResult) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-recovery-ledger-'));
  const meeting = {
    id: 'm1', groupChat: true, scene: 'general', subSessions: ['s1'],
    participants: [0], slotSpecs: [{ kind: 'codex', memberId: 'm1' }],
  };
  const sessionManager = new EventEmitter();
  sessionManager.getSession = sid => sid === 's1'
    ? { id: 's1', kind: 'codex', transcriptKind: 'codex', title: 'Codex 1', meetingId: 'm1' }
    : null;
  sessionManager.getNativeCodex = () => ({start:async()=>{},readOutcome:async turnId=>
    extractResult.source==='codex-app-server' && extractResult.turnId===turnId
      ? {...extractResult,signalSource:'codex-app-server',status:'completed',hubSessionId:'s1',threadId:'native-thread'} : null});
  const tap = new EventEmitter();
  tap.extractLatestTurn = async () => extractResult;
  tap.clearLastTokens = () => {};
  tap.getLastTokens = () => null;
  tap.getStreamingText = () => [];
  tap.clearStreamingBuf = () => {};
  const ipc = [];
  const dispatcher = createGroupChatDispatcher({
    cliReadyDetector: {}, getHubDataDir: () => root, groupchat,
    isCodexBaseKind: kind => kind === 'codex', kindLabels: { codex: 'Codex' },
    logger: { log() {}, warn() {}, error() {} }, maybeAutoTitleMeetingFromPrompt() {},
    meetingManager: { getMeeting: id => id === 'm1' ? meeting : null, getAllMeetings: () => [meeting] },
    sendToRenderer: (channel, payload) => ipc.push({ channel, payload }),
    sessionManager, transcriptTap: tap,
  });
  return { root, meeting, sessionManager, tap, ipc, dispatcher };
}

async function run() {
  const originalInit = groupChatWatcher.init;
  try {
    {
      const h = make({
        text: 'crash 前已经写完的最终答案', extractMode: 'final_answer',
        source: 'codex-app-server', turnId: 'turn-1', completedAt: Date.now(),
      });
      const orch = groupchat.getOrchestrator(h.root, 'm1');
      const begin = orch.beginTurn('重启前的问题');
      const receipt = orch.recordTurnPrompt(begin.turnNum, 's1', '重启前的问题', {
        runId: begin.runId, memberId: 'm1', kind: 'codex', dispatchAt: Date.now() - 100,
      });
      orch.setSendStatus(begin.turnNum, 's1', 'submitted', {
        attemptId: receipt.attemptId, acknowledgementSource: 'task_started', providerTurnId: 'turn-1',
      });
      groupchat._private.resetCache();
      const summary = await h.dispatcher.recoverPendingAttempts();
      assert.strictEqual(summary.recovered, 1);
      assert.strictEqual(summary.finalizedRuns, 1);
      const state = groupchat.getOrchestrator(h.root, 'm1').getState();
      assert.strictEqual(state.attempts[receipt.attemptId].status, 'completed');
      assert.strictEqual(state.turns[0].by.s1, 'crash 前已经写完的最终答案');
      assert.ok(h.ipc.some(item => item.channel === 'groupchat-turn-complete' && item.payload.recovered === true));
    }

    {
      const h = make({
        text: '另一轮的答案', extractMode: 'final_answer',
        source: 'codex-app-server', turnId: 'turn-old', completedAt: Date.now(),
      });
      const orch = groupchat.getOrchestrator(h.root, 'm1');
      const begin = orch.beginTurn('当前问题');
      const receipt = orch.recordTurnPrompt(begin.turnNum, 's1', '当前问题', {
        runId: begin.runId, memberId: 'm1', kind: 'codex', dispatchAt: Date.now() - 100,
      });
      orch.setSendStatus(begin.turnNum, 's1', 'submitted', {
        attemptId: receipt.attemptId, acknowledgementSource: 'task_started', providerTurnId: 'turn-current',
      });
      groupchat._private.resetCache();
      const summary = await h.dispatcher.recoverPendingAttempts();
      assert.strictEqual(summary.recovered, 0, 'wrong provider turn must never be recovered into current attempt');
      assert.strictEqual(summary.pending, 1);
      const state = groupchat.getOrchestrator(h.root, 'm1').getState();
      assert.notStrictEqual(state.attempts[receipt.attemptId].status, 'completed');
      assert.strictEqual((state.turns || []).length, 0);
    }

    {
      const h=make({text:'看起来像最终答案，但没有原生终态',extractMode:'final_answer',source:'manual-extract',turnId:'same-turn',completedAt:Date.now()});
      const orch=groupchat.getOrchestrator(h.root,'m1'),begin=orch.beginTurn('不可按正文恢复');
      const receipt=orch.recordTurnPrompt(begin.turnNum,'s1','不可按正文恢复',{runId:begin.runId,memberId:'m1',kind:'codex',dispatchAt:Date.now()-100});
      orch.setSendStatus(begin.turnNum,'s1','submitted',{attemptId:receipt.attemptId,providerTurnId:'same-turn'});
      groupchat._private.resetCache();
      const summary=await h.dispatcher.recoverPendingAttempts();
      assert.strictEqual(summary.recovered,0);assert.strictEqual(summary.pending,1);
      assert.notStrictEqual(groupchat.getOrchestrator(h.root,'m1').getState().attempts[receipt.attemptId].status,'completed');
    }
    {
      const h = make({ text: '', extractMode: 'no_task_complete_yet' });
      const orch = groupchat.getOrchestrator(h.root, 'm1');
      const begin = orch.beginTurn('崩在整轮落盘之前');
      const receipt = orch.recordTurnPrompt(begin.turnNum, 's1', '崩在整轮落盘之前', {
        runId: begin.runId, memberId: 'm1', kind: 'codex', dispatchAt: Date.now() - 100,
      });
      orch.patchTurnResult(begin.turnNum, 's1', {
        text: '成员答案已经安全落盘', status: 'completed', memberId: 'm1', speaker: 'Codex 1',
        attemptId: receipt.attemptId, runId: begin.runId,
        providerTurnId: 'turn-terminal', signalSource: 'task_complete', finality: 'provider_final',
      });
      assert.strictEqual(orch.getState().turns.length, 0, '模拟 crash 前尚未来得及 completeTurn');
      groupchat._private.resetCache();
      const summary = await h.dispatcher.recoverPendingAttempts();
      assert.strictEqual(summary.recovered, 0, '成员本身已经是终态，不应重复提取');
      assert.strictEqual(summary.finalizedRuns, 1, '全员终态但缺整轮记录时必须幂等补齐');
      assert.strictEqual(groupchat.getOrchestrator(h.root, 'm1').getState().turns[0].by.s1, '成员答案已经安全落盘');
    }
  } finally {
    groupChatWatcher.init = originalInit;
  }
}

run().then(() => console.log('groupchat recovery ledger: ok')).catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
