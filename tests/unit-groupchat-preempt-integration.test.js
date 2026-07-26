'use strict';
// 抢占式连发集成测试（2026-06-24 道雪）
//
// 真实跑 dispatcher 的抢占逻辑（非查源码字符串）：
//   场景：轮1 两家 AI 都「回答中」（不 emit turn-complete → 卡住）→ 用户在没答完时发轮2
//   断言：
//     1. 轮2 dispatch 立即抢占结算轮1的 in-flight watcher（不被卡死无限期挂起）
//     2. 轮1 收尾：两家标 'superseded'、内容为空（半截丢弃）
//     3. 轮1 的 turn-complete 带 superseded=true（前端据此不清新轮思考态）
//     4. 轮2 不被轮1阻塞，正常完成；其 turn-complete 带 superseded=false
//     5. 轮2 prompt 不引用轮1没答完两家的（空）发言
//
// 依赖用最小 mock：sessionManager / transcriptTap / meetingManager；orchestrator 用真实实现
//   （验证 state 真实变化）；group-chat-watcher 的 PTY 副作用 stub 成 no-op。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const groupChatWatcher = require('../core/group-chat-watcher.js');
const pasteTrappedDetector = require('../core/paste-trapped-detector.js');
const groupchat = require('../core/group-chat-orchestrator.js');
const { createGroupChatDispatcher } = require('../main/groupchat/dispatcher.js');

// --- stub PTY 副作用（不真发终端）---
groupChatWatcher.sendToPty = async () => ({ ok: true, sendStatus: 'ok' });
groupChatWatcher.extractStreamingText = () => ({ text: '', blocks: [], source: 'placeholder' });
groupChatWatcher.cleanBufLen = () => 0;
groupChatWatcher.checkHostShellTakeover = () => false;
groupChatWatcher.resendCurrentPrompt = async () => ({ ok: true });
pasteTrappedDetector.start = () => {};
pasteTrappedDetector.tick = () => 'ok';
pasteTrappedDetector.stop = () => {};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-preempt-'));
  const meetingId = 'mtg-preempt';
  const meeting = {
    id: meetingId, groupChat: true,
    subSessions: ['s1', 's2'],
    slotSpecs: [{ kind: 'gemini' }, { kind: 'gemini' }],
    participants: [0, 1],
  };
  const sessions = {
    s1: { kind: 'gemini', status: 'active', title: 'Gemini-1' },
    s2: { kind: 'gemini', status: 'active', title: 'Gemini-2' },
  };

  const tap = new EventEmitter();
  tap.clearLastTokens = () => {};
  tap.getLastTokens = () => null;
  tap.getStreamingText = () => [];
  tap.clearStreamingBuf = () => {};
  tap.extractLatestTurn = async () => ({ text: '', extractMode: null });
  tap.hasCodexUserMessageSince = async () => false;

  const ipcSent = [];
  const deps = {
    cliReadyDetector: {},
    getHubDataDir: () => tmpDir,
    groupchat,
    isCodexBaseKind: (k) => k === 'codex',
    kindLabels: { gemini: 'Gemini' },
    logger: { log: () => {}, warn: () => {} },
    maybeAutoTitleMeetingFromPrompt: () => {},
    meetingManager: { getMeeting: () => meeting },
    sendToRenderer: (ch, payload) => ipcSent.push({ ch, payload }),
    sessionManager: {
      getSession: (sid) => sessions[sid],
      getSessionBuffer: () => '',
      getGroupChatLastActivity: () => 0,
      getGroupChatReady: () => true,
      setGroupChatReady: () => {},
      clearStreamingBuf: () => {},
    },
    transcriptTap: tap,
  };

  const dispatcher = createGroupChatDispatcher(deps);
  const activeWatchers = dispatcher.getActiveWatchers();

  // === 轮 1：发送，两家都不 emit turn-complete → 模拟「回答中」卡住 ===
  const turn1Promise = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: 'Q1' });
  await sleep(60);
  assert.ok(activeWatchers.get('s1') && !activeWatchers.get('s1').isSettled(), '轮1: s1 watcher 应在等待中（回答中）');
  assert.ok(activeWatchers.get('s2') && !activeWatchers.get('s2').isSettled(), '轮1: s2 watcher 应在等待中（回答中）');

  // === 轮 2：用户在轮1没答完时发送 → 应抢占结算轮1 ===
  const turn2Promise = dispatcher.dispatchGroupChatTurn(meetingId, { userInput: 'Q2' });
  await sleep(60);

  // 轮1 被抢占收尾
  const turn1Result = await turn1Promise;
  assert.strictEqual(turn1Result.status, 'completed', '轮1 应已收尾（被抢占而非无限期挂起）');
  const turn1Complete = ipcSent.find(e => e.ch === 'groupchat-turn-complete' && e.payload.turnNum === turn1Result.turnNum);
  assert.ok(turn1Complete, '应发出轮1 turn-complete');
  assert.strictEqual(turn1Complete.payload.superseded, true, '轮1 turn-complete.superseded 应为 true（被新轮抢占）');

  const orch = groupchat.getOrchestrator(tmpDir, meetingId);
  const t1 = orch.state.turns.find(t => t.n === turn1Result.turnNum);
  assert.strictEqual(t1.byStatus.s1, 'superseded', '轮1 s1 应标 superseded');
  assert.strictEqual(t1.byStatus.s2, 'superseded', '轮1 s2 应标 superseded');
  assert.strictEqual(t1.by.s1, '', '轮1 s1 半截内容应丢弃（空）');
  assert.strictEqual(t1.by.s2, '', '轮1 s2 半截内容应丢弃（空）');
  console.log('  ✓ 轮1卡住 → 发轮2 → 轮1被抢占结算为 superseded（空内容）+ superseded flag=true');

  // === 轮 2：现在让两家正常完成 ===
  await sleep(40);
  // 轮2 发给 s1 的 prompt 不应引用轮1没答完两家的（空）发言（"跳过没答完的队友"）
  const turn2Num = turn1Result.turnNum + 1;
  const ap2 = orch.getActivePrompt(turn2Num);
  assert.ok(ap2 && ap2.promptBy && typeof ap2.promptBy.s1 === 'string', '轮2 应已记录 s1 的 prompt');
  assert.ok(!/##\s*新增发言/.test(ap2.promptBy.s1),
    '轮2 s1 prompt 不含「新增发言」段（轮1 s2 superseded 空内容被过滤，不喂给队友）');
  console.log('  ✓ 轮2 prompt 跳过轮1没答完队友的空发言');
  tap.emit('turn-complete', { hubSessionId: 's1', text: 'A1 answer', signalSource: 'stop_hook', completedAt: 1 });
  tap.emit('turn-complete', { hubSessionId: 's2', text: 'A2 answer', signalSource: 'stop_hook', completedAt: 1 });
  const turn2Result = await turn2Promise;
  assert.strictEqual(turn2Result.status, 'completed', '轮2 应完成（未被卡死的轮1阻塞）');
  const turn2Complete = ipcSent.find(e => e.ch === 'groupchat-turn-complete' && e.payload.turnNum === turn2Result.turnNum);
  assert.strictEqual(turn2Complete.payload.superseded, false, '轮2 turn-complete.superseded 应为 false（已是最新轮）');

  const t2 = orch.state.turns.find(t => t.n === turn2Result.turnNum);
  assert.strictEqual(t2.byStatus.s1, 'completed', '轮2 s1 应 completed');
  assert.strictEqual(t2.by.s1, 'A1 answer', '轮2 s1 内容正确');
  console.log('  ✓ 轮2 不被卡死的轮1阻塞，正常完成 + superseded flag=false');

  // 没有任何 partial-update 把 superseded 推给前端（避免卡片闪「已覆盖」）
  const supersededPartials = ipcSent.filter(e => e.ch === 'groupchat-partial-update' && e.payload.status === 'superseded');
  assert.strictEqual(supersededPartials.length, 0, 'superseded 不应作为 partial-update 推送');
  console.log('  ✓ superseded 不经 partial-update 推送（不闪烁被抢占卡片）');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().then(() => console.log('All passed.')).catch(e => { console.error('FAIL:', e && e.stack || e); process.exit(1); });
